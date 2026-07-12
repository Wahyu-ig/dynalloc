'use strict';

/**
 * DynAlloc — CPU Governor Module
 *
 * Manages CPU frequency governor switching.
 * Captures original governors on startup and restores them on shutdown.
 *
 * v2.1: Added PID validation, proper timeout handling, dry-run support.
 */

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const logger = require('./logger');
const { debug, info, warn, trace } = logger;

const SYSFS_CPU = '/sys/devices/system/cpu';

class GovernorManager {
  constructor() {
    this._originalGovernors = new Map();
    this._currentGovernor = null;
  }

  /**
   * Read the current governor for a specific CPU core.
   */
  readGovernor(core) {
    if (typeof core !== 'number' || core < 0) return null;
    try {
      return fs.readFileSync(
        `${SYSFS_CPU}/cpu${core}/cpufreq/scaling_governor`, 'utf8'
      ).trim();
    } catch (_) {
      return null;
    }
  }

  /**
   * Capture the original governor for each core in the list.
   * Only captures once per core (idempotent).
   */
  captureOriginals(cores) {
    if (!Array.isArray(cores)) return;
    for (const core of cores) {
      if (typeof core !== 'number' || core < 0) continue;
      if (this._originalGovernors.has(core)) continue;
      const g = this.readGovernor(core);
      if (g) {
        this._originalGovernors.set(core, g);
        debug(`Governor core ${core}: original = "${g}"`);
      }
    }
  }

  /**
   * Set governor for a list of cores.
   *
   * BUG FIX (v2.1.1): Previously this method only called captureOriginals()
   * when `_originalGovernors.size === 0` — i.e. only the very first
   * setGovernor() call in the daemon's lifetime would capture anything.
   * Once any core was captured (size > 0), subsequent calls that touched
   * NEW cores (e.g. a policy rule doing setGovernor on `cores: 'all'`
   * after the daemon bootstrap had only captured foreground cores) would
   * silently skip capture for those new cores. On shutdown, restoreAll()
   * could not restore them, leaving them permanently stuck at the
   * modified governor.
   *
   * Fix: always call captureOriginals(cores). It is already idempotent
   * per-core (skips cores that already have an entry), so the global
   * guard here was both redundant and harmful.
   */
  setGovernor(cores, governor, config) {
    if (!Array.isArray(cores) || cores.length === 0) return;
    if (typeof governor !== 'string' || governor.length === 0) return;

    this.captureOriginals(cores);

    this._currentGovernor = governor;
    for (const core of cores) {
      const { cmd, args } = this._buildCommand(core, governor, config);
      this._exec(cmd, args, config);
    }
  }

  /**
   * Set governor only on P-Cores (for hybrid CPUs).
   */
  setPcoreGovernor(pCores, governor, config) {
    if (!Array.isArray(pCores) || pCores.length === 0) return;
    this.setGovernor(pCores, governor, config);
  }

  /**
   * Restore all captured governors to their original values.
   */
  restoreAll(config) {
    if (this._originalGovernors.size === 0) return;
    info('Mengembalikan CPU governor ke nilai asli...');
    for (const [core, governor] of this._originalGovernors) {
      const { cmd, args } = this._buildCommand(core, governor, config);
      this._exec(cmd, args, config);
    }
  }

  /**
   * Get the current boost governor (last set).
   */
  getCurrentGovernor() {
    return this._currentGovernor;
  }

  /**
   * Check if cpufreq is available for a core.
   */
  isCpufreqAvailable(core) {
    if (typeof core !== 'number' || core < 0) return false;
    try {
      fs.accessSync(`${SYSFS_CPU}/cpu${core}/cpufreq/scaling_governor`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Get all captured original governors (for state file / rollback).
   */
  getOriginalGovernors() {
    return new Map(this._originalGovernors);
  }

  // ── Internal ──────────────────────────────────────────────────────

  _buildCommand(core, governor, config) {
    if (config.GOVERNOR_USE_SUDO) {
      return { cmd: 'sudo', args: ['-n', 'cpupower', '-c', String(core), 'frequency-set', '-g', governor] };
    }
    return { cmd: 'cpupower', args: ['-c', String(core), 'frequency-set', '-g', governor] };
  }

  _exec(cmd, args, config) {
    debug('EXEC:', cmd, args.join(' '));
    if (config.DRY_RUN) {
      trace(`[DRY_RUN] would run: ${cmd} ${args.join(' ')}`);
      return;
    }
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
    } catch (err) {
      warn(`Gagal eksekusi "${cmd} ${args.join(' ')}": ${err.message}`);
    }
  }
}

module.exports = GovernorManager;