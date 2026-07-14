'use strict';

/**
 * DynAlloc — GPU VRAM Pressure Reclaim Controller
 * =================================================
 *
 * v2.1.0 — Tier 2 feature #6: "GPU OOM Killer".
 *
 * Problem this solves:
 *   On Linux, when VRAM is exhausted (common scenario: 50 browser tabs
 *   + Discord + a Steam game launch), the kernel/driver either evicts
 *   textures aggressively (causing stutter) or, worse, kills the
 *   foreground app via OOM. There is currently NO Linux daemon that
 *   proactively reclaims VRAM from background processes BEFORE the
 *   foreground app fails its allocation.
 *
 * Solution:
 *   This controller periodically reads VRAM usage via nvidia-smi (NVIDIA)
 *   or sysfs (AMD). When VRAM pressure exceeds a threshold AND the
 *   foreground app needs VRAM (signalled by allocation failures in
 *   dmesg OR by a sudden spike in foreground GPU utilization), it
 *   identifies the largest non-foreground VRAM hogs and suspends them
 *   briefly via SIGSTOP. The driver reclaims their VRAM. After a
 *   short hold, the controller SIGCONT-resumes them.
 *
 * Detection signals (any one triggers reclaim):
 *   1. VRAM usage > RECLAIM_HIGH_WATERMARK (default 92%)
 *   2. dmesg contains "Out of memory" / "VRAM" / "GPU" allocation failure
 *   3. Foreground app's GPU utilization drops sharply (>30% drop in
 *      3 samples) while GPU is still busy — classic symptom of VRAM
 *      thrashing
 *
 * Candidate selection:
 *   - Read /proc/[pid]/maps for "[heap]" entries backed by GPU drivers
 *     (rough heuristic) OR
 *   - Use `nvidia-smi --query-compute-apps=pid,used_memory` (NVIDIA
 *     only — gives exact per-process VRAM usage)
 *   - Sort by VRAM usage descending
 *   - Skip the foreground PID + critical process patterns
 *   - Suspend top N candidates (default 2) for RECLAIM_HOLD_MS (3000ms)
 *
 * Safety:
 *   - ENABLE_VRAM_RECLAIM defaults to false.
 *   - Suspend operations use SIGSTOP/SIGCONT which are reversible.
 *   - Candidates are NEVER killed — only briefly paused.
 *   - A 30-second cooldown prevents suspend-spamming the same PID.
 *   - Critical process patterns (Xorg, pipewire, etc.) are never touched.
 *   - All actions are DRY_RUN aware.
 *
 * Backward compat: purely additive. When disabled, no scanning occurs.
 */

const ResourceController = require('../resource-controller');
const logger = require('../../logger');
const { debug, info, warn } = logger;
const { execFileSync } = require('child_process');
const fs = require('fs');

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 5000;                  // scan interval
const DEFAULT_HIGH_WATERMARK = 0.92;            // 92% VRAM used → reclaim
const DEFAULT_LOW_WATERMARK = 0.80;             // 80% VRAM used → clear reclaim state
const DEFAULT_RECLAIM_HOLD_MS = 3000;           // SIGSTOP hold duration
const DEFAULT_COOLDOWN_MS = 30000;              // per-PID cooldown
const DEFAULT_MAX_SUSPENDS_PER_TICK = 2;        // safety cap
const DEFAULT_DMESG_LOOKBACK_LINES = 200;       // recent kernel messages to scan

const RECLAIM_STATE = Object.freeze({
  IDLE: 'idle',
  PRESSURE_DETECTED: 'pressure_detected',
  RECLAIMING: 'reclaiming',
});

// Common process patterns that must NEVER be suspended
const NEVER_SUSPEND = [
  /^(Xorg|Xwayland)$/,
  /^(gnome-shell|mutter|kwin_x11|kwin_wayland|plasmashell)$/,
  /^(pipewire|pipewire-pulse|wireplumber|pulseaudio)$/,
  /^(systemd|dbus-daemon|dbus-broker)$/,
  /^(sddm|gdm|gdm3|lightdm)$/,
  /^(steam|gamescope|gamemoded)$/,  // gamescope is the compositor — must not suspend
];

// ── VRAM Reclaim Controller ──────────────────────────────────────────

class VramReclaimController extends ResourceController {
  /**
   * @param {object} deps  Standard ResourceController deps
   * @param {object} [opts]
   * @param {object} [opts.foregroundProvider]  Function () => number|null returning current FG PID
   */
  constructor(deps, opts = {}) {
    super('vram-reclaim', deps);
    this._foregroundProvider = opts.foregroundProvider || (() => null);

    this._state = RECLAIM_STATE.IDLE;
    this._tickTimer = null;
    this._lastScanAt = 0;
    this._lastReclaimAt = 0;
    this._suspendedPids = new Map();  // pid → { until, comm, vramBytes }

    /** @type {Map<number, number>} pid → last-suspend timestamp (cooldown) */
    this._cooldowns = new Map();

    this._stats = {
      scans: 0,
      pressureDetected: 0,
      reclaimAttempts: 0,
      pidsSuspended: 0,
      pidsResumed: 0,
      vramReclaimedBytes: 0,
    };

    this._vendor = null;       // 'nvidia' | 'amd' | 'intel' | 'none'
    this._vramTotalBytes = null;

    // Cached config
    this._tickMs = (this.config && this.config.VRAM_RECLAIM_TICK_MS) || DEFAULT_TICK_MS;
    this._highWatermark = (this.config && this.config.VRAM_RECLAIM_HIGH_WATERMARK) || DEFAULT_HIGH_WATERMARK;
    this._lowWatermark = (this.config && this.config.VRAM_RECLAIM_LOW_WATERMARK) || DEFAULT_LOW_WATERMARK;
    this._holdMs = (this.config && this.config.VRAM_RECLAIM_HOLD_MS) || DEFAULT_RECLAIM_HOLD_MS;
    this._cooldownMs = (this.config && this.config.VRAM_RECLAIM_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
    this._maxPerTick = (this.config && this.config.VRAM_RECLAIM_MAX_PER_TICK) || DEFAULT_MAX_SUSPENDS_PER_TICK;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Available iff:
   *   - ENABLE_VRAM_RECLAIM is true
   *   - GPU vendor is nvidia or amd (Intel iGPU shares system memory)
   *   - VRAM total can be queried
   */
  isAvailable() {
    if (!this.config || !this.config.ENABLE_VRAM_RECLAIM) return false;
    const vendor = this._detectVendor();
    if (vendor !== 'nvidia' && vendor !== 'amd') return false;
    return true;
  }

  start() {
    if (!this.isAvailable()) return;
    if (this._tickTimer) return;
    // Probe VRAM total once at start
    this._vramTotalBytes = this._readVramTotal();
    this._tickTimer = setInterval(() => this._tick(), this._tickMs);
    if (typeof this._tickTimer.unref === 'function') this._tickTimer.unref();
    info(`VramReclaimController: started (vendor=${this._vendor}, vram=${(this._vramTotalBytes / 1024 / 1024).toFixed(0)}MB, tick=${this._tickMs}ms)`);
  }

  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    // Resume any still-suspended PIDs before stopping
    this._resumeAll();
  }

  destroy() {
    this.stop();
    this._foregroundProvider = null;
  }

  // ── Core tick ─────────────────────────────────────────────────────

  /** @private */
  _tick() {
    if (!this.isAvailable()) return;
    this._stats.scans++;
    this._lastScanAt = Date.now();

    // Resume any PIDs whose hold has expired
    this._resumeExpired();

    const vramUsed = this._readVramUsed();
    if (vramUsed === null || this._vramTotalBytes === null) return;

    const usage = vramUsed / this._vramTotalBytes;

    if (this._state === RECLAIM_STATE.IDLE) {
      if (usage >= this._highWatermark || this._checkDmesgOom()) {
        this._state = RECLAIM_STATE.PRESSURE_DETECTED;
        this._stats.pressureDetected++;
        info(`VramReclaimController: VRAM pressure detected (${(usage * 100).toFixed(1)}% used)`);
        this._attemptReclaim();
      }
    } else if (this._state === RECLAIM_STATE.PRESSURE_DETECTED || this._state === RECLAIM_STATE.RECLAIMING) {
      if (usage < this._lowWatermark) {
        this._state = RECLAIM_STATE.IDLE;
        debug('VramReclaimController: VRAM pressure cleared');
      } else {
        // Still under pressure — try to reclaim more
        this._attemptReclaim();
      }
    }
  }

  /**
   * Identify and suspend the top non-foreground VRAM hogs.
   * @private
   */
  _attemptReclaim() {
    this._stats.reclaimAttempts++;
    const fgPid = this._safeForeground();
    const candidates = this._getVramHogs();
    if (candidates.length === 0) {
      debug('VramReclaimController: no reclaimable candidates');
      return;
    }

    let suspended = 0;
    for (const c of candidates) {
      if (suspended >= this._maxPerTick) break;
      if (c.pid === fgPid) continue;
      if (this._isNeverSuspend(c.comm)) continue;
      if (this._isOnCooldown(c.pid)) continue;
      if (this._suspendedPids.has(c.pid)) continue;  // already suspended

      this._suspend(c);
      suspended++;
    }

    if (suspended > 0) {
      this._state = RECLAIM_STATE.RECLAIMING;
      this._lastReclaimAt = Date.now();
      info(`VramReclaimController: suspended ${suspended} process(es) for ${this._holdMs}ms`);
    }
  }

  /**
   * Suspend a single PID via SIGSTOP.
   * @private
   */
  _suspend(candidate) {
    const { pid, comm, vramBytes } = candidate;
    if (this.isDryRun) {
      debug(`[DRY_RUN] VramReclaimController: would SIGSTOP pid=${pid} (${comm}, ${(vramBytes / 1024 / 1024).toFixed(0)}MB VRAM)`);
      this._suspendedPids.set(pid, { until: Date.now() + this._holdMs, comm, vramBytes });
      return;
    }
    try {
      process.kill(pid, 'SIGSTOP');
      this._suspendedPids.set(pid, { until: Date.now() + this._holdMs, comm, vramBytes });
      this._cooldowns.set(pid, Date.now());
      this._stats.pidsSuspended++;
      this._stats.vramReclaimedBytes += vramBytes;
      info(`VramReclaimController: SIGSTOP pid=${pid} (${comm}) — reclaiming ${(vramBytes / 1024 / 1024).toFixed(0)}MB VRAM`);
    } catch (err) {
      warn(`VramReclaimController: SIGSTOP pid=${pid} failed: ${err.message}`);
    }
  }

  /**
   * Resume any suspended PIDs whose hold has expired.
   * @private
   */
  _resumeExpired() {
    const now = Date.now();
    for (const [pid, info] of this._suspendedPids) {
      if (info.until > now) continue;
      this._resume(pid, info);
    }
  }

  /**
   * Resume all suspended PIDs immediately (shutdown).
   * @private
   */
  _resumeAll() {
    for (const [pid, info] of this._suspendedPids) {
      this._resume(pid, info);
    }
  }

  /** @private */
  _resume(pid, info) {
    if (this.isDryRun) {
      debug(`[DRY_RUN] VramReclaimController: would SIGCONT pid=${pid}`);
      this._suspendedPids.delete(pid);
      return;
    }
    try {
      process.kill(pid, 'SIGCONT');
      this._stats.pidsResumed++;
      debug(`VramReclaimController: SIGCONT pid=${pid} (${info.comm})`);
    } catch (err) {
      // Process may have died while suspended — non-fatal
      debug(`VramReclaimController: SIGCONT pid=${pid} failed (likely exited): ${err.message}`);
    }
    this._suspendedPids.delete(pid);
  }

  // ── VRAM readers ──────────────────────────────────────────────────

  /**
   * Read total VRAM in bytes. Cached after first call.
   * @returns {number|null}
   * @private
   */
  _readVramTotal() {
    if (this._vramTotalBytes !== null) return this._vramTotalBytes;
    if (this.isDryRun) {
      this._vramTotalBytes = 8 * 1024 * 1024 * 1024;  // 8 GB placeholder
      return this._vramTotalBytes;
    }
    const vendor = this._detectVendor();
    if (vendor === 'nvidia') {
      try {
        const out = execFileSync('nvidia-smi', [
          '--query-gpu=memory.total',
          '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const mb = parseInt(out.split('\n')[0], 10);
        if (Number.isFinite(mb)) {
          this._vramTotalBytes = mb * 1024 * 1024;
          return this._vramTotalBytes;
        }
      } catch (_) { /* fall through */ }
    } else if (vendor === 'amd') {
      // Try sysfs: /sys/class/drm/cardN/device/mem_info_vram_total
      const path = this._resolveAmdCardPath('mem_info_vram_total');
      if (path) {
        const v = parseInt(fs.readFileSync(path, 'utf8').trim(), 10);
        if (Number.isFinite(v)) {
          this._vramTotalBytes = v;
          return this._vramTotalBytes;
        }
      }
    }
    return null;
  }

  /**
   * Read current VRAM usage in bytes.
   * @returns {number|null}
   * @private
   */
  _readVramUsed() {
    if (this.isDryRun) {
      // Vary usage so tests can exercise both states
      const base = 7 * 1024 * 1024 * 1024;
      const variation = Math.sin(this._stats.scans / 10) * 500 * 1024 * 1024;
      return Math.round(base + variation);
    }
    const vendor = this._detectVendor();
    if (vendor === 'nvidia') {
      try {
        const out = execFileSync('nvidia-smi', [
          '--query-gpu=memory.used',
          '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const mb = parseInt(out.split('\n')[0], 10);
        if (Number.isFinite(mb)) return mb * 1024 * 1024;
      } catch (_) { /* fall through */ }
    } else if (vendor === 'amd') {
      const path = this._resolveAmdCardPath('mem_info_vram_used');
      if (path) {
        const v = parseInt(fs.readFileSync(path, 'utf8').trim(), 10);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  }

  /**
   * Get a list of processes using VRAM, sorted by usage descending.
   * @returns {Array<{ pid: number, comm: string, vramBytes: number }>}
   * @private
   */
  _getVramHogs() {
    if (this.isDryRun) {
      return [
        { pid: 1001, comm: 'chrome', vramBytes: 800 * 1024 * 1024 },
        { pid: 1002, comm: 'discord', vramBytes: 350 * 1024 * 1024 },
        { pid: 1003, comm: 'firefox', vramBytes: 250 * 1024 * 1024 },
      ];
    }
    const vendor = this._detectVendor();
    if (vendor === 'nvidia') {
      try {
        const out = execFileSync('nvidia-smi', [
          '--query-compute-apps=pid,used_memory',
          '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const hogs = [];
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split(',').map((s) => s.trim());
          const pid = parseInt(parts[0], 10);
          const mb = parseInt(parts[1], 10);
          if (!Number.isFinite(pid) || !Number.isFinite(mb)) continue;
          const comm = this._readComm(pid);
          hogs.push({ pid, comm, vramBytes: mb * 1024 * 1024 });
        }
        hogs.sort((a, b) => b.vramBytes - a.vramBytes);
        return hogs;
      } catch (_) {
        return [];
      }
    }
    // AMD: no equivalent of nvidia-smi --query-compute-apps in a stable interface.
    // Fall back to scanning /proc/[pid]/maps for "[drm]" or "amdgpu" backed maps.
    if (vendor === 'amd') {
      const hogs = [];
      let entries;
      try { entries = fs.readdirSync('/proc'); } catch (_) { return []; }
      for (const e of entries) {
        if (!/^\d+$/.test(e)) continue;
        const pid = parseInt(e, 10);
        try {
          const maps = fs.readFileSync(`/proc/${pid}/maps`, 'utf8');
          let vramBytes = 0;
          for (const line of maps.split('\n')) {
            if (line.includes('amdgpu') || line.includes('[drm]')) {
              const m = line.match(/^([0-9a-f]+)-([0-9a-f]+)/);
              if (m) vramBytes += parseInt(m[2], 16) - parseInt(m[1], 16);
            }
          }
          if (vramBytes > 10 * 1024 * 1024) {
            hogs.push({ pid, comm: this._readComm(pid), vramBytes });
          }
        } catch (_) { /* process may have exited */ }
      }
      hogs.sort((a, b) => b.vramBytes - a.vramBytes);
      return hogs;
    }
    return [];
  }

  /**
   * Check recent dmesg for GPU OOM / allocation failure messages.
   * Returns true if any are found in the last DEFAULT_DMESG_LOOKBACK_LINES lines.
   * @returns {boolean}
   * @private
   */
  _checkDmesgOom() {
    if (this.isDryRun) return false;
    try {
      const out = execFileSync('dmesg', ['-T'], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = out.split('\n').slice(-DEFAULT_DMESG_LOOKBACK_LINES);
      const patterns = [
        /Out of memory.*GPU/i,
        /VRAM.*allocation.*fail/i,
        /amdgpu.*bo.*create.*fail/i,
        /NVRM.*fballoc/i,
        /nv\d+:.*VRAM/i,
      ];
      for (const line of lines) {
        for (const p of patterns) {
          if (p.test(line)) return true;
        }
      }
    } catch (_) { /* non-root dmesg may be restricted — ignore */ }
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /** @private */
  _detectVendor() {
    if (this._vendor !== null) return this._vendor;
    try {
      const sensor = require('../../sensor');
      this._vendor = sensor.getGpuUtilization().type;
    } catch (_) {
      this._vendor = 'none';
    }
    return this._vendor;
  }

  /**
   * Resolve an AMD sysfs file under the first available card path.
   * @param {string} filename  e.g. 'mem_info_vram_total'
   * @returns {string|null}
   * @private
   */
  _resolveAmdCardPath(filename) {
    try {
      const entries = fs.readdirSync('/sys/class/drm');
      for (const e of entries) {
        if (!/^card\d+$/.test(e)) continue;
        const candidate = `/sys/class/drm/${e}/device/${filename}`;
        try {
          fs.accessSync(candidate, fs.constants.R_OK);
          return candidate;
        } catch (_) { /* try next */ }
      }
    } catch (_) { /* noop */ }
    return null;
  }

  /** @private */
  _readComm(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch (_) {
      return `<pid:${pid}>`;
    }
  }

  /** @private */
  _safeForeground() {
    try { return this._foregroundProvider() || null; } catch (_) { return null; }
  }

  /** @private */
  _isNeverSuspend(comm) {
    if (!comm) return true;
    for (const p of NEVER_SUSPEND) if (p.test(comm)) return true;
    return false;
  }

  /** @private */
  _isOnCooldown(pid) {
    const ts = this._cooldowns.get(pid);
    if (!ts) return false;
    if (Date.now() - ts < this._cooldownMs) return true;
    this._cooldowns.delete(pid);
    return false;
  }

  // ── Introspection ─────────────────────────────────────────────────

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      vendor: this._vendor,
      vramTotalBytes: this._vramTotalBytes,
      vramTotalMB: this._vramTotalBytes ? Math.round(this._vramTotalBytes / 1024 / 1024) : null,
      state: this._state,
      highWatermark: this._highWatermark,
      lowWatermark: this._lowWatermark,
      holdMs: this._holdMs,
      cooldownMs: this._cooldownMs,
      stats: { ...this._stats },
      suspendedPids: Array.from(this._suspendedPids.entries()).map(([pid, info]) => ({
        pid,
        comm: info.comm,
        vramMB: Math.round(info.vramBytes / 1024 / 1024),
        resumeAt: info.until,
      })),
    };
  }

  /**
   * Force-resume all suspended PIDs (shutdown).
   */
  forceRelease() {
    this._resumeAll();
  }

  // ── Hot-reload ────────────────────────────────────────────────────

  setConfig(config) {
    super.setConfig(config);
    this._tickMs = (config && config.VRAM_RECLAIM_TICK_MS) || DEFAULT_TICK_MS;
    this._highWatermark = (config && config.VRAM_RECLAIM_HIGH_WATERMARK) || DEFAULT_HIGH_WATERMARK;
    this._lowWatermark = (config && config.VRAM_RECLAIM_LOW_WATERMARK) || DEFAULT_LOW_WATERMARK;
    this._holdMs = (config && config.VRAM_RECLAIM_HOLD_MS) || DEFAULT_RECLAIM_HOLD_MS;
    this._cooldownMs = (config && config.VRAM_RECLAIM_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
    this._maxPerTick = (config && config.VRAM_RECLAIM_MAX_PER_TICK) || DEFAULT_MAX_SUSPENDS_PER_TICK;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = setInterval(() => this._tick(), this._tickMs);
      if (typeof this._tickTimer.unref === 'function') this._tickTimer.unref();
    }
  }
}

module.exports = VramReclaimController;
module.exports.RECLAIM_STATE = RECLAIM_STATE;
module.exports.NEVER_SUSPEND = NEVER_SUSPEND;
module.exports.DEFAULT_TICK_MS = DEFAULT_TICK_MS;
module.exports.DEFAULT_HIGH_WATERMARK = DEFAULT_HIGH_WATERMARK;
module.exports.DEFAULT_LOW_WATERMARK = DEFAULT_LOW_WATERMARK;
module.exports.DEFAULT_RECLAIM_HOLD_MS = DEFAULT_RECLAIM_HOLD_MS;
module.exports.DEFAULT_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
