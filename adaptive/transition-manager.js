'use strict';

/**
 * DynAlloc — Adaptive Layer :: Transition Manager
 * ================================================
 *
 * Provides stability guarantees for profile switching:
 *
 *   - Debouncing: rapid event bursts are coalesced into one transition.
 *   - Cooldowns: minimum dwell time per profile (prevents flicker).
 *   - Transition validation: rejects invalid transitions.
 *   - Oscillation detection: A→B→A→B within a window → suppress.
 *   - Transition history: bounded audit trail for debugging.
 *   - Rollback coordination: if activation fails, restore previous.
 *
 * The TransitionManager is PURELY about transition governance — it
 * does NOT decide WHICH profile to activate (that's the ProfileManager's
 * job). It only decides WHETHER a transition should proceed.
 *
 * API:
 *
 *   const tm = new TransitionManager({ config, logger, metrics });
 *   tm.setup();
 *
 *   // Before activating a profile, ask the TM if it's allowed:
 *   const decision = tm.evaluateTransition({ from: 'balanced', to: 'gaming', reason: 'workload-GAME' });
 *   if (decision.allowed) {
 *     // proceed with activation
 *     tm.recordTransition({ from, to, success: true, durationMs: 12 });
 *   } else {
 *     // suppressed — log the reason
 *     tm.recordSuppression(decision);
 *   }
 *
 *   // On activation failure:
 *   tm.recordTransition({ from, to, success: false, error: '...' });
 *   // TM will allow the next transition to restore 'from'.
 *
 * Backward compatibility: only constructed when ENABLE_ADAPTIVE_SWITCHING
 * is true.
 */

const logger = require('../logger');
const { debug, info, warn } = logger;

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_COOLDOWN_MS = 1000;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_OSCILLATION_WINDOW_MS = 10000;
const DEFAULT_OSCILLATION_THRESHOLD = 5;  // 5 reversions within window = oscillation

// ── TransitionManager class ──────────────────────────────────────────

class TransitionManager {
  /**
   * @param {object} opts
   * @param {object} opts.config   - main CONFIG
   * @param {object} [opts.metrics] - metrics registry (may be null)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('TransitionManager: opts.config is required');
    }
    this._config = opts.config;
    this._metrics = opts.metrics || null;

    // Pending debounce timer + the transition it represents
    this._debounceTimer = null;
    this._pendingTransition = null;

    // Cooldown tracking
    this._lastTransitionAt = 0;
    this._lastProfileId = null;

    // Transition history (bounded ring buffer)
    this._history = [];
    this._historyIdx = 0;

    // Oscillation detection: array of { profileId, timestamp } within window
    this._recentTransitions = [];

    // Suppression tracking (for metrics + logging)
    this._suppressionCount = 0;

    // Rollback flag: when true, the next transition is allowed even
    // during cooldown (because it's a rollback from a failed activation).
    this._rollbackPending = false;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Evaluate whether a transition should proceed.
   *
   * @param {object} transition - { from, to, reason, isRollback?, isUserOverride? }
   * @returns {{ allowed: boolean, reason: string, suppressUntil?: number }}
   */
  evaluateTransition(transition) {
    if (!transition || typeof transition !== 'object') {
      return { allowed: false, reason: 'invalid transition object' };
    }

    const { from, to, isRollback, isUserOverride } = transition;

    // Same-profile transitions are always suppressed (no-op)
    if (from === to && !isRollback) {
      return { allowed: false, reason: 'same-profile (no-op)' };
    }

    // Rollbacks always proceed (even during cooldown)
    if (isRollback) {
      this._rollbackPending = false;
      return { allowed: true, reason: 'rollback' };
    }

    // User overrides bypass cooldown + oscillation checks (they're explicit)
    if (isUserOverride) {
      return { allowed: true, reason: 'user-override' };
    }

    // Cooldown check: don't switch too rapidly
    const cooldownMs = this._getCooldownMs();
    const now = Date.now();
    const elapsed = now - this._lastTransitionAt;
    if (cooldownMs > 0 && elapsed < cooldownMs) {
      this._suppressionCount++;
      return {
        allowed: false,
        reason: `cooldown (${cooldownMs - elapsed}ms remaining)`,
      };
    }

    // Oscillation check: if we've seen too many reversions in the window,
    // suppress all transitions until the window expires.
    const oscillation = this._detectOscillation(to, now);
    if (oscillation.detected) {
      this._suppressionCount++;
      return {
        allowed: false,
        reason: `oscillation detected (${oscillation.count} reversions in ${oscillation.windowMs}ms)`,
        suppressUntil: oscillation.suppressUntil,
      };
    }

    return { allowed: true, reason: 'ok' };
  }

  /**
   * Record a completed transition (success or failure).
   *
   * @param {object} record - { from, to, success, durationMs?, error?, reason? }
   */
  recordTransition(record) {
    if (!record || typeof record !== 'object') return;

    const entry = {
      timestamp: Date.now(),
      from: record.from || null,
      to: record.to || null,
      success: record.success !== false,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      error: record.error || null,
      reason: record.reason || null,
    };

    // Add to bounded history (ring buffer)
    const maxHistory = this._getMaxHistory();
    if (this._history.length < maxHistory) {
      // Still filling the buffer — append
      this._history.push(entry);
      this._historyIdx = this._history.length % maxHistory;
    } else {
      // Buffer full — overwrite at ring index
      this._history[this._historyIdx] = entry;
      this._historyIdx = (this._historyIdx + 1) % maxHistory;
    }

    // Update cooldown tracking
    this._lastTransitionAt = entry.timestamp;
    this._lastProfileId = entry.to;

    // Add to recent transitions for oscillation detection
    this._recentTransitions.push({ profileId: entry.to, timestamp: entry.timestamp });
    this._pruneRecentTransitions(entry.timestamp);

    // If the transition failed, set rollbackPending so the next
    // transition (which should be the rollback) bypasses cooldown.
    if (!entry.success) {
      this._rollbackPending = true;
      warn(`TransitionManager: transition ${entry.from} → ${entry.to} FAILED (${entry.error}) — rollback pending`);
    } else {
      debug(`TransitionManager: ${entry.from} → ${entry.to} (${entry.durationMs}ms, reason: ${entry.reason})`);
    }

    // Update metrics
    if (this._metrics) {
      try {
        this._metrics.counter('profile_transitions').increment();
        if (entry.success) {
          this._metrics.counter('profile_transitions_succeeded').increment();
        } else {
          this._metrics.counter('profile_transitions_failed').increment();
        }
        if (entry.durationMs > 0) {
          this._metrics.histogram('profile_transition_duration_ms').record(entry.durationMs);
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Record a suppressed transition (for metrics + logging).
   */
  recordSuppression(decision) {
    if (!decision || decision.allowed) return;
    debug(`TransitionManager: suppressed transition (${decision.reason})`);
    if (this._metrics) {
      try {
        this._metrics.counter('profile_transitions_suppressed').increment();
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Schedule a debounced transition. If another transition is requested
   * within the debounce window, the earlier one is cancelled.
   *
   * @param {Function} fn - the transition function to execute
   * @param {object} transition - the transition metadata (for logging)
   * @returns {boolean} true if scheduled, false if a previous pending was cancelled
   */
  debounceTransition(fn, transition) {
    if (typeof fn !== 'function') return false;

    // Cancel any pending debounced transition
    const hadPending = this._debounceTimer !== null;
    if (hadPending) {
      clearTimeout(this._debounceTimer);
      debug('TransitionManager: cancelled pending debounced transition');
    }

    this._pendingTransition = transition || null;
    const delay = this._getDebounceMs();

    if (delay <= 0) {
      // No debounce — execute immediately
      this._debounceTimer = null;
      this._pendingTransition = null;
      try { fn(); } catch (err) {
        warn(`TransitionManager: immediate transition threw: ${err.message}`);
      }
      return hadPending;
    }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      const t = this._pendingTransition;
      this._pendingTransition = null;
      try { fn(); } catch (err) {
        warn(`TransitionManager: debounced transition threw: ${err.message}`);
      }
    }, delay);
    if (typeof this._debounceTimer.unref === 'function') this._debounceTimer.unref();

    return hadPending;
  }

  /**
   * Cancel any pending debounced transition.
   */
  cancelDebounce() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
      this._pendingTransition = null;
    }
  }

  /**
   * Get the transition history (most recent first).
   * @param {number} [count=20] - max entries to return
   */
  getHistory(count = 20) {
    const n = Math.min(count, this._history.length);
    if (n === 0) return [];
    // Walk backwards from the most recent entry
    const out = [];
    let idx = (this._historyIdx - 1 + this._history.length) % this._history.length;
    for (let i = 0; i < n; i++) {
      const entry = this._history[idx];
      if (entry) out.push(entry);
      idx = (idx - 1 + this._history.length) % this._history.length;
      if (out.length >= this._history.length) break;
    }
    return out;
  }

  /**
   * Return a status snapshot.
   */
  getStatus() {
    return {
      lastTransitionAt: this._lastTransitionAt ? new Date(this._lastTransitionAt).toISOString() : null,
      lastProfileId: this._lastProfileId,
      rollbackPending: this._rollbackPending,
      suppressionCount: this._suppressionCount,
      historySize: this._history.length,
      pendingDebounce: this._debounceTimer !== null,
      recentTransitionsCount: this._recentTransitions.length,
    };
  }

  /**
   * Reset all state (for tests).
   */
  reset() {
    this.cancelDebounce();
    this._lastTransitionAt = 0;
    this._lastProfileId = null;
    this._history = [];
    this._historyIdx = 0;
    this._recentTransitions = [];
    this._suppressionCount = 0;
    this._rollbackPending = false;
  }

  // ── Internal ──────────────────────────────────────────────────────

  _getDebounceMs() {
    const t = this._config.ADAPTIVE_DEBOUNCE_MS;
    return typeof t === 'number' && t >= 0 && t <= 5000 ? t : DEFAULT_DEBOUNCE_MS;
  }

  _getCooldownMs() {
    const t = this._config.ADAPTIVE_COOLDOWN_MS;
    return typeof t === 'number' && t >= 0 && t <= 60000 ? t : DEFAULT_COOLDOWN_MS;
  }

  _getMaxHistory() {
    const t = this._config.ADAPTIVE_MAX_HISTORY;
    return typeof t === 'number' && t >= 10 && t <= 1000 ? t : DEFAULT_MAX_HISTORY;
  }

  _getOscillationWindowMs() {
    const t = this._config.ADAPTIVE_OSCILLATION_WINDOW_MS;
    return typeof t === 'number' && t >= 1000 && t <= 300000 ? t : DEFAULT_OSCILLATION_WINDOW_MS;
  }

  _getOscillationThreshold() {
    const t = this._config.ADAPTIVE_OSCILLATION_THRESHOLD;
    return typeof t === 'number' && t >= 3 && t <= 20 ? t : DEFAULT_OSCILLATION_THRESHOLD;
  }

  /**
   * Detect oscillation: count how many times we've switched TO a profile
   * that is the same as the profile we switched FROM N transitions ago.
   * If the count exceeds the threshold within the window, we're oscillating.
   *
   * Simplified: count transitions in the recent window. If > threshold
   * and the target profile was visited before (reversion), flag it.
   */
  _detectOscillation(targetProfileId, now) {
    const windowMs = this._getOscillationWindowMs();
    const threshold = this._getOscillationThreshold();
    this._pruneRecentTransitions(now);

    // Count how many transitions in the window switched to the SAME
    // profile as the target. If we've been here recently more than
    // threshold/2 times, we're likely oscillating.
    let visitsToTarget = 0;
    for (const t of this._recentTransitions) {
      if (t.profileId === targetProfileId) visitsToTarget++;
    }

    // If this is the 3rd+ visit to the same profile within the window,
    // we're oscillating.
    if (visitsToTarget >= Math.floor(threshold / 2)) {
      return {
        detected: true,
        count: visitsToTarget,
        windowMs,
        suppressUntil: now + windowMs,
      };
    }

    // Also check total transition count — too many transitions in a
    // window indicates instability even without exact reversion.
    if (this._recentTransitions.length >= threshold) {
      return {
        detected: true,
        count: this._recentTransitions.length,
        windowMs,
        suppressUntil: now + windowMs,
      };
    }

    return { detected: false, count: visitsToTarget, windowMs };
  }

  _pruneRecentTransitions(now) {
    const windowMs = this._getOscillationWindowMs();
    const cutoff = now - windowMs;
    this._recentTransitions = this._recentTransitions.filter((t) => t.timestamp >= cutoff);
  }
}

module.exports = TransitionManager;
module.exports.DEFAULTS = {
  DEBOUNCE_MS: DEFAULT_DEBOUNCE_MS,
  COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
  MAX_HISTORY: DEFAULT_MAX_HISTORY,
  OSCILLATION_WINDOW_MS: DEFAULT_OSCILLATION_WINDOW_MS,
  OSCILLATION_THRESHOLD: DEFAULT_OSCILLATION_THRESHOLD,
};
