'use strict';

/**
 * IoController — per-process IO priority via `ionice` + (cgroup io.max
 * applied by CgroupManager.applyCgroupLimits).
 *
 * Extracted from actuator.js in Phase 1 (ADR-0001). Owns:
 *   - ionice -c <class> -n <level> -p <pid>
 *
 * The cgroup-level io.max writes are NOT here — they're per-cgroup
 * and live in CgroupManager.applyCgroupLimits(), shared with the
 * CPU and Memory controllers. See ADR-0001 for the boundary rationale.
 */

const ResourceController = require('../resource-controller');
const logger = require('../../logger');
const { debug, trace, warn } = logger;

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

class IoController extends ResourceController {
  constructor(deps) {
    super('io', deps);
  }

  /**
   * Set per-process IO priority via `ionice`.
   *
   * @param {number} pid
   * @param {number} cls   — 1 (realtime), 2 (best-effort), 3 (idle)
   * @param {number} level — 0 to 7 (lower = higher priority, only for cls 1 & 2)
   * @returns {boolean} true on success
   */
  setIoPriority(pid, cls, level) {
    if (!_validPid(pid)) return false;
    if (![1, 2, 3].includes(cls) || typeof level !== 'number' || level < 0 || level > 7) return false;

    const result = _run('ionice', ['-c', String(cls), '-n', String(level), '-p', String(pid)], this.isDryRun);
    if (result.success && !result.dryRun && this.tracker) {
      this.tracker.log(pid, 'ionice', [cls, level]);
    }
    return result.success;
  }
}

module.exports = IoController;
