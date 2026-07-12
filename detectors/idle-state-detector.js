'use strict';

/**
 * DynAlloc — Detector Layer :: Idle State Detector
 * ==================================================
 *
 * Detects whether the user is idle based on:
 *
 *   - Foreground process stability (same PID for N consecutive ticks)
 *   - CPU pressure (low pressure for N ticks → likely idle)
 *   - Network RX rate (low for N ticks → likely idle)
 *
 * This is a HEURISTIC detector — it cannot detect keyboard/mouse
 * idle (that would require X11/Wayland idle-time APIs, which are
 * out of scope for Phase 1). It uses process + pressure + network
 * signals as a proxy.
 *
 * State machine:
 *
 *   ACTIVE → IDLE   when foreground stable + low pressure + low net for
 *                   IDLE_THRESHOLD_TICKS consecutive ticks.
 *   IDLE → ACTIVE   when any of the above changes (foreground PID
 *                   changes, pressure spikes, network spikes).
 *
 * Configurable via:
 *
 *   IDLE_THRESHOLD_TICKS  (default: 30 — i.e. ~30s at 1s fastTick)
 *   IDLE_CPU_PRESSURE_MAX (default: 2.0 — PSI avg10 below this = "low")
 *   IDLE_NET_RX_KBPS_MAX  (default: 5 — KB/s below this = "low")
 *
 * Events emitted:
 *
 *   onIdleStateChanged  { from, to, idleTicks }
 *   onIdle              { idleTicks, foregroundPid }
 *   onIdleEnd           { foregroundPid }
 *
 * Backward compatibility: only runs when ENABLE_DETECTOR_LAYER=true.
 * Does NOT depend on X11/Wayland idle APIs — purely heuristic.
 */

const BaseDetector = require('./base-detector');
const { debug } = require('../logger');

// ── Constants ────────────────────────────────────────────────────────

const STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
});

// ── IdleStateDetector class ──────────────────────────────────────────

class IdleStateDetector extends BaseDetector {
  constructor(deps) {
    super('idle-state', deps);
    this._state = STATE.ACTIVE;
    this._idleTicks = 0;
    this._lastForegroundPid = null;
    this._detectionCount = 0;
  }

  isAvailable() {
    // Always available — uses only fields from DetectionContext.
    return true;
  }

  detect(context) {
    if (!context) return [];

    // ── Compute idle signals ─────────────────────────────────────────
    // On the very first tick, _lastForegroundPid is null. We seed the
    // baseline so the first tick counts toward the idle threshold
    // (otherwise threshold=N would require N+1 ticks, which is
    // surprising). After the first tick, "stable" means "same PID
    // as the previous tick".
    const fgPid = context.foregroundPid;
    const prevFg = this._lastForegroundPid;
    const isFirstTick = (prevFg === null);
    if (isFirstTick) {
      this._lastForegroundPid = fgPid;
    }
    const fgStable = isFirstTick || (fgPid === prevFg);
    // Update for next tick
    this._lastForegroundPid = fgPid;

    const cpuLow = context.cpuPressure < this._getIdleCpuMax();
    const netLow = context.networkRxKbps < this._getIdleNetMax();

    const allIdleSignals = fgStable && cpuLow && netLow;

    // ── State machine ────────────────────────────────────────────────
    const prevState = this._state;
    let newState = prevState;

    if (allIdleSignals) {
      this._idleTicks++;
      if (this._idleTicks >= this._getIdleThresholdTicks() && prevState === STATE.ACTIVE) {
        newState = STATE.IDLE;
      }
    } else {
      // Any activity breaks idle immediately.
      this._idleTicks = 0;
      if (prevState === STATE.IDLE) {
        newState = STATE.ACTIVE;
      }
    }

    if (newState === prevState) {
      // No transition — no detection this tick.
      return [];
    }

    // ── Transition detected ──────────────────────────────────────────
    this._state = newState;
    this._detectionCount++;

    const detection = {
      detector: this.name,
      domain: 'idle',
      classification: newState,
      confidence: 0.85, // heuristic — not 1.0 because we don't have direct input idle time
      payload: {
        prevState,
        idleTicks: this._idleTicks,
        foregroundPid: context.foregroundPid,
        cpuPressure: context.cpuPressure,
        networkRxKbps: context.networkRxKbps,
        thresholdTicks: this._getIdleThresholdTicks(),
        thresholdCpuMax: this._getIdleCpuMax(),
        thresholdNetMax: this._getIdleNetMax(),
      },
      timestamp: new Date().toISOString(),
    };

    // Emit transition events
    if (this.bus) {
      try {
        this.bus.emit('onIdleStateChanged', {
          from: prevState,
          to: newState,
          idleTicks: this._idleTicks,
          timestamp: detection.timestamp,
        });
        if (newState === STATE.IDLE) {
          this.bus.emit('onIdle', {
            idleTicks: this._idleTicks,
            foregroundPid: context.foregroundPid,
          });
        } else if (newState === STATE.ACTIVE) {
          this.bus.emit('onIdleEnd', {
            foregroundPid: context.foregroundPid,
          });
        }
      } catch (err) {
        debug(`IdleStateDetector: bus emit failed: ${err.message}`);
      }
    }

    // Update shared state store
    if (this.stateStore) {
      try {
        this.stateStore.set('idle.state', newState);
        this.stateStore.set('idle.ticks', this._idleTicks);
      } catch (_) { /* non-fatal */ }
    }

    return [detection];
  }

  // ── Internal ──────────────────────────────────────────────────────

  _getIdleThresholdTicks() {
    const t = this.config && this.config.DETECTOR_IDLE_THRESHOLD_TICKS;
    return typeof t === 'number' && t >= 1 && t <= 600 ? t : 30;
  }

  _getIdleCpuMax() {
    const t = this.config && this.config.DETECTOR_IDLE_CPU_PRESSURE_MAX;
    return typeof t === 'number' && t >= 0 && t <= 50 ? t : 2.0;
  }

  _getIdleNetMax() {
    const t = this.config && this.config.DETECTOR_IDLE_NET_RX_KBPS_MAX;
    return typeof t === 'number' && t >= 0 && t <= 1048576 ? t : 5;
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      running: this.isRunning,
      state: this._state,
      idleTicks: this._idleTicks,
      detectionCount: this._detectionCount,
    };
  }
}

module.exports = IdleStateDetector;
module.exports.IDLE_STATE = STATE;
