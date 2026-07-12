'use strict';

/**
 * DynAlloc — Policy Engine :: Rule Engine
 * =======================================
 *
 * Evaluates rules against incoming events. Each rule declares:
 *
 *   {
 *     "id":           "unique-rule-id",            // required
 *     "when":         { "event": "onBatteryLow" }, // optional, defaults to any event
 *     "match":        { "app": "steam" },          // optional, evaluated against payload+state
 *     "condition":    { "AND": [ ... ] },          // optional, structured form
 *     "action":       { ... },                     // required
 *     "priority":     100,                         // optional, default 0, higher=first
 *     "cooldown":     5000,                        // optional ms, default config default
 *     "delay":        0,                           // optional ms, default 0 (no delay)
 *     "once":         false,                       // optional, fire at most once per daemon run
 *     "enabled":      true                         // optional, default true
 *   }
 *
 * The Rule Engine is purely synchronous and pure: it does not execute
 * actions itself. It returns a list of `{ rule, payload }` pairs that
 * the Policy Engine should execute. This separation lets the engine
 * apply its own timeout/self-healing/logging around action execution.
 *
 * Cooldown tracking is per-rule. "once" rules are marked fired and
 * never re-evaluated for the rest of the daemon's lifetime (unless
 * the rule is reset via `resetRule()` — typically only on hot-reload
 * of the policy file).
 *
 * Delayed rules are returned with a `delay` field. The Policy Engine
 * is responsible for scheduling the execution via setTimeout.
 *
 * Concurrency: the engine is single-threaded by design (Node event
 * loop). No locks are needed. Re-entrancy via emit-during-evaluate is
 * safe because the engine itself does not emit; it only returns
 * match results to the caller.
 */

const logger = require('../logger');
const { warn, debug } = logger;
const matcher = require('./matcher');
const { evaluate } = matcher;

/**
 * Validate and normalize a raw rule object from the policy file.
 * Throws on hard errors; returns the normalized rule on success.
 *
 * @param {object} raw
 * @param {object} defaults - { cooldownMs, executionTimeoutMs }
 * @param {number} index - rule position (for error messages)
 * @returns {object} normalized rule
 */
function normalizeRule(raw, defaults, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Rule #${index}: not an object`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`Rule #${index}: missing or invalid "id"`);
  }
  if (!raw.action || typeof raw.action !== 'object') {
    throw new Error(`Rule "${raw.id}": missing or invalid "action"`);
  }
  if (typeof raw.action.type !== 'string' || raw.action.type.length === 0) {
    throw new Error(`Rule "${raw.id}": action.type missing`);
  }

  // Determine event filter
  let eventFilter = null; // null = any event
  if (raw.when) {
    if (typeof raw.when === 'string') {
      eventFilter = raw.when;
    } else if (raw.when && typeof raw.when.event === 'string') {
      eventFilter = raw.when.event;
    } else {
      throw new Error(`Rule "${raw.id}": invalid "when" (expected string or { event: string })`);
    }
  }

  return {
    id: raw.id,
    event: eventFilter,
    match: raw.match || null,
    condition: raw.condition || null,
    action: raw.action,
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
    // Enforce a minimum cooldown for emitEvent rules to prevent
    // synchronous infinite loops (a rule that emits the same event
    // it matches on). 100ms is enough to break the cycle without
    // being noticeable in normal use.
    cooldown: _computeCooldown(raw, defaults),
    delay: typeof raw.delay === 'number' ? raw.delay : 0,
    once: !!raw.once,
    enabled: raw.enabled !== false,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

/**
 * Compute the effective cooldown for a rule. emitEvent rules get a
 * minimum 100ms cooldown to prevent synchronous infinite loops.
 */
function _computeCooldown(raw, defaults) {
  const declared = typeof raw.cooldown === 'number' ? raw.cooldown : defaults.cooldownMs;
  const isEmitEvent = raw.action && raw.action.type === 'emitEvent';
  const MIN_EMIT_EVENT_COOLDOWN = 100;
  if (isEmitEvent && declared < MIN_EMIT_EVENT_COOLDOWN) {
    return MIN_EMIT_EVENT_COOLDOWN;
  }
  return declared;
}

class RuleEngine {
  constructor(opts = {}) {
    this._rules = [];              // sorted by priority desc
    this._lastFired = new Map();   // ruleId -> timestamp ms
    this._firedOnce = new Set();   // ruleIds that have fired with once:true
    this._defaultCooldown = opts.defaultCooldownMs || 1000;
    this._maxRules = opts.maxRules || 200;
    this._stats = {
      evaluations: 0,
      matches: 0,
      suppressions: 0, // matches suppressed by cooldown/once/disabled
    };
  }

  /**
   * Replace all rules with a normalized set. Used by the loader on
   * initial load and on hot-reload.
   *
   * @param {Array<object>} rules - already-normalized rule objects
   */
  setRules(rules) {
    if (!Array.isArray(rules)) {
      throw new Error('setRules: rules must be an array');
    }
    if (rules.length > this._maxRules) {
      warn(`RuleEngine: ${rules.length} rules exceeds maxRules ${this._maxRules}, truncating`);
      rules = rules.slice(0, this._maxRules);
    }
    // Sort by priority descending, stable for equal priorities
    this._rules = rules
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        if (b.r.priority !== a.r.priority) return b.r.priority - a.r.priority;
        return a.i - b.i;
      })
      .map((x) => x.r);

    // Reset per-rule cooldown state — a hot-reload should give every
    // rule a fresh start. "once" rules that already fired stay fired
    // only if the rule id is preserved in the new set AND we are NOT
    // doing a full reload. On setRules we always reset.
    this._lastFired.clear();
    this._firedOnce.clear();
  }

  /**
   * @returns {number} current rule count
   */
  get size() {
    return this._rules.length;
  }

  /**
   * @returns {Array<object>} shallow copy of current rules
   */
  get rules() {
    return [...this._rules];
  }

  /**
   * @returns {object} cumulative evaluation statistics
   */
  get stats() {
    return { ...this._stats };
  }

  /**
   * Evaluate all rules against an incoming event. Returns an ordered
   * list of matches (by priority) that the caller should execute.
   *
   * The returned objects have shape:
   *   { rule: <ruleObject>, payload: <eventPayload>, delay: <ms> }
   *
   * Cooldown and "once" suppression are applied here. The caller is
   * responsible for actually executing actions and for honoring the
   * `delay` field.
   *
   * @param {string} eventName
   * @param {object} payload
   * @param {object} stateStore - for matcher fallback
   * @returns {Array<{rule, payload, delay}>}
   */
  evaluateEvent(eventName, payload, stateStore) {
    const matches = [];
    const now = Date.now();

    for (const rule of this._rules) {
      if (!rule.enabled) continue;

      // Event filter
      if (rule.event && rule.event !== eventName) continue;

      this._stats.evaluations++;

      // "once" suppression
      if (rule.once && this._firedOnce.has(rule.id)) {
        this._stats.suppressions++;
        continue;
      }

      // Cooldown suppression
      if (rule.cooldown > 0) {
        const last = this._lastFired.get(rule.id);
        if (last && (now - last) < rule.cooldown) {
          this._stats.suppressions++;
          continue;
        }
      }

      // Match (short form)
      if (rule.match) {
        if (!matcher.evalLeaf(rule.match, payload, stateStore)) continue;
      }

      // Condition (structured form)
      if (rule.condition) {
        if (!evaluate(rule.condition, payload, stateStore)) continue;
      }

      // Match!
      this._lastFired.set(rule.id, now);
      if (rule.once) this._firedOnce.add(rule.id);
      this._stats.matches++;

      matches.push({
        rule,
        payload,
        delay: rule.delay || 0,
      });
    }

    return matches;
  }

  /**
   * Manually mark a rule as fired (used when the caller schedules a
   * delayed execution — we want the cooldown to start from scheduling
   * time, not execution time).
   */
  markFired(ruleId) {
    this._lastFired.set(ruleId, Date.now());
  }

  /**
   * Reset cooldown/once state for a specific rule. Mainly used by tests.
   */
  resetRule(ruleId) {
    this._lastFired.delete(ruleId);
    this._firedOnce.delete(ruleId);
  }

  /**
   * Reset all cooldown/once state. Used on hot-reload.
   */
  resetAll() {
    this._lastFired.clear();
    this._firedOnce.clear();
    this._stats = { evaluations: 0, matches: 0, suppressions: 0 };
  }

  /**
   * Clear all rules. Used on shutdown / hot-reload.
   */
  clear() {
    this._rules = [];
    this.resetAll();
  }
}

module.exports = {
  RuleEngine,
  normalizeRule,
};
