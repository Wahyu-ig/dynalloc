'use strict';

/**
 * MemoryController — OOM score adjustment + (future) memory.swap.max / pids.max.
 *
 * Extracted from actuator.js in Phase 1 (ADR-0001). Owns:
 *   - /proc/<pid>/oom_score_adj (per-process OOM score)
 *
 * Does NOT own: cgroup memory.max/memory.high/memory.oom.group writes —
 * those live in CgroupManager.applyCgroupLimits() because they're
 * per-cgroup rather than per-process. Future Phase 3+ may move them
 * here if per-cgroup memory policy becomes controller-specific.
 */

const ResourceController = require('../resource-controller');
const fs = require('fs');
const logger = require('../../logger');
const { debug, trace, warn } = logger;

function _validPid(pid) {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
}

class MemoryController extends ResourceController {
  constructor(deps) {
    super('memory', deps);
  }

  /**
   * Set the OOM score adjustment for a process.
   *
   * /proc/<pid>/oom_score_adj ranges from -1000 (never kill) to +1000
   * (kill first). The daemon typically sets foreground processes to
   * a negative value (e.g. -500) to protect them from OOM killer.
   *
   * @param {number} pid
   * @param {number} value  — -1000 to 1000
   * @returns {boolean} true on success
   */
  setOomScoreAdj(pid, value) {
    if (!_validPid(pid)) return false;
    if (typeof value !== 'number' || value < -1000 || value > 1000) return false;

    const procPath = `/proc/${pid}/oom_score_adj`;
    debug('WRITE:', procPath, '<-', value);
    if (this.isDryRun) {
      trace(`[DRY_RUN] would write "${value}" to ${procPath}`);
      return true;
    }
    try {
      fs.writeFileSync(procPath, String(value));
      if (this.tracker) this.tracker.log(pid, 'oom_score_adj', value);
      return true;
    } catch (err) {
      warn(`Gagal menulis ke ${procPath} (oom_score_adj PID ${pid}): ${err.message}`);
      return false;
    }
  }
}

module.exports = MemoryController;
