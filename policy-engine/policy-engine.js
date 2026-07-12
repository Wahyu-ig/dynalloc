'use strict';

/**
 * DynAlloc — Policy Engine :: Orchestrator
 * ========================================
 *
 * The PolicyEngine class wires together the EventBus, StateStore,
 * RuleEngine, ActionExecutor, PolicyLogger, and PolicyLoader into a
 * single cohesive subsystem.
 *
 * Lifecycle:
 *   const engine = new PolicyEngine({ actuator, governor, scheduler, config });
 *   await engine.start();   // loads policies, subscribes to bus
 *   engine.emit('onBatteryLow', { level: 15 });  // called by daemon hooks
 *   await engine.stop();    // unsubscribes, closes log files
 *
 * The engine subscribes to the bus on its own behalf — it listens to
 * EVERY event (via wildcard) and runs the RuleEngine on each. This
 * means the daemon only needs to emit events; it never calls the
 * rule engine directly.
 *
 * Action execution flow:
 *   1. Daemon emits event on the bus (via `engine.emit()` or directly).
 *   2. Engine's wildcard listener fires.
 *   3. RuleEngine.evaluateEvent(eventName, payload, stateStore) returns matches.
 *   4. For each match, the engine:
 *      a. If delay > 0, schedule via setTimeout; mark rule fired now.
 *      b. Otherwise, call ActionExecutor.execute(action, ctx) immediately.
 *      c. Build an audit record and pass it to PolicyLogger.log().
 *      d. Update metrics counters.
 *
 * Self-healing:
 *   - The ActionExecutor never throws and applies rollback on failure.
 *   - The engine wraps every action call in try/catch as a second
 *     line of defense — a throw is logged but never propagates.
 *   - Delayed actions whose rule is later disabled (via hot-reload)
 *     are still fired (we cannot cancel a setTimeout cleanly without
 *     tracking each one — see _cancelPending below).
 *
 * Performance:
 *   - The wildcard listener is the only persistent listener. Each
 *     event triggers one RuleEngine pass (O(rules) per event).
 *   - No timers other than those needed for delayed rules.
 *   - No polling — the engine is purely event-driven.
 *
 * Backward compatibility: this module is only required when
 * ENABLE_POLICY_ENGINE is true. The daemon never imports it directly
 * — it goes through index.js.
 */

const logger = require('../logger');
const { info, warn, debug } = logger;
const { EventBus, EVENTS, getEventBus, resetEventBus } = require('./event-bus');
const { StateStore, getStateStore, resetStateStore } = require('./state-store');
const { RuleEngine } = require('./rule-engine');
const { ActionExecutor } = require('./action-executor');
const { PolicyLogger } = require('./policy-logger');
const { PolicyLoader } = require('./policy-loader');

class PolicyEngine {
  /**
   * @param {object} deps
   * @param {object} deps.actuator       - Actuator instance
   * @param {object} deps.governor       - GovernorManager instance (may be null)
   * @param {object} deps.scheduler      - Scheduler instance
   * @param {object} deps.config         - current CONFIG object (will be mutated by setSchedulerMode action)
   * @param {object} deps.metrics        - main metrics registry (may be null)
   * @param {boolean} [deps.ownBus]      - if true (default), create an isolated bus instead of using the singleton. Use false to share the global bus.
   */
  constructor(deps) {
    this._deps = deps;
    this._config = deps.config;
    this._metrics = deps.metrics || null;

    // Use own bus by default to keep policy engine state isolated
    // from any future direct bus consumers. The daemon accesses the
    // bus via engine.bus (so it can emit events).
    this._bus = deps.ownBus === false ? getEventBus() : new EventBus();

    this._state = new StateStore(256);
    this._ruleEngine = new RuleEngine({
      defaultCooldownMs: this._config.POLICY_DEFAULT_COOLDOWN_MS || 1000,
      maxRules: this._config.POLICY_MAX_RULES || 200,
    });
    this._executor = new ActionExecutor({
      actuator: deps.actuator,
      governor: deps.governor,
      scheduler: deps.scheduler,
      config: this._config,
      eventBus: this._bus,
      stateStore: this._state,
      profiles: {},
      timeoutMs: this._config.POLICY_EXECUTION_TIMEOUT_MS || 5000,
    });
    this._policyLogger = new PolicyLogger({
      filePath: this._config.POLICY_LOG_FILE_PATH || null,
      maxSizeMb: this._config.POLICY_LOG_MAX_SIZE_MB || 5,
      maxFiles: this._config.POLICY_LOG_MAX_FILES || 3,
      ringBufferSize: 500,
    });

    this._loader = null;
    this._wildcardListenerId = -1;
    this._startedAt = null;
    this._pendingDelays = new Set(); // setTimeout handles for delayed rules
    this._destroyed = false;

    // Bind the wildcard listener so we can remove it on stop()
    this._wildcardHandler = this._onAnyEvent.bind(this);
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Bootstrap the engine: subscribe to the bus, load policies, emit
   * the onPolicyEngineStarted event.
   *
   * Order matters: subscribe to the bus BEFORE loading the policy
   * file, because the loader's onReload callback emits
   * ON_POLICY_ENGINE_RELOADED — we want that event to be observable
   * by user listeners on the very first load too.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._destroyed) throw new Error('PolicyEngine: cannot start a destroyed engine');
    if (this._startedAt) return; // idempotent

    // 1. Subscribe to the bus as a wildcard listener with the lowest
    //    priority so user-registered listeners (e.g. plugins) fire
    //    first and can short-circuit by mutating state.
    this._wildcardListenerId = this._bus.on('*', this._wildcardHandler, { priority: -100 });

    // 2. Initialize metrics counters (best-effort, may be null)
    if (this._metrics) {
      this._metrics.counter('policy_evaluations', 'Total rule evaluations');
      this._metrics.counter('policy_matches', 'Total matched rules');
      this._metrics.counter('policy_actions_executed', 'Total actions executed');
      this._metrics.counter('policy_actions_succeeded', 'Actions that succeeded');
      this._metrics.counter('policy_actions_failed', 'Actions that failed');
      this._metrics.counter('policy_rollbacks', 'Self-healing rollbacks');
      this._metrics.gauge('policy_rule_count', 'Current rule count');
      this._metrics.gauge('policy_uptime_seconds', 'Engine uptime in seconds');
    }

    // 3. Load policy file (this also emits ON_POLICY_ENGINE_RELOADED
    //    via the onReload callback, so we needed the wildcard
    //    subscription in step 1).
    this._loader = new PolicyLoader({
      config: this._config,
      defaults: {
        cooldownMs: this._config.POLICY_DEFAULT_COOLDOWN_MS || 1000,
        executionTimeoutMs: this._config.POLICY_EXECUTION_TIMEOUT_MS || 5000,
      },
      onReload: (policy) => this._applyLoadedPolicy(policy),
    });
    this._loader.load();
    this._loader.startWatch();

    this._startedAt = Date.now();
    info(`PolicyEngine started: ${this._ruleEngine.size} rule(s), ` +
         `${Object.keys(this._executor._profiles).length} profile(s)`);

    this._bus.emit(EVENTS.ON_POLICY_ENGINE_STARTED, {
      rules: this._ruleEngine.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Shut down the engine: cancel pending delayed actions, unsubscribe
   * from the bus, close the policy log file.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._startedAt) return;
    this._bus.emit(EVENTS.ON_POLICY_ENGINE_STOPPED, {
      timestamp: new Date().toISOString(),
    });

    // Cancel any pending delayed actions
    for (const handle of this._pendingDelays) {
      clearTimeout(handle);
    }
    this._pendingDelays.clear();

    // Stop file watcher
    if (this._loader) {
      this._loader.stopWatch();
      this._loader = null;
    }

    // Unsubscribe
    if (this._wildcardListenerId > 0) {
      this._bus.off(this._wildcardListenerId);
      this._wildcardListenerId = -1;
    }

    // Close audit log
    await new Promise((resolve) => {
      this._policyLogger.close(() => resolve());
    });

    this._startedAt = null;
    info('PolicyEngine stopped');
  }

  /**
   * Destroy the engine permanently. After destroy, the engine cannot
   * be restarted. Used by tests and on daemon shutdown.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    // Synchronous stop path (no await needed since we tear down anyway)
    if (this._loader) this._loader.stopWatch();
    if (this._wildcardListenerId > 0) {
      this._bus.off(this._wildcardListenerId);
      this._wildcardListenerId = -1;
    }
    for (const handle of this._pendingDelays) clearTimeout(handle);
    this._pendingDelays.clear();
    this._policyLogger.close();
    this._bus.destroy();
    this._state.clear();
    this._ruleEngine.clear();
  }

  /**
   * Emit an event on the bus. This is the primary entry point for
   * the daemon and other producers.
   *
   * @param {string} eventName
   * @param {*} [payload]
   */
  emit(eventName, payload) {
    if (this._destroyed) return;
    this._bus.emit(eventName, payload);
  }

  /**
   * Update the state store. Producers should call this BEFORE emitting
   * the event so that rule matchers see fresh state.
   *
   * @param {string} key - dot-path
   * @param {*} value
   */
  setState(key, value) {
    this._state.set(key, value);
  }

  /**
   * Read a value from the state store. Mainly for tests/diagnostics.
   */
  getState(key, defaultValue) {
    return this._state.get(key, defaultValue);
  }

  /**
   * Expose the bus so plugins and other modules can subscribe
   * (read-only — they should not emit directly).
   */
  get bus() {
    return this._bus;
  }

  /**
   * Expose the rule engine (for tests/diagnostics).
   */
  get ruleEngine() {
    return this._ruleEngine;
  }

  /**
   * Expose the action executor (for tests/diagnostics).
   */
  get executor() {
    return this._executor;
  }

  /**
   * Expose the policy logger (for tests/diagnostics).
   */
  get policyLogger() {
    return this._policyLogger;
  }

  /**
   * Expose the state store (for tests/diagnostics).
   */
  get stateStore() {
    return this._state;
  }

  /**
   * Expose the resolved policy file path (or null if no file was found).
   */
  get filePath() {
    return this._loader ? this._loader.filePath : null;
  }

  /**
   * @returns {boolean} whether the engine is currently running
   */
  get isRunning() {
    return !!this._startedAt && !this._destroyed;
  }

  /**
   * @returns {object} engine status snapshot
   */
  getStatus() {
    return {
      running: this.isRunning,
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : null,
      uptimeSeconds: this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : 0,
      ruleCount: this._ruleEngine.size,
      policyFile: this._loader ? this._loader.filePath : null,
      ruleEngineStats: this._ruleEngine.stats,
      executorStats: this._executor.stats,
      loggerStats: this._policyLogger.stats,
      recentExecutions: this._policyLogger.recentEntries(10),
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  /**
   * Apply a freshly loaded/validated policy to the engine.
   * Replaces rules and profiles atomically.
   */
  _applyLoadedPolicy(policy) {
    if (!policy || !Array.isArray(policy.rules)) return;
    this._ruleEngine.setRules(policy.rules);
    this._executor.setProfiles(policy.profiles || {});
    if (this._metrics) {
      this._metrics.gauge('policy_rule_count').set(this._ruleEngine.size);
    }
    this._bus.emit(EVENTS.ON_POLICY_ENGINE_RELOADED, {
      rules: this._ruleEngine.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Wildcard listener — fires on every event. Runs the rule engine
   * and dispatches any matching actions.
   */
  _onAnyEvent(eventName, payload) {
    if (this._destroyed) return;

    let matches;
    try {
      matches = this._ruleEngine.evaluateEvent(eventName, payload, this._state);
    } catch (err) {
      warn(`PolicyEngine: rule evaluation threw for "${eventName}": ${err.message}`);
      return;
    }

    if (this._metrics) {
      // BUG FIX (v2.1.1): Previously this incremented by
      // `this._ruleEngine.stats.evaluations`, which is a CUMULATIVE
      // counter across all events. After N events the metrics counter
      // showed ~N*(N+1)/2 instead of N. Increment by 1 per event
      // instead — the cumulative evaluation count is still available
      // via `ruleEngineStats.evaluations` in getStatus().
      this._metrics.counter('policy_evaluations').increment(1);
      this._metrics.counter('policy_matches').increment(matches.length);
    }

    for (const match of matches) {
      this._executeMatch(eventName, payload, match);
    }
  }

  /**
   * Execute a single rule match, either immediately or after the
   * declared delay. Records an audit entry regardless of outcome.
   */
  _executeMatch(eventName, payload, match) {
    const { rule, delay } = match;

    // Mark cooldown NOW so concurrent events of the same type don't
    // re-fire the rule during its delay window.
    if (delay > 0) {
      this._ruleEngine.markFired(rule.id);
      const handle = setTimeout(() => {
        this._pendingDelays.delete(handle);
        this._runAction(eventName, payload, rule);
      }, delay);
      // unref so the timer doesn't keep the event loop alive on shutdown
      if (typeof handle.unref === 'function') handle.unref();
      this._pendingDelays.add(handle);
      return;
    }

    this._runAction(eventName, payload, rule);
  }

  /**
   * Actually invoke the action executor for a rule and write the
   * audit record. Wrapped in try/catch as a defense-in-depth — even
   * if the audit log or metrics throw, the daemon must not crash.
   */
  async _runAction(eventName, payload, rule) {
    const start = Date.now();
    let result = { success: false, error: 'unknown', rollbackApplied: false, snapshot: null };

    try {
      result = await this._executor.execute(rule.action, {
        triggerEvent: eventName,
        triggerPayload: payload,
        ruleId: rule.id,
      });
    } catch (err) {
      // This should never happen — the executor catches internally.
      // But if it does, we still record an audit entry.
      result = {
        success: false,
        error: err && err.message ? err.message : String(err),
        rollbackApplied: false,
        snapshot: null,
      };
    }

    const elapsed = Date.now() - start;

    // Audit log + metrics — wrapped to prevent any audit-side failure
    // from propagating as an unhandled rejection (which would crash
    // the daemon via the unhandledRejection handler).
    try {
      this._policyLogger.log({
        timestamp: new Date().toISOString(),
        trigger: eventName,
        triggerPayload: payload,
        ruleId: rule.id,
        matchedFields: this._extractMatchedFields(rule, payload),
        action: rule.action,
        executionTimeMs: elapsed,
        success: result.success,
        error: result.error,
        rollbackApplied: result.rollbackApplied,
      });

      if (this._metrics) {
        this._metrics.counter('policy_actions_executed').increment();
        if (result.success) {
          this._metrics.counter('policy_actions_succeeded').increment();
        } else {
          this._metrics.counter('policy_actions_failed').increment();
          if (result.rollbackApplied) {
            this._metrics.counter('policy_rollbacks').increment();
          }
        }
      }
    } catch (err) {
      try { warn(`PolicyEngine audit/metrics error for rule "${rule.id}": ${err.message}`); }
      catch (_) { /* swallow — never propagate */ }
    }
  }

  /**
   * Best-effort extraction of which fields the rule matched against.
   * Used to populate the audit log for debugging.
   *
   * Field resolution order matches the matcher: payload first, then
   * state store. This ensures the audit log shows the same value
   * the matcher actually saw.
   */
  _extractMatchedFields(rule, payload) {
    const out = {};
    if (rule.match && typeof rule.match === 'object') {
      const matcherMod = require('./matcher');
      for (const key of Object.keys(rule.match)) {
        const val = matcherMod.resolveField(key, payload, this._state);
        if (val !== undefined) out[key] = val;
      }
    }
    return out;
  }
}

module.exports = {
  PolicyEngine,
  EVENTS,
  // Re-export for convenience
  getEventBus,
  resetEventBus,
  getStateStore,
  resetStateStore,
};
