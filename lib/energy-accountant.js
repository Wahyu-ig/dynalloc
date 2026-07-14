'use strict';

/**
 * DynAlloc — Per-App Energy Accountant (RAPL)
 * =============================================
 *
 * v2.1.0 — Tier 1 killer feature #2: "Joules-per-App".
 *
 * Reads Intel/AMD RAPL (Running Average Power Limit) energy counters
 * from /sys/class/powercap/intel-rapl/ (Intel) or
 * /sys/class/hwmon/hwmonN/power (AMD) and attributes joules to
 * individual PIDs / cgroups based on CPU time share.
 *
 * No other Linux resource daemon does per-app energy attribution
 * today. Windows + macOS both ship it in their battery UI. Linux
 * users currently have to dig through `powerstat` / `turbostat`
 * output, which gives only system-wide numbers.
 *
 * Architecture:
 *
 *   ┌────────────────────┐    tick N      ┌──────────────────┐
 *   │ /sys/class/powercap│ ──────────────▶│ EnergyAccountant │
 *   │   /intel-rapl:0/   │   energy_uj    │   .sample()      │
 *   │   energy_uj        │                │                  │
 *   └────────────────────┘                │   Δjoules =      │
 *                                         │     (e_now -     │
 *   ┌────────────────────┐                │      e_prev) /   │
 *   │   /proc/[pid]/stat │ ──────────────▶│     1e6          │
 *   │   (utime + stime)  │  per-pid cpu   │                  │
 *   └────────────────────┘    time ticks  │   per-pid share  │
 *                                         │   = cpu_time_pid │
 *                                         │     / cpu_total  │
 *                                         └────────┬─────────┘
 *                                                  │
 *                                                  ▼
 *                                         ┌──────────────────┐
 *                                         │  Per-app ledger: │
 *                                         │  Map<comm, joules>│
 *                                         └──────────────────┘
 *
 * Counters tracked:
 *   - package  (whole CPU socket, including iGPU on Intel)
 *   - core     (cores only — subdomain of package)
 *   - uncore   (LLC + memory controller on Intel)
 *   - dram     (DRAM, separate domain)
 *   - psys     (platform/SoC — only on newer Intel)
 *
 * For AMD: hwmonN/power is instantaneous watts (μW); we integrate
 * over time. Accuracy depends on the polling interval.
 *
 * Overflow handling: RAPL energy_uj is a 32-bit microjoule counter
 * that wraps roughly every ~60s at 100W draw. We detect wraps
 * (e_now < e_prev) and add 2^32 μJ to the delta.
 *
 * Memory bounds:
 *   - Per-app ledger: Map<comm, number>, evicted LRU at MAX_APPS (256).
 *   - Per-PID delta cache: refreshed every sample, not stored.
 *   - History: ring buffer of ENERGY_HISTORY_SIZE samples (~1KB).
 *
 * Backward compat: ENABLE_ENERGY_ACCOUNTING defaults to false.
 * When disabled, no samples are read and the daemon is unchanged.
 *
 * Permissions: reading intel-rapl energy_uj requires root OR
 * CAP_SYS_RAWIO on some kernels. We probe availability at startup
 * and gracefully degrade to "unavailable" if any file is unreadable.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger');
const { debug, info, warn } = logger;

// ── Constants ─────────────────────────────────────────────────────────

const RAPL_BASE = '/sys/class/powercap';

const ENERGY_HISTORY_SIZE = 360;            // ~6 minutes at 1Hz
const MAX_APPS = 256;                       // LRU cap for per-app ledger
const MAX_JIFFY_DELTA = 100000;             // sanity cap to detect /proc parsing bugs
const MICROJOULES_PER_JOULE = 1e6;
const RAPL_OVERFLOW = Math.pow(2, 32);       // 32-bit energy_uj counter
const AMD_HWMON_BASE = '/sys/class/hwmon';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Read a sysfs file as a trimmed string. Returns null on error.
 * @param {string} fp
 * @returns {string|null}
 */
function readSysfs(fp) {
  try {
    return fs.readFileSync(fp, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

/**
 * Read a sysfs file as a number. Returns null on error.
 * @param {string} fp
 * @returns {number|null}
 */
function readSysfsNumber(fp) {
  const v = readSysfs(fp);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── EnergyAccountant ──────────────────────────────────────────────────

class EnergyAccountant {
  /**
   * @param {object} opts
   * @param {object} opts.config
   */
  constructor(opts = {}) {
    this._config = opts.config || {};

    /** @type {Map<string, number>} comm → total joules attributed (cumulative). */
    this._appJoules = new Map();

    /** @type {Map<string, number>} comm → total cpu-time share (for sanity / "watts" calc). */
    this._appCpuTime = new Map();

    /**
     * Ring buffer of system-wide samples for history.
     * @type {Array<{ ts: number, package: number|null, core: number|null, uncore: number|null, dram: number|null, psys: number|null, totalWatts: number }>}
     */
    this._history = [];

    /** Previous counter snapshot for delta computation. */
    this._prevCounters = null;
    this._prevSampleTs = null;

    /** Detected vendor/domain availability. */
    this._available = false;
    this._domains = [];           // ['package', 'core', 'uncore', 'dram', 'psys'] for Intel
    this._vendor = 'none';        // 'intel' | 'amd' | 'none'
    this._amdHwmonPath = null;    // path to AMD hwmon power file (μW instantaneous)

    /** Cumulative totals (joules). */
    this._totals = {
      package: 0,
      core: 0,
      uncore: 0,
      dram: 0,
      psys: 0,
    };

    /** Sample count. */
    this._samples = 0;

    this._dryRun = !!(this._config && this._config.DRY_RUN);

    // Probe RAPL availability (deferred to setup() so constructor is cheap)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Probe RAPL / hwmon availability. Returns true if at least one
   * energy domain can be read.
   */
  setup() {
    if (this._dryRun) {
      // In DRY_RUN we pretend RAPL is available so callers exercise the code path
      this._available = true;
      this._vendor = 'intel';
      this._domains = ['package', 'core', 'uncore', 'dram'];
      debug('EnergyAccountant: DRY_RUN mode — RAPL simulated');
      return true;
    }
    this._probeIntel();
    if (!this._available) this._probeAmd();
    if (this._available) {
      info(`EnergyAccountant: ${this._vendor} RAPL available (domains: ${this._domains.join(', ')})`);
    } else {
      debug('EnergyAccountant: no RAPL/hwmon path readable — energy accounting disabled');
    }
    return this._available;
  }

  /** @private */
  _probeIntel() {
    // Walk /sys/class/powercap/intel-rapl:N/ for "package" + subdomains
    let entries;
    try {
      entries = fs.readdirSync(RAPL_BASE);
    } catch (_) {
      return;
    }
    const packagePaths = [];
    for (const e of entries) {
      if (!/^intel-rapl:\d+$/.test(e)) continue;
      const name = readSysfs(path.join(RAPL_BASE, e, 'name'));
      if (name && name.startsWith('package')) {
        packagePaths.push(path.join(RAPL_BASE, e));
      }
    }
    if (packagePaths.length === 0) return;

    // Read package energy_uj as a sanity probe
    const pkgEj = readSysfsNumber(path.join(packagePaths[0], 'energy_uj'));
    if (pkgEj === null) return;

    this._vendor = 'intel';
    this._available = true;
    this._packagePath = packagePaths[0];

    // Discover subdomains (core, uncore, dram, psys)
    const subdomains = [];
    for (const e of entries) {
      if (!/^intel-rapl:\d+:\d+$/.test(e)) continue;
      const name = readSysfs(path.join(RAPL_BASE, e, 'name'));
      if (!name) continue;
      const energyPath = path.join(RAPL_BASE, e, 'energy_uj');
      if (readSysfsNumber(energyPath) !== null) {
        subdomains.push({ name, path: energyPath });
      }
    }
    this._domains = ['package'];
    this._subdomainPaths = {};
    for (const s of subdomains) {
      this._domains.push(s.name);
      this._subdomainPaths[s.name] = s.path;
    }
  }

  /** @private */
  _probeAmd() {
    let entries;
    try {
      entries = fs.readdirSync(AMD_HWMON_BASE);
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const name = readSysfs(path.join(AMD_HWMON_BASE, e, 'name'));
      if (name !== 'k10temp' && name !== 'zenpower' && name !== 'amdgpu') continue;
      const powerPath = path.join(AMD_HWMON_BASE, e, 'power1_input') ||
                        path.join(AMD_HWMON_BASE, e, 'power2_input');
      const power = readSysfsNumber(powerPath);
      if (power === null) continue;
      // AMD hwmon power is in μW (instantaneous)
      this._vendor = 'amd';
      this._available = true;
      this._amdHwmonPath = powerPath;
      this._domains = ['package'];
      return;
    }
  }

  isAvailable() {
    return this._available;
  }

  // ── Sampling ──────────────────────────────────────────────────────

  /**
   * Take a single energy sample. Reads RAPL counters and (if a
   * process-list snapshot is provided) attributes the delta to apps.
   *
   * @param {object} [ctx]
   * @param {Array<{ pid: number, comm: string, utime: number, stime: number }>} [ctx.processes]
   *        Snapshot of running processes with their CPU time (in clock ticks).
   * @param {number} [ctx.totalCpuTicks]  Total CPU ticks across all cores.
   */
  sample(ctx = {}) {
    if (!this._available) return null;

    const now = Date.now();
    const counters = this._readCounters();
    if (!counters) return null;

    let deltaJoules = null;
    let totalWatts = null;

    if (this._prevCounters && this._prevSampleTs) {
      const dtSec = (now - this._prevSampleTs) / 1000;
      if (dtSec > 0.001 && dtSec < 300) {
        const pkgDelta = this._deltaUj(this._prevCounters.package, counters.package);
        if (pkgDelta !== null) {
          deltaJoules = pkgDelta / MICROJOULES_PER_JOULE;
          totalWatts = deltaJoules / dtSec;
          this._totals.package += deltaJoules;
        }
        // Aggregate subdomain totals (informational, not used for attribution)
        for (const d of this._domains) {
          if (d === 'package') continue;
          const prev = this._prevCounters[d];
          const cur = counters[d];
          if (prev != null && cur != null) {
            const sub = this._deltaUj(prev, cur);
            if (sub !== null) this._totals[d] += sub / MICROJOULES_PER_JOULE;
          }
        }
      }
    }

    // Attribute joules to apps based on CPU time share
    if (deltaJoules !== null && ctx.processes && ctx.totalCpuTicks && ctx.totalCpuTicks > 0) {
      for (const p of ctx.processes) {
        if (!p.comm) continue;
        const cpuTime = (p.utime || 0) + (p.stime || 0);
        if (cpuTime === 0) continue;
        const share = cpuTime / ctx.totalCpuTicks;
        if (share <= 0 || share > 1) continue;
        const attribution = deltaJoules * share;
        this._appJoules.set(p.comm, (this._appJoules.get(p.comm) || 0) + attribution);
        this._appCpuTime.set(p.comm, (this._appCpuTime.get(p.comm) || 0) + cpuTime);
        // LRU eviction
        if (this._appJoules.size > MAX_APPS) {
          const first = this._appJoules.keys().next().value;
          this._appJoules.delete(first);
          this._appCpuTime.delete(first);
        }
      }
    }

    this._prevCounters = counters;
    this._prevSampleTs = now;
    this._samples++;

    // Push to history ring buffer
    this._history.push({
      ts: now,
      package: counters.package,
      core: counters.core || null,
      uncore: counters.uncore || null,
      dram: counters.dram || null,
      psys: counters.psys || null,
      totalWatts: totalWatts !== null ? Math.round(totalWatts * 1000) / 1000 : null,
      deltaJoules: deltaJoules !== null ? Math.round(deltaJoules * 1000) / 1000 : null,
    });
    while (this._history.length > ENERGY_HISTORY_SIZE) this._history.shift();

    return {
      ts: now,
      deltaJoules,
      totalWatts,
      counters,
    };
  }

  /**
   * Compute the delta between two 32-bit μJ counters, accounting for overflow.
   * @param {number|null} prev
   * @param {number|null} cur
   * @returns {number|null} delta in μJ
   * @private
   */
  _deltaUj(prev, cur) {
    if (prev == null || cur == null) return null;
    let delta = cur - prev;
    if (delta < 0) delta += RAPL_OVERFLOW;
    if (delta > RAPL_OVERFLOW / 2) return null;  // sanity: probably a misread
    return delta;
  }

  /**
   * Read all available RAPL counters.
   * @returns {object|null}
   * @private
   */
  _readCounters() {
    if (this._dryRun) {
      // Deterministic synthetic data for testing
      const base = 1_000_000 + this._samples * 50_000; // 50J per tick at 1s
      return {
        package: base,
        core: Math.round(base * 0.7),
        uncore: Math.round(base * 0.1),
        dram: Math.round(base * 0.2),
        psys: null,
      };
    }
    if (this._vendor === 'intel') {
      const result = { package: null, core: null, uncore: null, dram: null, psys: null };
      result.package = readSysfsNumber(path.join(this._packagePath, 'energy_uj'));
      for (const d of this._domains) {
        if (d === 'package' || !this._subdomainPaths[d]) continue;
        result[d] = readSysfsNumber(this._subdomainPaths[d]);
      }
      return result.package !== null ? result : null;
    }
    if (this._vendor === 'amd') {
      // AMD hwmon "power" is in μW (instantaneous). Convert to a fake
      // cumulative counter by multiplying by sample interval. Since
      // sample() is called by the daemon tick at known interval, we
      // approximate ΔE = P × Δt. We pretend the "counter" is monotonic
      // by adding the new ΔE each call.
      const wattsMicro = readSysfsNumber(this._amdHwmonPath);
      if (wattsMicro === null) return null;
      const dtSec = this._prevSampleTs ? (Date.now() - this._prevSampleTs) / 1000 : 0;
      const deltaUj = wattsMicro * dtSec;
      const cumulative = (this._prevCounters?.package || 0) + deltaUj;
      return { package: cumulative, core: null, uncore: null, dram: null, psys: null };
    }
    return null;
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * Get per-app energy totals, sorted by joules descending.
   * @param {number} [limit=20]
   * @returns {Array<{ comm: string, joules: number, wattHours: number, share: number, cpuTime: number }>}
   */
  getTopApps(limit = 20) {
    const total = this._totals.package || 0;
    const entries = [];
    for (const [comm, joules] of this._appJoules) {
      const cpuTime = this._appCpuTime.get(comm) || 0;
      entries.push({
        comm,
        joules: Math.round(joules * 1000) / 1000,
        wattHours: Math.round((joules / 3600) * 1000) / 1000,
        share: total > 0 ? Math.round((joules / total) * 10000) / 10000 : 0,
        cpuTime,
      });
    }
    entries.sort((a, b) => b.joules - a.joules);
    return entries.slice(0, limit);
  }

  /**
   * Get the most recent N samples of system-wide watts.
   * @param {number} [limit=60]
   * @returns {Array<{ ts: number, watts: number|null, joules: number|null }>}
   */
  getRecentWatts(limit = 60) {
    const start = Math.max(0, this._history.length - limit);
    return this._history.slice(start).map((h) => ({
      ts: h.ts,
      watts: h.totalWatts,
      joules: h.deltaJoules,
    }));
  }

  /**
   * Get cumulative totals across all samples.
   * @returns {object}
   */
  getTotals() {
    return {
      package: Math.round(this._totals.package * 1000) / 1000,
      core: Math.round(this._totals.core * 1000) / 1000,
      uncore: Math.round(this._totals.uncore * 1000) / 1000,
      dram: Math.round(this._totals.dram * 1000) / 1000,
      psys: Math.round(this._totals.psys * 1000) / 1000,
      wattHours: {
        package: Math.round((this._totals.package / 3600) * 1000) / 1000,
        dram: Math.round((this._totals.dram / 3600) * 1000) / 1000,
      },
    };
  }

  /**
   * Get the average system-wide power draw over the last N samples.
   * @param {number} [samples=60]
   * @returns {number|null} watts, or null if no data
   */
  getAverageWatts(samples = 60) {
    const recent = this._history.slice(-samples).filter((h) => h.totalWatts !== null);
    if (recent.length === 0) return null;
    const sum = recent.reduce((a, b) => a + b.totalWatts, 0);
    return Math.round((sum / recent.length) * 1000) / 1000;
  }

  /**
   * Get the current instantaneous watts (most recent sample).
   * @returns {number|null}
   */
  getCurrentWatts() {
    if (this._history.length === 0) return null;
    return this._history[this._history.length - 1].totalWatts;
  }

  getStatus() {
    return {
      enabled: true,
      available: this._available,
      vendor: this._vendor,
      domains: this._domains,
      samples: this._samples,
      appsTracked: this._appJoules.size,
      historySize: this._history.length,
      currentWatts: this.getCurrentWatts(),
      averageWatts: this.getAverageWatts(60),
      totals: this.getTotals(),
    };
  }

  /**
   * Reset all accumulators (preserves vendor/domain discovery).
   */
  reset() {
    this._appJoules.clear();
    this._appCpuTime.clear();
    this._history.length = 0;
    this._prevCounters = null;
    this._prevSampleTs = null;
    this._totals = { package: 0, core: 0, uncore: 0, dram: 0, psys: 0 };
    this._samples = 0;
  }

  // ── Hot-reload ────────────────────────────────────────────────────

  setConfig(config) {
    this._config = config || {};
    this._dryRun = !!(this._config && this._config.DRY_RUN);
  }
}

module.exports = {
  EnergyAccountant,
  ENERGY_HISTORY_SIZE,
  MAX_APPS,
  MICROJOULES_PER_JOULE,
  RAPL_OVERFLOW,
};
