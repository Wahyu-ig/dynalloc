'use strict';

/**
 * DynAlloc — Detector Layer :: Detection Context
 * ===============================================
 *
 * An immutable snapshot of system state passed to every detector on
 * each tick. Centralizing the snapshot avoids each detector making
 * independent sensor calls (which would duplicate work and risk
 * inconsistent readings).
 *
 * The daemon constructs a DetectionContext once per fastTick (cheap
 * fields) and once per slowTick (expensive fields like process list).
 * Detectors receive the SAME context object within a single tick —
 * they MUST NOT mutate it.
 *
 * Shape:
 *
 *   {
 *     timestamp: number,         // Date.now() at construction
 *     foregroundPid: number|null,
 *     foregroundInfo: {pid, comm, cmdline, name}|null,
 *     procs: Array<{pid, ppid, pcpu, comm}>,  // empty on fastTick
 *     mediaPids: Set<number>,
 *     stressLevel: 'NORMAL'|'WARN'|'CRITICAL',
 *     cpuPressure: number,       // PSI avg10
 *     memPressure: number,       // PSI avg10
 *     thermalTemp: number|null,  // °C
 *     battery: {onBattery, capacity}|null,
 *     onBattery: boolean,
 *     adaptiveScore: number,     // 0.0 - 1.0
 *     gpuUtilization: number|null,
 *     networkRxKbps: number,
 *   }
 *
 * All fields are optional — detectors MUST handle missing data
 * gracefully (treat as "unknown" rather than "zero").
 *
 * Backward compatibility: only constructed when ENABLE_DETECTOR_LAYER
 * is true.
 */

/**
 * Build a DetectionContext from the daemon's current state.
 *
 * Accepts a plain object with whatever fields are available and
 * freezes it so detectors cannot accidentally mutate daemon state.
 *
 * @param {object} fields - see shape above
 * @returns {DetectionContext} frozen snapshot
 */
class DetectionContext {
  constructor(fields) {
    fields = fields || {};

    // ── Identity & timing ───────────────────────────────────────────
    this.timestamp = typeof fields.timestamp === 'number'
      ? fields.timestamp : Date.now();

    // ── Foreground ──────────────────────────────────────────────────
    this.foregroundPid = (typeof fields.foregroundPid === 'number' && fields.foregroundPid > 0)
      ? fields.foregroundPid : null;
    this.foregroundInfo = (fields.foregroundInfo && typeof fields.foregroundInfo === 'object')
      ? Object.freeze({ ...fields.foregroundInfo }) : null;

    // ── Process list (slowTick only) ────────────────────────────────
    this.procs = Array.isArray(fields.procs)
      ? Object.freeze(fields.procs.slice())
      : EMPTY_ARRAY;

    // ── Multimedia ──────────────────────────────────────────────────
    this.mediaPids = (fields.mediaPids instanceof Set)
      ? new Set(fields.mediaPids)
      : new Set();

    // ── Stress / pressure ───────────────────────────────────────────
    this.stressLevel = ['NORMAL', 'WARN', 'CRITICAL'].includes(fields.stressLevel)
      ? fields.stressLevel : 'NORMAL';
    this.cpuPressure = _safeNumber(fields.cpuPressure, 0);
    this.memPressure = _safeNumber(fields.memPressure, 0);
    this.adaptiveScore = _safeNumber(fields.adaptiveScore, 0);

    // ── Hardware state ──────────────────────────────────────────────
    this.thermalTemp = (typeof fields.thermalTemp === 'number' && Number.isFinite(fields.thermalTemp))
      ? fields.thermalTemp : null;
    this.gpuUtilization = (typeof fields.gpuUtilization === 'number' && Number.isFinite(fields.gpuUtilization))
      ? fields.gpuUtilization : null;
    this.networkRxKbps = _safeNumber(fields.networkRxKbps, 0);

    // ── Power ───────────────────────────────────────────────────────
    this.battery = (fields.battery && typeof fields.battery === 'object')
      ? Object.freeze({
          onBattery: !!fields.battery.onBattery,
          capacity: _safeNumber(fields.battery.capacity, 100),
        })
      : null;
    this.onBattery = !!(this.battery && this.battery.onBattery);

    // Freeze the entire context so detectors cannot mutate it.
    // (procs and mediaPids are still mutable collections at the
    // element level — procs is frozen above, mediaPids is a fresh
    // Set so detectors can iterate without mutating the daemon's set.)
    Object.freeze(this);
  }

  /**
   * Find a process by PID in the snapshot.
   * @param {number} pid
   * @returns {object|null}
   */
  findProc(pid) {
    if (typeof pid !== 'number' || pid <= 0) return null;
    for (const p of this.procs) {
      if (p.pid === pid) return p;
    }
    return null;
  }

  /**
   * Find a process by comm name (exact match, case-sensitive).
   * @param {string} comm
   * @returns {object|null}
   */
  findProcByComm(comm) {
    if (typeof comm !== 'string' || comm.length === 0) return null;
    for (const p of this.procs) {
      if (p.comm === comm) return p;
    }
    return null;
  }

  /**
   * Whether the foreground process is in the given PID set.
   * @param {Set<number>} pids
   * @returns {boolean}
   */
  foregroundIn(pids) {
    if (!(pids instanceof Set) || pids.size === 0) return false;
    return this.foregroundPid !== null && pids.has(this.foregroundPid);
  }
}

const EMPTY_ARRAY = Object.freeze([]);

function _safeNumber(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

module.exports = { DetectionContext };
