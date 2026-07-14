'use strict';

/**
 * DynAlloc — Detector Layer :: Power State Detector
 * ===================================================
 *
 * Tracks power-related state transitions:
 *
 *   - AC plugged / unplugged
 *   - Battery charging / discharging
 *   - Battery low (configurable threshold)
 *   - Battery critical (configurable threshold)
 *
 * This detector reads battery status from the DetectionContext
 * (which the daemon populates from `sensor.readBatteryStatus`).
 * It emits bus events ONLY on state transitions (not every tick),
 * so it is safe to call on every fastTick.
 *
 * Event names emitted:
 *
 *   onPowerStateChanged   { from, to, capacity, onBattery }
 *   onBatteryLow          { capacity, threshold }
 *   onBatteryCritical     { capacity, threshold }
 *   onAcPlugged           { capacity }
 *   onAcUnplugged         { capacity }
 *   onBatteryCharging     { capacity }
 *   onBatteryDischarging  { capacity }
 *
 * NOTE: When the Policy Engine is enabled, `event-sources.js` already
 * emits ON_BATTERY_LOW / ON_AC_PLUGGED / ON_AC_UNPLUGGED /
 * ON_BATTERY_CHARGING / ON_BATTERY_DISCHARGING from the same sensor
 * data. This detector is intentionally a SEPARATE emitter so that:
 *
 *   1. Power state events are available even when PE is disabled.
 *   2. The Detector Layer has its own complete event vocabulary
 *      (consumers can subscribe to one bus, not two).
 *   3. Future power-state rules can live entirely in the detector
 *      layer without coupling to PE internals.
 *
 * When BOTH this detector AND event-sources.js are active, listeners
 * will see duplicate events. This is documented and acceptable —
 * consumers should deduplicate by event name + payload if needed.
 *
 * Backward compatibility: only runs when ENABLE_DETECTOR_LAYER=true.
 */

const BaseDetector = require('./base-detector');
const { debug } = require('../logger');

// ── Constants ────────────────────────────────────────────────────────

const STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  AC: 'AC',
  BATTERY: 'BATTERY',
  BATTERY_LOW: 'BATTERY_LOW',
  BATTERY_CRITICAL: 'BATTERY_CRITICAL',
  CHARGING: 'CHARGING',
});

// ── PowerStateDetector class ─────────────────────────────────────────

class PowerStateDetector extends BaseDetector {
  constructor(deps) {
    super('power-state', deps);
    this._lastState = STATE.UNKNOWN;
    this._lastCapacity = null;
    this._detectionCount = 0;
  }

  isAvailable() {
    // Available whenever we have a battery path configured. Even if
    // the battery is currently missing (e.g. desktop), we still run
    // so that we'd notice if a battery appeared (rare but possible
    // on hotplug laptops).
    return true;
  }

  detect(context) {
    if (!context) return [];

    // No battery info this tick — nothing to do.
    if (!context.battery) {
      // If we previously had battery state but now don't, emit UNKNOWN.
      if (this._lastState !== STATE.UNKNOWN) {
        const detection = this._transition(STATE.UNKNOWN, null, 'battery-unavailable');
        return detection ? [detection] : [];
      }
      return [];
    }

    const { onBattery, capacity } = context.battery;
    const lowThreshold = this._getLowThreshold();
    const criticalThreshold = this._getCriticalThreshold();

    let newState;
    if (!onBattery) {
      // Plugged in — distinguish AC (full) vs CHARGING (not full).
      // We treat "plugged in and not full" as CHARGING for event
      // purposes; "plugged in and full" as AC. If we can't tell,
      // default to AC.
      if (typeof capacity === 'number' && capacity < 100) {
        newState = STATE.CHARGING;
      } else {
        newState = STATE.AC;
      }
    } else {
      // On battery — distinguish BATTERY / BATTERY_LOW / BATTERY_CRITICAL.
      if (typeof capacity === 'number' && capacity <= criticalThreshold) {
        newState = STATE.BATTERY_CRITICAL;
      } else if (typeof capacity === 'number' && capacity <= lowThreshold) {
        newState = STATE.BATTERY_LOW;
      } else {
        newState = STATE.BATTERY;
      }
    }

    // Hysteresis: emit only on state change OR significant capacity drop.
    const capacityChanged = (this._lastCapacity !== null) &&
                            (typeof capacity === 'number') &&
                            (Math.abs(this._lastCapacity - capacity) >= 5);

    if (newState === this._lastState && !capacityChanged) {
      return [];
    }

    // Capture prevState BEFORE _transition() mutates _lastState.
    // _emitTransitionEvents needs the OLD state to know which
    // transition-specific event to emit (e.g. AC→BATTERY emits
    // onAcUnplugged, BATTERY→AC emits onAcPlugged).
    const prevStateForEmit = this._lastState;

    const reason = (newState !== this._lastState)
      ? `state-${this._lastState}-to-${newState}`
      : `capacity-drift-${this._lastCapacity}-to-${capacity}`;

    const detection = this._transition(newState, capacity, reason);
    if (!detection) return [];

    // Emit transition-specific events using the captured prevState.
    this._emitTransitionEvents(detection, prevStateForEmit, newState, capacity, lowThreshold, criticalThreshold);

    return [detection];
  }

  // ── Internal ──────────────────────────────────────────────────────

  _getLowThreshold() {
    const t = this.config && this.config.BATTERY_LOW_THRESHOLD;
    return typeof t === 'number' && t >= 1 && t <= 50 ? t : 20;
  }

  _getCriticalThreshold() {
    // Critical is 50% of low by default. Could be made configurable.
    return Math.max(5, Math.floor(this._getLowThreshold() * 0.5));
  }

  _transition(newState, capacity, reason) {
    const prevState = this._lastState;
    this._lastState = newState;
    this._lastCapacity = capacity;
    this._detectionCount++;

    return {
      detector: this.name,
      domain: 'power',
      classification: newState,
      confidence: 1.0,
      payload: {
        prevState,
        capacity,
        onBattery: newState !== STATE.AC && newState !== STATE.CHARGING && newState !== STATE.UNKNOWN,
        reason,
      },
      timestamp: new Date().toISOString(),
    };
  }

  _emitTransitionEvents(detection, prevState, newState, capacity, lowThreshold, criticalThreshold) {
    if (!this.bus) return;

    // Always emit the umbrella event.
    this._safeEmit('onPowerStateChanged', {
      from: prevState,
      to: newState,
      capacity,
      timestamp: detection.timestamp,
    });

    // State-specific events.
    if (newState === STATE.AC && prevState !== STATE.AC) {
      this._safeEmit('onAcPlugged', { capacity });
    }
    if (newState === STATE.BATTERY && prevState === STATE.AC) {
      this._safeEmit('onAcUnplugged', { capacity });
    }
    if (newState === STATE.BATTERY && prevState === STATE.CHARGING) {
      this._safeEmit('onBatteryDischarging', { capacity });
    }
    if (newState === STATE.CHARGING && prevState === STATE.BATTERY) {
      this._safeEmit('onBatteryCharging', { capacity });
    }
    if (newState === STATE.BATTERY_LOW && prevState !== STATE.BATTERY_LOW) {
      this._safeEmit('onBatteryLow', { capacity, threshold: lowThreshold });
    }
    if (newState === STATE.BATTERY_CRITICAL && prevState !== STATE.BATTERY_CRITICAL) {
      this._safeEmit('onBatteryCritical', { capacity, threshold: criticalThreshold });
    }
  }

  _safeEmit(name, payload) {
    if (!this.bus) return;
    try {
      this.bus.emit(name, payload);
    } catch (err) {
      debug(`PowerStateDetector: bus emit "${name}" failed: ${err.message}`);
    }
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      running: this.isRunning,
      lastState: this._lastState,
      lastCapacity: this._lastCapacity,
      detectionCount: this._detectionCount,
    };
  }
}

module.exports = PowerStateDetector;
module.exports.POWER_STATE = STATE;
