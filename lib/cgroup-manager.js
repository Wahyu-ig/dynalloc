'use strict';

/**
 * CgroupManager — shared cgroup v2 path resolution, capability probing,
 * subtree setup, and limit application.
 *
 * Extracted from actuator.js in Phase 1 (ADR-0001). The Actuator facade
 * and every ResourceController share a single CgroupManager instance so
 * they all agree on cgroup paths and available controllers.
 *
 * Public API (stable):
 *
 *   Construction:
 *     new CgroupManager(config)
 *     .setConfig(config)                  — hot-reload
 *
 *   Capability probes:
 *     .detectCgroupsV2()                  — bool: is cpu controller available?
 *     .detectOptionalControllers()        — { memory: bool, io: bool }
 *     .availableControllers               — cached getter (refreshed by setupCgroups)
 *     .resolveOwnCgroupRelativePath()     — string|null (reads /proc/self/cgroup)
 *
 *   Path resolution (lazy, cached):
 *     .cgroupBasePath                     — getter
 *     .parentCgroupPath                   — getter
 *     .foregroundCgroupPath               — getter
 *     .backgroundCgroupPath               — getter
 *
 *   Subtree lifecycle:
 *     .setupCgroups({enableMemory, enableIo})  — creates dirs, enables controllers, applies initial limits
 *     .applyCgroupLimits({enableMemory, enableIo, ...limits})  — re-writes all limit files
 *     .assignToCgroup(pid, cgroupDir, tracker) — writes pid to cgroup.procs
 *
 *   State:
 *     .cgroupsReady                       — boolean (true after successful setupCgroups)
 *
 * The CgroupManager never throws on sysfs failures — it logs a warning
 * and returns false / no-ops, mirroring the original Actuator behavior.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { debug, info, warn, trace } = logger;

// ── Internal helpers (mirrored from actuator.js — same semantics) ──────

function _validPid(pid) {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
}

function _run(cmd, args, dryRun) {
  debug('EXEC:', cmd, args.join(' '));
  if (dryRun) {
    trace(`[DRY_RUN] would run: ${cmd} ${args.join(' ')}`);
    return { success: true, dryRun: true };
  }
  const { execFileSync } = require('child_process');
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
    return { success: true };
  } catch (err) {
    warn(`Gagal eksekusi "${cmd} ${args.join(' ')}": ${err.message}`);
    return { success: false, error: err.message };
  }
}

function _writeFile(filePath, value, description, dryRun) {
  debug('WRITE:', filePath, '<-', value);
  if (dryRun) {
    trace(`[DRY_RUN] would write "${value}" to ${filePath}`);
    return true;
  }
  try {
    fs.writeFileSync(filePath, String(value));
    return true;
  } catch (err) {
    warn(`Gagal menulis ke ${filePath} (${description}): ${err.message}`);
    return false;
  }
}

// ── CgroupManager class ────────────────────────────────────────────────

class CgroupManager {
  constructor(config) {
    this._config = config;
    this.cgroupsReady = false;
    this._resolvedCgroupBase = null;
    this._cachedControllers = null; // refreshed on every setupCgroups() call
  }

  setConfig(config) {
    this._config = config;
  }

  get config() { return this._config; }

  get isDryRun() {
    return !!this._config.DRY_RUN;
  }

  // ── Own cgroup resolution ──────────────────────────────────────────

  resolveOwnCgroupRelativePath() {
    try {
      const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
      for (const line of raw.trim().split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 3 && parts[0] === '0' && parts[1] === '') return parts[2];
      }
    } catch (_) { /* not readable */ }
    return null;
  }

  get cgroupBasePath() {
    if (this._resolvedCgroupBase) return this._resolvedCgroupBase;

    if (this._config.CGROUP_MODE === 'root') {
      this._resolvedCgroupBase = this._config.CGROUP_ROOT;
    } else {
      const ownRelative = this.resolveOwnCgroupRelativePath();
      if (ownRelative) {
        this._resolvedCgroupBase = path.join(this._config.CGROUP_ROOT, ownRelative);
        info(`Cgroup delegasi terdeteksi (own cgroup): ${this._resolvedCgroupBase}`);
      } else if (this._config.CGROUP_MODE === 'own') {
        this._resolvedCgroupBase = null;
      } else {
        this._resolvedCgroupBase = this._config.CGROUP_ROOT;
      }
    }
    return this._resolvedCgroupBase;
  }

  // ── Capability probes ──────────────────────────────────────────────

  detectCgroupsV2() {
    const base = this.cgroupBasePath;
    if (!base) return false;
    try {
      const controllers = fs.readFileSync(path.join(base, 'cgroup.controllers'), 'utf8');
      // cpu is required; memory and io are optional but recommended.
      // We report readiness based on cpu only — memory/io are best-effort.
      return controllers.includes('cpu');
    } catch (_) {
      return false;
    }
  }

  /**
   * Detect which optional cgroup v2 controllers are available
   * for resource limits beyond cpu.weight/cpu.max.
   *
   * Returns { memory: bool, io: bool }.
   */
  detectOptionalControllers() {
    const base = this.cgroupBasePath;
    if (!base) return { memory: false, io: false };
    try {
      const controllers = fs.readFileSync(path.join(base, 'cgroup.controllers'), 'utf8');
      return {
        memory: controllers.includes('memory'),
        io: controllers.includes('io'),
      };
    } catch (_) {
      return { memory: false, io: false };
    }
  }

  /**
   * Cached result of detectOptionalControllers().
   * Refreshed on every setupCgroups() call.
   */
  get availableControllers() {
    if (!this._cachedControllers) {
      this._cachedControllers = this.detectOptionalControllers();
    }
    return this._cachedControllers;
  }

  // ── Path getters (computed from base + parent slice) ───────────────

  get foregroundCgroupPath() {
    return path.join(this.cgroupBasePath, this._config.CGROUP_PARENT_SLICE, 'foreground.slice');
  }

  get backgroundCgroupPath() {
    return path.join(this.cgroupBasePath, this._config.CGROUP_PARENT_SLICE, 'background.slice');
  }

  get parentCgroupPath() {
    return path.join(this.cgroupBasePath, this._config.CGROUP_PARENT_SLICE);
  }

  // ── Subtree lifecycle ──────────────────────────────────────────────

  /**
   * Create the cgroup subtree (parent + foreground + background slices),
   * enable controllers, and apply initial limits.
   *
   * @param {object} opts
   * @param {boolean} opts.enableMemory  — write +memory to subtree_control iff available
   * @param {boolean} opts.enableIo      — write +io to subtree_control iff available
   * @returns {boolean} true on success (or in dry-run), false on cgroups unavailable
   */
  setupCgroups(opts) {
    opts = opts || {};
    const enableMemory = opts.enableMemory !== false;
    const enableIo = opts.enableIo !== false;

    if (!this._config.ENABLE_CGROUPS_V2) {
      info('Cgroups v2 dimatikan lewat config, memakai taskset+renice.');
      return false;
    }
    if (!this.detectCgroupsV2()) {
      warn(`Cgroups v2 (controller "cpu") tidak terdeteksi/tidak bisa diakses di "${this.cgroupBasePath}", fallback ke taskset+renice.`);
      return false;
    }

    // Refresh the cached optional-controllers map.
    this._cachedControllers = this.detectOptionalControllers();
    const ctrls = this._cachedControllers;
    if (ctrls.memory) info('Cgroup controller "memory" tersedia — memory.max limits aktif.');
    if (ctrls.io)      info('Cgroup controller "io" tersedia — io.max limits aktif.');
    if (!ctrls.memory && !ctrls.io) {
      info('Cgroup controllers memory/io tidak tersedia — hanya cpu.weight/cpu.max yang akan dipakai.');
    }

    if (this.isDryRun) {
      trace(`[DRY_RUN] would set up ${this._config.CGROUP_PARENT_SLICE}/{foreground,background}.slice under ${this.cgroupBasePath}`);
      this.cgroupsReady = true;
      return true;
    }
    try {
      fs.mkdirSync(this.foregroundCgroupPath, { recursive: true });
      fs.mkdirSync(this.backgroundCgroupPath, { recursive: true });

      // Enable controllers. cpu is always required; memory and io are
      // enabled only if available AND the user has them enabled in config.
      // We write them at both the base cgroup and the parent slice so the
      // foreground/background sub-cgroups inherit them.
      const enableList = ['+cpu'];
      if (ctrls.memory && enableMemory && this._config.ENABLE_MEMORY_LIMITS) enableList.push('+memory');
      if (ctrls.io && enableIo && this._config.ENABLE_IO_LIMITS)             enableList.push('+io');
      const enableStr = enableList.join(' ');

      _writeFile(
        path.join(this.cgroupBasePath, 'cgroup.subtree_control'),
        enableStr, `enable controllers (base): ${enableStr}`, this.isDryRun
      );
      _writeFile(
        path.join(this.parentCgroupPath, 'cgroup.subtree_control'),
        enableStr, `enable controllers (parent): ${enableStr}`, this.isDryRun
      );
      this.cgroupsReady = true;
      this.applyCgroupLimits({ enableMemory, enableIo });
      info(`Cgroups v2 siap: ${this.foregroundCgroupPath} & ${this.backgroundCgroupPath}`);
      return true;
    } catch (err) {
      warn(`Gagal setup cgroups v2 (${err.message}), fallback ke taskset+renice.`);
      this.cgroupsReady = false;
      return false;
    }
  }

  /**
   * Apply resource limits to the foreground and background cgroups.
   *
   * Writes:
   *   - cpu.weight, cpu.max                       (always, when cgroups ready)
   *   - memory.max, memory.high, memory.oom.group (when memory controller available + enabled)
   *   - io.max                                    (when io controller available + enabled)
   *
   * @param {object} opts
   * @param {boolean} opts.enableMemory
   * @param {boolean} opts.enableIo
   */
  applyCgroupLimits(opts) {
    if (!this.cgroupsReady && !this.isDryRun) return;
    opts = opts || {};
    const enableMemory = opts.enableMemory !== false;
    const enableIo = opts.enableIo !== false;

    // ── CPU limits ───────────────────────────────────────────────────
    _writeFile(path.join(this.foregroundCgroupPath, 'cpu.weight'),
      this._config.FOREGROUND_CPU_WEIGHT, 'foreground cpu.weight', this.isDryRun);
    _writeFile(path.join(this.foregroundCgroupPath, 'cpu.max'),
      this._config.FOREGROUND_CPU_MAX, 'foreground cpu.max', this.isDryRun);
    _writeFile(path.join(this.backgroundCgroupPath, 'cpu.weight'),
      this._config.BACKGROUND_CPU_WEIGHT, 'background cpu.weight', this.isDryRun);
    _writeFile(path.join(this.backgroundCgroupPath, 'cpu.max'),
      this._config.BACKGROUND_CPU_MAX, 'background cpu.max', this.isDryRun);

    // ── Memory limits ────────────────────────────────────────────────
    const ctrls = this.availableControllers;
    if (ctrls.memory && enableMemory && this._config.ENABLE_MEMORY_LIMITS) {
      _writeFile(path.join(this.foregroundCgroupPath, 'memory.max'),
        this._config.FOREGROUND_MEMORY_MAX, 'foreground memory.max', this.isDryRun);
      _writeFile(path.join(this.backgroundCgroupPath, 'memory.max'),
        this._config.BACKGROUND_MEMORY_MAX, 'background memory.max', this.isDryRun);

      if (this._config.BACKGROUND_MEMORY_HIGH && this._config.BACKGROUND_MEMORY_HIGH !== 'max') {
        _writeFile(path.join(this.backgroundCgroupPath, 'memory.high'),
          this._config.BACKGROUND_MEMORY_HIGH, 'background memory.high', this.isDryRun);
      }

      _writeFile(path.join(this.foregroundCgroupPath, 'memory.oom.group'),
        '0', 'foreground memory.oom.group=0 (isolate)', this.isDryRun);
      _writeFile(path.join(this.backgroundCgroupPath, 'memory.oom.group'),
        this._config.BACKGROUND_OOM_GROUP ? '1' : '0',
        `background memory.oom.group=${this._config.BACKGROUND_OOM_GROUP ? 1 : 0}`,
        this.isDryRun);
    }

    // ── IO limits ────────────────────────────────────────────────────
    if (ctrls.io && enableIo && this._config.ENABLE_IO_LIMITS) {
      if (this._config.BACKGROUND_IO_MAX) {
        _writeFile(path.join(this.backgroundCgroupPath, 'io.max'),
          this._config.BACKGROUND_IO_MAX, 'background io.max', this.isDryRun);
      }
      // Foreground gets no io.max (unlimited) — full disk speed.
    }
  }

  /**
   * Assign a PID to a cgroup by writing to its cgroup.procs file.
   *
   * @param {number} pid
   * @param {string} cgroupDir  — absolute path to the cgroup directory
   * @param {object} tracker    — shared ModificationTracker (calls tracker.log on success)
   * @returns {boolean} true on success
   */
  assignToCgroup(pid, cgroupDir, tracker) {
    if (!_validPid(pid)) return false;
    const result = _writeFile(
      path.join(cgroupDir, 'cgroup.procs'), pid,
      `assign PID ${pid} ke ${cgroupDir}`, this.isDryRun
    );
    if (result && !this.isDryRun && tracker) {
      tracker.log(pid, 'cgroup', cgroupDir);
    }
    return result;
  }
}

module.exports = CgroupManager;
