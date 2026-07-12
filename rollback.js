'use strict';

/**
 * DynAlloc — Safe Rollback Module
 *
 * Persists daemon state to disk. On startup, checks for a
 * stale state file and restores all modified processes to
 * their original state.
 *
 * v2.1: State file persistence, crash recovery, no system left in modified state.
 * v2.1.5: PID reuse protection via start-time validation.
 *          When a PID is restored from a crashed daemon's state file,
 *          we verify the current process at that PID is the SAME process
 *          the daemon originally modified (by comparing /proc/<pid>/stat
 *          start-time). If the start-time differs, the PID was recycled
 *          to a different process and we MUST NOT touch it.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('./logger');
const { info, warn, error, debug } = logger;

const DEFAULT_STATE_PATH = '/tmp/dynalloc-state.json';

// We import sensor lazily to avoid a circular dependency
// (sensor.js -> rollback.js is not direct, but keeping it lazy is safer).
let _getPidStartTime = null;
function _resolveGetPidStartTime() {
  if (_getPidStartTime === null) {
    try {
      _getPidStartTime = require('./sensor').getPidStartTime;
    } catch (_) {
      _getPidStartTime = false; // mark as unavailable
    }
  }
  return _getPidStartTime || null;
}

class RollbackManager {
  constructor(stateFilePath) {
    this._stateFilePath = stateFilePath || DEFAULT_STATE_PATH;
    this._state = {
      modifiedPids: {},    // { pid: { nice, ionice, affinity, cgroup, oom_score_adj } }
      governorOriginals: {}, // { core: governor }
      cgroupBase: null,     // BUG FIX (v2.1.2): save the cgroup base path
                            // so crash recovery writes to the right cgroup
                            // instead of always /sys/fs/cgroup.
      timestamp: null,
      pid: process.pid,
    };
    this._loaded = false;
  }

  /**
   * Track a process modification.
   *
   * v2.1.5: On the FIRST track for a given PID (when the entry is created),
   * we capture the process start-time from /proc/<pid>/stat. This is used
   * during crash recovery to detect PID reuse — if the saved start-time
   * doesn't match the current process at that PID, the PID was recycled
   * to a different process and we MUST NOT restore state to it.
   */
  trackProcess(pid, property, value) {
    if (typeof pid !== 'number' || pid <= 0) return;
    if (!this._state.modifiedPids[pid]) {
      this._state.modifiedPids[pid] = {};
      // Capture start-time once per PID. We do this on first-track so
      // the value reflects the process the daemon is ABOUT to modify.
      // If the process exits and the PID is reused, the start-time
      // will differ on recovery → we skip restoration.
      const getStart = _resolveGetPidStartTime();
      if (getStart) {
        const st = getStart(pid);
        if (st !== null) {
          this._state.modifiedPids[pid].startTime = st;
        }
        // If st is null (e.g. /proc not available in a test/sandbox),
        // we leave startTime unset. recoverFromCrash handles missing
        // startTime gracefully by falling back to old behavior (restore
        // without identity check) — better than blocking recovery entirely.
      }
    }
    this._state.modifiedPids[pid][property] = value;
  }

  /**
   * Track governor modification.
   */
  trackGovernor(core, originalGovernor) {
    if (typeof core !== 'number') return;
    this._state.governorOriginals[core] = originalGovernor;
  }

  /**
   * Set the cgroup base path (called by daemon when actuator resolves it).
   * Persisted so crash recovery knows where to move PIDs back to.
   */
  setCgroupBase(basePath) {
    this._state.cgroupBase = typeof basePath === 'string' ? basePath : null;
  }

  /**
   * Persist current state to disk.
   */
  persist() {
    try {
      this._state.timestamp = new Date().toISOString();
      const tmpPath = this._stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._state, null, 2));
      fs.renameSync(tmpPath, this._stateFilePath);
      debug('State file disimpan:', this._stateFilePath);
    } catch (err) {
      warn(`Gagal menyimpan state file: ${err.message}`);
    }
  }

  /**
   * Remove state file (clean shutdown).
   */
  clear() {
    this._state = {
      modifiedPids: {},
      governorOriginals: {},
      cgroupBase: null,
      timestamp: null,
      pid: process.pid,
    };
    try {
      if (fs.existsSync(this._stateFilePath)) {
        fs.unlinkSync(this._stateFilePath);
        debug('State file dihapus:', this._stateFilePath);
      }
    } catch (err) {
      warn(`Gagal menghapus state file: ${err.message}`);
    }
  }

  /**
   * Check for stale state from a previous crash and restore.
   * Returns true if recovery was performed.
   */
  recoverFromCrash(config) {
    try {
      if (!fs.existsSync(this._stateFilePath)) return false;

      const raw = fs.readFileSync(this._stateFilePath, 'utf8');
      const saved = JSON.parse(raw);

      if (!saved || !saved.modifiedPids) {
        this.clear();
        return false;
      }

      // Check if this is from the same process (still running)
      if (saved.pid === process.pid) {
        debug('State file dari proses yang sama, skip recovery.');
        return false;
      }

      info('Mendeteksi state file dari crash sebelumnya — memulihkan...');
      let restored = 0;
      let skippedPidReuse = 0;

      // Restore processes
      for (const pidStr of Object.keys(saved.modifiedPids)) {
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;

        // Check if process is still alive
        try { process.kill(pid, 0); } catch (_) {
          continue; // Process is dead, skip
        }

        const procState = saved.modifiedPids[pidStr];

        // ── v2.1.5: PID reuse protection ────────────────────────────
        //
        // If the saved state includes a start-time, verify the current
        // process at this PID is the SAME process the daemon originally
        // modified. If the start-time differs, the PID was recycled
        // (original process exited, kernel assigned this PID to a
        // different process) — we MUST NOT restore state to it.
        //
        // Without this check, a scenario like:
        //   1. Daemon throttles PID 12345 (chrome)
        //   2. Daemon crashes
        //   3. Chrome exits, PID 12345 free
        //   4. systemd-journald spawns, gets PID 12345
        //   5. Daemon restarts, recoverFromCrash sees PID 12345 alive
        //   6. Daemon renices systemd-journald to 0, ionice default
        //      → UNWANTED SIDE EFFECT on an unrelated system process
        //
        // With the check, we skip PID 12345 in step 5 because the
        // start-time no longer matches.
        if (typeof procState.startTime === 'number') {
          const getStart = _resolveGetPidStartTime();
          if (getStart) {
            const currentStart = getStart(pid);
            if (currentStart === null) {
              // Couldn't read current start-time (e.g. /proc not mounted).
              // Be conservative: skip this PID rather than risk restoring
              // state to the wrong process.
              debug(`PID ${pid}: could not read current start-time, skipping (conservative)`);
              skippedPidReuse++;
              continue;
            }
            if (currentStart !== procState.startTime) {
              warn(`PID ${pid}: start-time mismatch (saved=${procState.startTime}, current=${currentStart}) — PID was recycled, skipping restore`);
              skippedPidReuse++;
              continue;
            }
            debug(`PID ${pid}: start-time verified (${currentStart}), restoring`);
          }
          // If getStart is unavailable (sensor.js failed to load),
          // fall through to restore without the check — same as old behavior.
        } else {
          // No saved start-time (state file from older daemon version,
          // or /proc was unavailable when trackProcess was called).
          // Fall back to old behavior: restore without identity check.
          debug(`PID ${pid}: no saved start-time, restoring without identity check`);
        }

        // Restore nice
        if (typeof procState.nice === 'number') {
          try {
            execFileSync('renice', ['-n', '0', '-p', String(pid)], { stdio: 'ignore', timeout: 3000 });
          } catch (_) { /* might fail */ }
        }

        // Restore ionice
        if (Array.isArray(procState.ionice)) {
          try {
            execFileSync('ionice', ['-c', '2', '-n', '4', '-p', String(pid)], { stdio: 'ignore', timeout: 3000 });
          } catch (_) { /* might fail */ }
        }

        // Restore affinity (all cores)
        if (procState.affinity) {
          try {
            execFileSync('taskset', ['-pc', '0-' + String(require('os').cpus().length - 1), String(pid)], { stdio: 'ignore', timeout: 3000 });
          } catch (_) { /* might fail */ }
        }

        // Restore cgroup (move to base cgroup)
        //
        // BUG FIX (v2.1.2): Previously this used `saved.cgroupBase || '/sys/fs/cgroup'`
        // but cgroupBase was never written to the state file, so it always
        // fell back to /sys/fs/cgroup (the root). On delegated-cgroup setups
        // (systemd user sessions), writing to the root cgroup.procs fails
        // with EACCES, silently skipping restoration. Now we also accept
        // a config override (config.CGROUP_ROOT) and the actuator's resolved
        // base via setCgroupBase() — the saved value takes priority.
        if (typeof procState.cgroup === 'string') {
          try {
            const rootCgroup = saved.cgroupBase
              || (config && config.CGROUP_ROOT)
              || '/sys/fs/cgroup';
            const procsPath = path.join(rootCgroup, 'cgroup.procs');
            fs.writeFileSync(procsPath, String(pid));
          } catch (_) { /* might fail */ }
        }

        // Restore oom_score_adj
        if (typeof procState.oom_score_adj === 'number') {
          try {
            fs.writeFileSync(`/proc/${pid}/oom_score_adj`, '0');
          } catch (_) { /* might fail */ }
        }

        restored++;
      }

      // Restore governors
      for (const [coreStr, gov] of Object.entries(saved.governorOriginals)) {
        const core = parseInt(coreStr, 10);
        if (typeof gov !== 'string') continue;
        try {
          execFileSync('cpupower', ['-c', String(core), 'frequency-set', '-g', gov], { stdio: 'ignore', timeout: 5000 });
        } catch (_) {
          // Try with sudo
          try {
            execFileSync('sudo', ['-n', 'cpupower', '-c', String(core), 'frequency-set', '-g', gov], { stdio: 'ignore', timeout: 5000 });
          } catch (_) { /* governor restore failed */ }
        }
      }

      if (skippedPidReuse > 0) {
        info(`Recovery: ${skippedPidReuse} PID(s) skipped due to PID reuse (start-time mismatch).`);
      }
      info(`Recovery selesai: ${restored} proses dikembalikan ke normal.`);
      this.clear();
      return true;
    } catch (err) {
      warn(`Recovery error: ${err.message}`);
      return false;
    }
  }

  get stateFilePath() {
    return this._stateFilePath;
  }
}

module.exports = RollbackManager;