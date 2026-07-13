'use strict';

/**
 * DynAlloc — Policy Engine :: Event Bus
 * =====================================
 *
 * A synchronous, in-process publish/subscribe event bus used by the
 * Policy Engine to decouple event producers (the daemon, sensors,
 * plugins) from event consumers (rule evaluators, loggers, plugins).
 *
 * Design goals:
 *   - Zero allocations on the hot path when no listeners are attached.
 *   - Synchronous dispatch (no setImmediate / no extra microtasks) so
 *     that producers see listener completion before they continue. This
 *     keeps the ordering of side effects predictable.
 *   - Listener errors are isolated: a throw in one listener never
 *     propagates to the producer or to sibling listeners.
 *   - Wildcard subscription via '*' is supported for debugging/audit.
 *   - Listeners can be removed individually or via `offAll()` for
 *     clean shutdown — no leaked closures, no dangling references.
 *
 * The bus is intentionally framework-free. It does not depend on
 * Node's EventEmitter so we can fully control error isolation and
 * dispatch semantics.
 *
 * Backward compatibility: this module is only required when
 * ENABLE_POLICY_ENGINE is true. The rest of the daemon never imports
 * it directly.
 */

const logger = require('../logger');
const { debug, warn } = logger;

/**
 * Standard event names emitted on the bus. Producers and consumers
 * MUST use these constants to avoid typos breaking subscriptions.
 *
 * Adding a new event is a non-breaking change — listeners that do not
 * subscribe to it simply never fire.
 */
const EVENTS = Object.freeze({
  // ── System / power events ──────────────────────────────────────────
  ON_BATTERY_LOW:        'onBatteryLow',
  ON_BATTERY_CHARGING:   'onBatteryCharging',
  ON_BATTERY_DISCHARGING:'onBatteryDischarging',
  ON_AC_PLUGGED:         'onAcPlugged',
  ON_AC_UNPLUGGED:       'onAcUnplugged',
  ON_SUSPEND:            'onSuspend',
  ON_RESUME:             'onResume',
  ON_IDLE:               'onIdle',
  ON_IDLE_END:           'onIdleEnd',

  // ── Pressure / thermal events ──────────────────────────────────────
  ON_CPU_HIGH:           'onCpuHigh',
  ON_CPU_NORMAL:         'onCpuNormal',
  ON_MEMORY_PRESSURE:    'onMemoryPressure',
  ON_MEMORY_NORMAL:      'onMemoryNormal',
  ON_THERMAL_HIGH:       'onThermalHigh',

  // ── Desktop / window events ────────────────────────────────────────
  ON_FOREGROUND_CHANGED: 'onForegroundChanged',
  ON_WALLPAPER_CHANGED:  'onWallpaperChanged',

  // ── Process events ─────────────────────────────────────────────────
  ON_PROCESS_STARTED:    'onProcessStarted',
  ON_PROCESS_EXITED:     'onProcessExited',

  // ── Scheduler / profile events ─────────────────────────────────────
  ON_STRESS_CHANGED:     'onStressChanged',
  ON_PROFILE_CHANGED:    'onProfileChanged',

  // ── Plugin lifecycle ───────────────────────────────────────────────
  ON_PLUGIN_LOADED:      'onPluginLoaded',
  ON_PLUGIN_UNLOADED:    'onPluginUnloaded',

  // ── Engine lifecycle (for audit / debugging) ───────────────────────
  ON_POLICY_ENGINE_STARTED:  'onPolicyEngineStarted',
  ON_POLICY_ENGINE_STOPPED:  'onPolicyEngineStopped',
  ON_POLICY_ENGINE_RELOADED: 'onPolicyEngineReloaded',
});

class EventBus {
  constructor() {
    // Map<eventName, Array<{fn, once, priority, id}>>
    this._listeners = new Map();
    this._wildcardListeners = [];
    this._nextListenerId = 1;
    this._dispatching = 0; // re-entrancy guard counter (recursive emit is allowed but tracked)
    this._pendingRemovals = [];
    this._destroyed = false;
  }

  /**
   * Subscribe to an event.
   *
   * @param {string} eventName - event name (use '*' to subscribe to all events)
   * @param {Function} fn - listener (event payload is the only argument)
   * @param {object} [opts]
   * @param {number} [opts.priority=0] - higher priority listeners fire first
   * @param {boolean} [opts.once=false] - auto-remove after first invocation
   * @returns {number} listener id (use with `off()` to unsubscribe)
   */
  on(eventName, fn, opts = {}) {
    if (this._destroyed) return -1;
    if (typeof fn !== 'function') {
      warn('EventBus.on: listener is not a function, ignored');
      return -1;
    }
    const entry = {
      fn,
      once: !!opts.once,
      priority: typeof opts.priority === 'number' ? opts.priority : 0,
      id: this._nextListenerId++,
    };

    if (eventName === '*') {
      this._wildcardListeners.push(entry);
      this._wildcardListeners.sort((a, b) => b.priority - a.priority);
    } else {
      const arr = this._listeners.get(eventName) || [];
      arr.push(entry);
      arr.sort((a, b) => b.priority - a.priority);
      this._listeners.set(eventName, arr);
    }
    return entry.id;
  }

  /**
   * Subscribe to an event for a single invocation.
   * Convenience wrapper for `on(name, fn, { once: true })`.
   */
  once(eventName, fn, opts = {}) {
    return this.on(eventName, fn, { ...opts, once: true });
  }

  /**
   * Unsubscribe a listener by the id returned from `on()`.
   * Safe to call during dispatch — removal is deferred to the end of
   * the current dispatch cycle to avoid mutating the listener array
   * mid-iteration.
   *
   * @param {number} id - listener id returned by `on()`
   * @returns {boolean} true if a listener was removed
   */
  off(id) {
    if (typeof id !== 'number' || id < 1) return false;

    const removeFrom = (arr) => {
      const idx = arr.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      if (this._dispatching > 0) {
        this._pendingRemovals.push(id);
        // Mark as removed so it is skipped during dispatch
        arr[idx].removed = true;
      } else {
        arr.splice(idx, 1);
      }
      return true;
    };

    if (removeFrom(this._wildcardListeners)) return true;
    for (const arr of this._listeners.values()) {
      if (removeFrom(arr)) return true;
    }
    return false;
  }

  /**
   * Remove all listeners for a specific event, or all listeners on the
   * bus if no event name is provided. Used during shutdown.
   */
  offAll(eventName) {
    if (this._destroyed) return;
    if (eventName === undefined) {
      this._listeners.clear();
      this._wildcardListeners = [];
      this._pendingRemovals = [];
    } else if (eventName === '*') {
      this._wildcardListeners = [];
    } else {
      this._listeners.delete(eventName);
    }
  }

  /**
   * Emit an event synchronously to all matching listeners.
   *
   * Listener errors are caught and logged — they never propagate to
   * the caller. Re-entrant emits (a listener emitting another event)
   * are supported via a dispatch counter and deferred removal queue.
   *
   * `once` listeners are ALWAYS removed via the deferred removal queue
   * (never spliced mid-iteration) to prevent skipping the next entry
   * in the iteration.
   *
   * @param {string} eventName - event name
   * @param {*} [payload] - arbitrary payload passed to listeners
   * @returns {number} number of listeners that were invoked
   */
  emit(eventName, payload) {
    if (this._destroyed) return 0;

    const listeners = this._listeners.get(eventName);
    const matched = (listeners ? listeners.length : 0) + this._wildcardListeners.length;
    if (matched === 0) return 0;

    this._dispatching++;
    let invoked = 0;

    try {
      // Specific listeners first (priority order, highest first)
      if (listeners) {
        for (const entry of listeners) {
          if (entry.removed) continue;
          invoked++;
          try {
            entry.fn(payload);
          } catch (err) {
            try { warn(`EventBus listener for "${eventName}" threw: ${err.message}`); }
            catch (_) { /* logger itself failed — swallow to preserve dispatch */ }
          }
          if (entry.once) {
            // Always defer removal — splicing mid-iteration skips entries
            this._pendingRemovals.push(entry.id);
            entry.removed = true;
          }
        }
      }

      // Wildcard listeners second
      const wildcards = this._wildcardListeners;
      for (const entry of wildcards) {
        if (entry.removed) continue;
        invoked++;
        try {
          entry.fn(eventName, payload);
        } catch (err) {
          try { warn(`EventBus wildcard listener threw on "${eventName}": ${err.message}`); }
          catch (_) { /* swallow */ }
        }
        if (entry.once) {
          this._pendingRemovals.push(entry.id);
          entry.removed = true;
        }
      }
    } finally {
      this._dispatching--;
      if (this._dispatching === 0) {
        this._flushPendingRemovals();
      }
    }
    return invoked;
  }

  /**
   * Return the number of listeners for a specific event (excludes
   * wildcards). Used for diagnostics and tests.
   */
  listenerCount(eventName) {
    const arr = this._listeners.get(eventName);
    return arr ? arr.length : 0;
  }

  /**
   * Return the list of events that currently have at least one
   * listener. Used for diagnostics.
   */
  activeEvents() {
    return Array.from(this._listeners.keys()).filter(
      (k) => this._listeners.get(k).length > 0
    );
  }

  /**
   * Permanent teardown. After destroy(), all subsequent on/emit calls
   * are no-ops. Used on daemon shutdown.
   */
  destroy() {
    this._destroyed = true;
    this._listeners.clear();
    this._wildcardListeners = [];
    this._pendingRemovals = [];
  }

  _flushPendingRemovals() {
    if (this._pendingRemovals.length === 0) return;
    const ids = new Set(this._pendingRemovals);
    this._pendingRemovals = [];

    this._wildcardListeners = this._wildcardListeners.filter((e) => !ids.has(e.id));
    for (const [name, arr] of this._listeners) {
      const filtered = arr.filter((e) => !ids.has(e.id));
      if (filtered.length === 0) {
        this._listeners.delete(name);
      } else {
        this._listeners.set(name, filtered);
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance = null;

/**
 * Get the shared EventBus singleton. The bus is created lazily on
 * first access. Use `resetEventBus()` to clear all listeners (for
 * tests or daemon shutdown).
 *
 * @returns {EventBus}
 */
function getEventBus() {
  if (!_instance) {
    _instance = new EventBus();
  }
  return _instance;
}

/**
 * Destroy and reset the singleton. Existing listeners are released.
 * Mainly used by tests and on daemon shutdown.
 */
function resetEventBus() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  EventBus,
  EVENTS,
  getEventBus,
  resetEventBus,
};
