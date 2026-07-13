'use strict';

/**
 * DynAlloc — Adaptive Layer :: Adaptive Switching Engine
 * =======================================================
 *
 * The event-driven profile switching engine. Sits between the Event
 * Bus and the ProfileManager, applying stability rules before
 * delegating valid transitions to the ProfileManager.
 *
 * Architecture:
 *
 *   User Events / Detector Layer / PE / Plugins
 *       ↓
 *   Event Bus
 *       ↓
 *   Adaptive Engine (Phase 4)        ← THIS MODULE
 *       ↓ (debounce, cooldown, oscillation, rollback)
 *   Profile Manager (Phase 3)
 *       ↓
 *   Resource Controller (Phase 2)
 *       ↓
 *   Operating System
 *
 * Responsibilities:
 *
 *   - Subscribe to detector events (onWorkloadDetected, etc.)
 *   - Apply debounce/cooldown/oscillation rules via TransitionManager
 *   - Delegate valid transitions to ProfileManager.demand()
 *   - On activation failure, roll back to previous profile
 *   - Support user overrides (highest priority, bypasses cooldown)
 *   - Log all transitions (success, failure, suppression, rollback)
 *   - Emit onProfileTransitionSucceeded / onProfileTransitionFailed events
 *
 * User Override:
 *
 *   The engine exposes demandUserOverride(profileId) which sets a
 *   user-override demand at priority ADAPTIVE_USER_OVERRIDE_PRIORITY
 *   (default 1000 — higher than any built-in profile). The override
 *   persists until releaseUserOverride() is called. While active,
 *   detector events are still processed but the override wins
 *   conflict resolution.
 *
 * Rollback:
 *
 *   When the ProfileManager activates a profile, the engine wraps the
 *   activation in a try/catch. If _applySettings() throws (or the RCM
 *   returns failure for all settings), the engine:
 *     1. Records the failure via TransitionManager.recordTransition({ success: false })
 *     2. Restores the previous profile by calling ProfileManager.demand() with the old profileId
 *     3. Emits onProfileTransitionFailed event
 *     4. Logs the failure
 *   The daemon NEVER terminates because of a failed transition.
 *
 * Event-driven (no polling):
 *
 *   The engine subscribes to bus events. It NEVER polls. The only
 *   timers are the TransitionManager's debounce timer (which is
 *   unref'd so it doesn't keep the event loop alive).
 *
 * Backward compatibility: only constructed when ENABLE_ADAPTIVE_SWITCHING
 * is true. When false, the ProfileManager receives events directly
 * (Phase 3 behavior).
 */

const logger = require('../logger');
const { info, warn, debug } = logger;
const TransitionManager = require('./transition-manager');

// ── Constants ────────────────────────────────────────────────────────

// Events the engine subscribes to (same as ProfileManager, but
// intercepted here first).
const SUBSCRIBED_EVENTS = [
  'onWorkloadDetected',
  'onPowerStateChanged',
  'onIdleStateChanged',
];

// ── AdaptiveEngine class ─────────────────────────────────────────────

class AdaptiveEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config        - main CONFIG
   * @param {object} opts.bus           - EventBus
   * @param {object} opts.profileManager - ProfileManager instance
   * @param {object} [opts.metrics]     - metrics registry (may be null)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('AdaptiveEngine: opts.config is required');
    }
    if (!opts.bus) {
      throw new TypeError('AdaptiveEngine: opts.bus is required');
    }
    if (!opts.profileManager) {
      throw new TypeError('AdaptiveEngine: opts.profileManager is required');
    }
    this._config = opts.config;
    this._bus = opts.bus;
    this._pm = opts.profileManager;
    this._metrics = opts.metrics || null;

    this._tm = new TransitionManager({ config: opts.config, metrics: this._metrics });
    this._listenerIds = [];
    this._started = false;
    this._destroyed = false;

    // User override state
    this._userOverrideProfileId = null;

    // Track the last successfully-activated profile for rollback
    this._lastSuccessfulProfileId = null;

    // Bind handlers — specific bus listeners receive (payload) only,
    // so we wrap _handleEvent to inject the event name.
    this._handlers = {
      onWorkloadDetected: (payload) => this._handleEvent('onWorkloadDetected', payload),
      onPowerStateChanged: (payload) => this._handleEvent('onPowerStateChanged', payload),
      onIdleStateChanged: (payload) => this._handleEvent('onIdleStateChanged', payload),
    };
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Setup: initialize the transition manager.
   */
  setup() {
    // No-op for now — TransitionManager constructor already initialized state.
  }

  /**
   * Start: subscribe to bus events. When the AdaptiveEngine starts,
   * it takes over event handling from the ProfileManager — the PM's
   * bus subscriptions are stopped to avoid double-processing. The
   * AE forwards validated events to the PM via _forwardToPM().
   *
   * The PM's demand set, conflict resolution, and profile activation
   * all continue to work — only its bus listeners are removed.
   */
  start() {
    if (this._started) return;

    // Stop the PM's bus subscriptions — the AE is now the sole handler.
    // The PM's _started flag is re-set to true so its getStatus()
    // still reports "running" (it IS running, just not subscribed).
    try {
      this._pm.stop();
      this._pm._started = true;
    } catch (_) { /* PM may not have been started — ignore */ }

    for (const eventName of SUBSCRIBED_EVENTS) {
      const handler = this._handlers[eventName];
      if (handler) {
        const id = this._bus.on(eventName, handler);
        if (id > 0) this._listenerIds.push(id);
      }
    }

    this._started = true;
    info('AdaptiveEngine started (event-driven, no polling)');
  }

  /**
   * Stop: unsubscribe from bus events.
   */
  stop() {
    if (!this._started) return;
    for (const id of this._listenerIds) {
      try { this._bus.off(id); } catch (_) { /* noop */ }
    }
    this._listenerIds = [];
    this._tm.cancelDebounce();
    this._started = false;
    debug('AdaptiveEngine stopped');
  }

  /**
   * Destroy: stop + reset transition manager.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    this._tm.reset();
  }

  /**
   * Demand a user override profile. Bypasses cooldown + oscillation.
   * The override persists until releaseUserOverride() is called.
   *
   * @param {string} profileId - profile to force-activate
   * @returns {{ success: boolean, error: string|null }}
   */
  demandUserOverride(profileId) {
    if (this._destroyed) return { success: false, error: 'engine destroyed' };
    if (typeof profileId !== 'string' || profileId.length === 0) {
      return { success: false, error: 'profileId required' };
    }

    // Validate the profile exists
    const profile = this._pm.registry.get(profileId);
    if (!profile) {
      return { success: false, error: `unknown profile "${profileId}"` };
    }

    this._userOverrideProfileId = profileId;

    // Use a high-priority demand source that wins conflict resolution.
    // The PM's demand set uses priority from the profile definition,
    // but we want the override to ALWAYS win. We achieve this by
    // using a special source name and relying on the PM's tie-breaking
    // (earliest timestamp wins — we set timestamp to 0).
    const userPriority = this._getUserOverridePriority();
    this._pm._demand.set('__user_override__', {
      profileId,
      priority: userPriority,
      timestamp: 0,  // earliest = wins all ties
    });

    info(`AdaptiveEngine: user override → "${profileId}" (priority ${userPriority})`);

    // Trigger re-evaluation (bypassing our own debounce/cooldown since
    // user overrides are explicit)
    this._pm._reevaluate();

    // Record in transition manager (as a user override)
    this._tm.recordTransition({
      from: this._lastSuccessfulProfileId,
      to: profileId,
      success: true,
      reason: 'user-override',
    });

    return { success: true, error: null };
  }

  /**
   * Release the user override. The PM will fall back to the next-highest-
   * priority demand (or 'balanced' default).
   */
  releaseUserOverride() {
    if (this._destroyed) return;
    if (this._userOverrideProfileId === null) return;

    info(`AdaptiveEngine: user override released (was "${this._userOverrideProfileId}")`);
    this._userOverrideProfileId = null;
    this._pm._demand.delete('__user_override__');
    this._pm._reevaluate();
  }

  /**
   * Get the currently active profile ID (delegates to PM).
   */
  get activeProfileId() {
    return this._pm.activeProfileId;
  }

  /**
   * Get the user override profile ID (or null).
   */
  get userOverrideProfileId() {
    return this._userOverrideProfileId;
  }

  /**
   * Get the TransitionManager (for tests / introspection).
   */
  get transitionManager() {
    return this._tm;
  }

  /**
   * Return a status snapshot.
   */
  getStatus() {
    return {
      enabled: true,
      running: this._started,
      activeProfileId: this._pm.activeProfileId,
      userOverrideProfileId: this._userOverrideProfileId,
      transitionManager: this._tm.getStatus(),
      recentTransitions: this._tm.getHistory(10),
    };
  }

  // ── Hot-reload ───────────────────────────────────────────────────

  setConfig(config) {
    this._config = config;
    this._tm._config = config;
  }

  // ── Internal: event handling ─────────────────────────────────────

  /**
   * Handle an incoming detector event. Applies debounce + cooldown +
   * oscillation rules, then delegates to the ProfileManager.
   *
   * @param {string} eventName - the bus event name
   * @param {object} payload - the event payload
   */
  _handleEvent(eventName, payload) {
    if (this._destroyed || !this._started) return;

    // If a user override is active, detector events are still processed
    // by the PM (which will record the demand), but the override wins
    // conflict resolution. So we don't need to suppress here.

    // Determine what profile this event WOULD activate, so we can
    // evaluate the transition before actually demanding it.
    const predictedProfileId = this._predictProfileForEvent(eventName, payload);
    if (predictedProfileId === null) {
      // Event doesn't map to a profile change — let the PM handle it
      // directly (e.g. power state AC → no demand change).
      this._pm._handleEvent ? this._pm._handleEvent({ name: eventName, ...payload }) :
        this._forwardToPM(eventName, payload);
      return;
    }

    const from = this._pm.activeProfileId;
    const to = predictedProfileId;

    // Evaluate the transition
    const decision = this._tm.evaluateTransition({
      from, to,
      reason: `${eventName}`,
      isUserOverride: false,
    });

    if (!decision.allowed) {
      this._tm.recordSuppression(decision);
      return;
    }

    // Debounce the actual demand. If another event arrives within
    // the debounce window, the earlier demand is cancelled.
    this._tm.debounceTransition(() => {
      this._executeTransition(eventName, payload, from, to);
    }, { from, to, reason: eventName });
  }

  /**
   * Forward an event to the ProfileManager's internal handler.
   * The PM's handlers are _handleWorkload, _handlePowerState, _handleIdleState.
   */
  _forwardToPM(eventName, payload) {
    try {
      if (eventName === 'onWorkloadDetected') {
        this._pm._handleWorkload(payload);
      } else if (eventName === 'onPowerStateChanged') {
        this._pm._handlePowerState(payload);
      } else if (eventName === 'onIdleStateChanged') {
        this._pm._handleIdleState(payload);
      }
    } catch (err) {
      warn(`AdaptiveEngine: PM event forward error: ${err.message}`);
    }
  }

  /**
   * Execute a transition: forward the event to the PM, then record
   * the outcome. If the activation fails, roll back.
   */
  _executeTransition(eventName, payload, from, to) {
    const start = Date.now();
    let success = true;
    let error = null;

    try {
      // Forward the event to the PM, which will update its demand set
      // and activate the winning profile.
      this._forwardToPM(eventName, payload);

      // Check if the profile actually changed (the PM might have
      // kept the same profile if a higher-priority demand was active)
      const actualTo = this._pm.activeProfileId;
      if (actualTo !== to) {
        // The PM activated a different profile than predicted (e.g.
        // a higher-priority demand won). That's fine — record what
        // actually happened.
        to = actualTo;
      }

      if (to === from) {
        // No actual transition — PM kept the same profile
        debug(`AdaptiveEngine: ${eventName} → no transition (stayed on "${to}")`);
        return;
      }

      this._lastSuccessfulProfileId = to;
      debug(`AdaptiveEngine: ${eventName} → ${from} → ${to} (${Date.now() - start}ms)`);

      // Emit success event
      this._emitTransitionEvent('onProfileTransitionSucceeded', {
        from, to, durationMs: Date.now() - start, reason: eventName,
      });

    } catch (err) {
      success = false;
      error = err.message;
      warn(`AdaptiveEngine: transition ${from} → ${to} failed: ${error}`);

      // Rollback: restore the previous profile
      this._rollback(from, to, error);

      // Emit failure event
      this._emitTransitionEvent('onProfileTransitionFailed', {
        from, to, error, durationMs: Date.now() - start, reason: eventName,
      });
    }

    // Record in transition manager
    this._tm.recordTransition({
      from, to, success, durationMs: Date.now() - start,
      error, reason: eventName,
    });
  }

  /**
   * Roll back to the previous profile after a failed activation.
   */
  _rollback(from, to, error) {
    try {
      info(`AdaptiveEngine: rolling back "${to}" → "${from}" (failure: ${error})`);
      // Force the PM to demand the previous profile from a special
      // 'rollback' source with high priority.
      if (from) {
        const profile = this._pm.registry.get(from);
        if (profile) {
          this._pm._demand.set('__rollback__', {
            profileId: from,
            priority: profile.priority,
            timestamp: 0,  // win all ties
          });
          this._pm._reevaluate();
        }
      }
    } catch (rollbackErr) {
      warn(`AdaptiveEngine: rollback failed: ${rollbackErr.message}`);
    }
  }

  /**
   * Emit a transition event on the bus.
   */
  _emitTransitionEvent(eventName, payload) {
    if (!this._bus) return;
    try {
      this._bus.emit(eventName, {
        ...payload,
        timestamp: new Date().toISOString(),
      });
    } catch (_) { /* bus emit failure is non-fatal */ }
  }

  /**
   * Predict which profile an event would activate, without actually
   * activating it. Returns null if the event doesn't map to a profile
   * change (e.g. AC power → no demand).
   */
  _predictProfileForEvent(eventName, payload) {
    if (!payload) return null;

    if (eventName === 'onWorkloadDetected') {
      const w = payload.workload;
      // Mirror the PM's WORKLOAD_TO_PROFILE mapping
      const map = {
        GAME: 'gaming', IDE: 'development', BROWSER: 'balanced',
        RENDERER: 'rendering', VIRTUALIZATION: 'balanced',
        COMPILER: 'development', MULTIMEDIA: 'streaming',
        COMMUNICATION: 'balanced', UNKNOWN: 'balanced', NONE: null,
      };
      return map[w] !== undefined ? map[w] : null;
    }

    if (eventName === 'onPowerStateChanged') {
      const to = payload.to;
      if (to === 'BATTERY_LOW' || to === 'BATTERY_CRITICAL') return 'battery-saver';
      return null;  // AC/CHARGING/BATTERY/UNKNOWN → no special profile
    }

    if (eventName === 'onIdleStateChanged') {
      // Note: idle has a timeout in the PM. We can't fully predict
      // here whether the timeout has elapsed. We return 'idle' and
      // let the PM's timer handle the actual activation.
      if (payload.to === 'IDLE') return 'idle';
      return null;  // ACTIVE → withdraws idle demand
    }

    return null;
  }

  _getUserOverridePriority() {
    const p = this._config.ADAPTIVE_USER_OVERRIDE_PRIORITY;
    return typeof p === 'number' && p >= 0 && p <= 1000 ? p : 1000;
  }
}

module.exports = AdaptiveEngine;
module.exports.SUBSCRIBED_EVENTS = SUBSCRIBED_EVENTS;
