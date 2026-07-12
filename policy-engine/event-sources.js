'use strict';

/**
 * DynAlloc — Policy Engine :: Event Sources
 * =========================================
 *
 * A small helper that translates raw sensor data (read by the daemon
 * on every fastTick/slowTick) into discrete events on the Policy
 * Engine's bus. Without this layer, the daemon would have to emit
 * events inline at every check site, which would scatter policy
 * concerns across the daemon code.
 *
 * The daemon calls a few methods on this module:
 *
 *   eventSources.updateBattery(status)   // on every fastTick
 *   eventSources.updateThermal(temp)     // on every fastTick
 *   eventSources.updatePressure(cpu, mem, stress)  // on every fastTick
 *   eventSources.updateForeground(pid, info)       // on every slowTick
 *   eventSources.updateProcesses(procs)            // on every slowTick
 *   eventSources.notifyPluginLoaded(name)          // from plugin-manager hook
 *   eventSources.notifyPluginUnloaded(name)        // from plugin-manager hook
 *
 * Each method updates the state store and, when a meaningful
 * transition is detected, emits the corresponding event. Hysteresis
 * is applied so that noisy analog values (battery %, CPU %, thermal)
 * do not flood the bus.
 *
 * All methods are idempotent and safe to call with null/undefined
 * (which they will be when the underlying sensor is unavailable).
 *
 * This module holds no timers of its own — it is purely reactive to
 * daemon calls. This satisfies the "avoid polling" performance goal.
 */

const logger = require('../logger');
const { debug, warn } = logger;
const { EVENTS } = require('./event-bus');

class EventSources {
  /**
   * @param {object} deps
   * @param {object} deps.engine - PolicyEngine instance
   * @param {object} deps.config - main CONFIG
   */
  constructor(deps) {
    this._engine = deps.engine;
    this._config = deps.config;
    this._bus = deps.engine.bus;
    this._state = deps.engine.stateStore;

    // Previous values for transition detection
    this._prevBattery = null;        // { onBattery, capacity }
    this._prevCpuPressure = 0;
    this._prevMemPressure = 0;
    this._prevStressLevel = 'NORMAL';
    this._prevForegroundPid = null;
    this._prevThermal = null;
    // Process tracking is by PID (not by name) — see updateProcesses().
    this._knownPids = new Set();
    this._knownPidComm = new Map();
    this._firstProcessScan = true;

    // Hysteresis thresholds for event emission
    this._cpuHighThreshold = this._config.PSI_CPU_WARN || 8.0;
    this._memPressureThreshold = this._config.PSI_MEM_WARN || 4.0;
    this._thermalHighThreshold = 75; // degrees Celsius
    // v2.1.10: battery low threshold is now configurable (was hardcoded at 20)
    this._batteryLowThreshold = this._config.BATTERY_LOW_THRESHOLD || 20;
  }

  // ── Battery ──────────────────────────────────────────────────────

  /**
   * @param {{onBattery: boolean, capacity: number}|null} status
   */
  updateBattery(status) {
    if (!status) return;
    const prev = this._prevBattery;

    // Update state store
    this._state.set('battery.capacity', status.capacity);
    this._state.set('battery.onBattery', status.onBattery);
    this._state.set('battery.plugged', !status.onBattery);

    // Transition: AC plugged/unplugged
    if (prev && prev.onBattery !== status.onBattery) {
      if (status.onBattery) {
        this._bus.emit(EVENTS.ON_AC_UNPLUGGED, { capacity: status.capacity });
        this._bus.emit(EVENTS.ON_BATTERY_DISCHARGING, { capacity: status.capacity });
      } else {
        this._bus.emit(EVENTS.ON_AC_PLUGGED, { capacity: status.capacity });
        this._bus.emit(EVENTS.ON_BATTERY_CHARGING, { capacity: status.capacity });
      }
    }

    // Transition: battery low (only when on battery)
    if (status.onBattery) {
      const wasLow = prev && prev.capacity <= this._batteryLowThreshold && prev.onBattery;
      const isLow = status.capacity <= this._batteryLowThreshold;
      if (isLow && !wasLow) {
        this._bus.emit(EVENTS.ON_BATTERY_LOW, {
          level: status.capacity,
          threshold: this._batteryLowThreshold,
        });
      }
    }

    this._prevBattery = { ...status };
  }

  // ── Thermal ──────────────────────────────────────────────────────

  updateThermal(temp) {
    if (typeof temp !== 'number' || !Number.isFinite(temp)) return;
    this._state.set('thermal.temp', temp);

    const wasHigh = this._prevThermal !== null && this._prevThermal >= this._thermalHighThreshold;
    const isHigh = temp >= this._thermalHighThreshold;
    if (isHigh && !wasHigh) {
      this._bus.emit(EVENTS.ON_THERMAL_HIGH, { temp, threshold: this._thermalHighThreshold });
    }
    this._prevThermal = temp;
  }

  // ── Pressure / Stress ────────────────────────────────────────────

  /**
   * @param {number} cpuPressure - PSI avg10 percent
   * @param {number} memPressure - PSI avg10 percent
   * @param {string} stressLevel - NORMAL | WARN | CRITICAL
   */
  updatePressure(cpuPressure, memPressure, stressLevel) {
    // Re-read thresholds from config so hot-reloaded PSI_CPU_WARN is
    // picked up by the transition detector (not just the matcher).
    //
    // BUG FIX (v2.1.2): Previously used `||` which treats 0 as falsy.
    // If a user sets PSI_CPU_WARN: 0 (to detect any pressure), the `||`
    // kept the old threshold instead of applying 0. Now we use explicit
    // typeof checks so 0 is respected.
    if (typeof this._config.PSI_CPU_WARN === 'number') {
      this._cpuHighThreshold = this._config.PSI_CPU_WARN;
    }
    if (typeof this._config.PSI_MEM_WARN === 'number') {
      this._memPressureThreshold = this._config.PSI_MEM_WARN;
    }

    const hasCpu = typeof cpuPressure === 'number' && Number.isFinite(cpuPressure);
    const hasMem = typeof memPressure === 'number' && Number.isFinite(memPressure);

    if (hasCpu) this._state.set('cpu.pressure', cpuPressure);
    if (hasMem) this._state.set('memory.pressure', memPressure);

    // CPU high transition (only when we have a valid reading)
    if (hasCpu) {
      const wasCpuHigh = this._prevCpuPressure >= this._cpuHighThreshold;
      const isCpuHigh = cpuPressure >= this._cpuHighThreshold;
      if (isCpuHigh && !wasCpuHigh) {
        this._bus.emit(EVENTS.ON_CPU_HIGH, {
          pressure: cpuPressure,
          threshold: this._cpuHighThreshold,
        });
      } else if (!isCpuHigh && wasCpuHigh) {
        this._bus.emit(EVENTS.ON_CPU_NORMAL, { pressure: cpuPressure });
      }
      this._prevCpuPressure = cpuPressure;
    }

    // Memory pressure transition (only when we have a valid reading)
    if (hasMem) {
      const wasMemHigh = this._prevMemPressure >= this._memPressureThreshold;
      const isMemHigh = memPressure >= this._memPressureThreshold;
      if (isMemHigh && !wasMemHigh) {
        this._bus.emit(EVENTS.ON_MEMORY_PRESSURE, {
          pressure: memPressure,
          threshold: this._memPressureThreshold,
        });
      } else if (!isMemHigh && wasMemHigh) {
        this._bus.emit(EVENTS.ON_MEMORY_NORMAL, { pressure: memPressure });
      }
      this._prevMemPressure = memPressure;
    }

    // Stress level transition
    if (stressLevel && stressLevel !== this._prevStressLevel) {
      this._bus.emit(EVENTS.ON_STRESS_CHANGED, {
        from: this._prevStressLevel,
        to: stressLevel,
      });
      this._prevStressLevel = stressLevel;
    }
  }

  // ── Foreground ───────────────────────────────────────────────────

  /**
   * @param {number} pid
   * @param {{name: string, comm: string}|null} info
   */
  updateForeground(pid, info) {
    if (!pid || pid === this._prevForegroundPid) return;

    this._state.set('foreground.pid', pid);
    if (info) {
      if (info.name) this._state.set('foreground.name', info.name);
      if (info.comm) this._state.set('foreground.comm', info.comm);
    }

    this._bus.emit(EVENTS.ON_FOREGROUND_CHANGED, {
      pid,
      prevPid: this._prevForegroundPid,
      name: info ? info.name : null,
      comm: info ? info.comm : null,
    });
    this._prevForegroundPid = pid;
  }

  // ── Processes ────────────────────────────────────────────────────

  /**
   * @param {Array<{pid: number, ppid: number, pcpu: number, comm: string}>} procs
   */
  updateProcesses(procs) {
    if (!Array.isArray(procs)) return;

    // BUG FIX (v2.1.1): Previously this tracked process NAMES instead
    // of PIDs. That meant: (a) the second `chrome` process never fired
    // onProcessStarted, (b) onProcessExited only carried `{ comm }` with
    // no PID, so consumers couldn't tell WHICH instance of a duplicate
    // name exited, and (c) if a process changed its name (rare but
    // possible via prctl(PR_SET_NAME)) it was wrongly reported as a new
    // start. We now track PIDs and emit both pid + comm on every event.
    const currentPids = new Set();
    const pidToComm = new Map();
    for (const p of procs) {
      if (typeof p.pid !== 'number' || p.pid <= 0) continue;
      currentPids.add(p.pid);
      if (typeof p.comm === 'string') pidToComm.set(p.pid, p.comm);
    }

    // Detect newly-started processes (PIDs in current set but not in known set)
    if (!this._firstProcessScan) {
      for (const pid of currentPids) {
        if (!this._knownPids.has(pid)) {
          this._bus.emit(EVENTS.ON_PROCESS_STARTED, {
            pid,
            comm: pidToComm.get(pid) || '',
          });
        }
      }
      // Detect exited processes (PIDs we knew about but no longer see)
      for (const pid of this._knownPids) {
        if (!currentPids.has(pid)) {
          this._bus.emit(EVENTS.ON_PROCESS_EXITED, {
            pid,
            comm: this._knownPidComm.get(pid) || '',
          });
        }
      }
    }

    // Update known set + comm cache for next diff
    this._knownPids = currentPids;
    this._knownPidComm = pidToComm;
    this._firstProcessScan = false;

    // Update aggregate state (still expose names for diagnostics)
    const currentNames = new Set(pidToComm.values());
    this._state.set('processes.count', procs.length);
    this._state.set('processes.names', Array.from(currentNames));
  }

  // ── Plugin lifecycle ─────────────────────────────────────────────

  notifyPluginLoaded(name) {
    if (typeof name !== 'string') return;
    this._bus.emit(EVENTS.ON_PLUGIN_LOADED, { name });
  }

  notifyPluginUnloaded(name) {
    if (typeof name !== 'string') return;
    this._bus.emit(EVENTS.ON_PLUGIN_UNLOADED, { name });
  }

  // ── Power events (suspend/resume/idle) ───────────────────────────
  //
  // These are emitted directly by the daemon's optional D-Bus signal
  // subscriber (or by a future built-in subscriber). The EventSources
  // helper does not subscribe itself — see daemon.js for the wiring.

  emitSuspend() {
    this._bus.emit(EVENTS.ON_SUSPEND, { timestamp: new Date().toISOString() });
  }

  emitResume() {
    this._bus.emit(EVENTS.ON_RESUME, { timestamp: new Date().toISOString() });
  }

  emitIdle() {
    this._bus.emit(EVENTS.ON_IDLE, { timestamp: new Date().toISOString() });
  }

  emitIdleEnd() {
    this._bus.emit(EVENTS.ON_IDLE_END, { timestamp: new Date().toISOString() });
  }

  emitWallpaperChanged(payload) {
    this._bus.emit(EVENTS.ON_WALLPAPER_CHANGED, payload || {});
  }
}

module.exports = {
  EventSources,
};
