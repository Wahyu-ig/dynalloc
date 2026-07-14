'use strict';

/**
 * CpuController — CPU affinity + niceness + cgroup cpu.weight/cpu.max.
 *
 * Extracted from actuator.js in Phase 1 (ADR-0001). Owns:
 *   - taskset -pc (CPU affinity pinning)
 *   - renice -n (process niceness)
 *   - cgroup cpu.weight, cpu.max (already applied by CgroupManager.applyCgroupLimits)
 *
 * Does NOT own: cgroup setup, controller detection, cgroup path resolution.
 * Those live in CgroupManager so all controllers can share them.
 */

const ResourceController = require('../resource-controller');
const logger = require('../../logger');
const { debug, trace, warn } = logger;

const IOPRIO_CLASSES = Object.freeze({ REALTIME: 1, BEST_EFFORT: 2, IDLE: 3 });

// ── Internal helpers ───────────────────────────────────────────────────

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

class CpuController extends ResourceController {
  constructor(deps) {
    super('cpu', deps);
  }

  /**
   * Pin a process to a specific set of CPU cores via `taskset -pc`.
   * @param {number} pid
   * @param {number[]} cores  — array of logical CPU indices
   * @returns {boolean} true on success
   */
  pinToCores(pid, cores) {
    if (!_validPid(pid)) return false;
    if (!Array.isArray(cores) || cores.length === 0) return false;

    const result = _run('taskset', ['-pc', cores.join(','), String(pid)], this.isDryRun);
    if (result.success && !result.dryRun && this.tracker) {
      this.tracker.log(pid, 'taskset', cores.join(','));
    }
    return result.success;
  }

  /**
   * Set process niceness via `renice -n`.
   * @param {number} pid
   * @param {number} niceValue  — -20 to 19
   * @returns {boolean} true on success
   */
  setNiceness(pid, niceValue) {
    if (!_validPid(pid)) return false;
    if (typeof niceValue !== 'number' || niceValue < -20 || niceValue > 19) return false;

    const result = _run('renice', ['-n', String(niceValue), '-p', String(pid)], this.isDryRun);
    if (result.success && !result.dryRun && this.tracker) {
      this.tracker.log(pid, 'nice', niceValue);
    }
    return result.success;
  }
}

module.exports = CpuController;
