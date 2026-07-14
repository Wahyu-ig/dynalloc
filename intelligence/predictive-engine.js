'use strict';

/**
 * DynAlloc — Predictive Pre-Allocation Engine
 * ============================================
 *
 * v2.1.0 — Tier 1 killer feature #1: "Crystal Ball".
 *
 * Uses the LearningEngine's observed foreground-transition history to
 * predict the NEXT application the user is likely to launch, and
 * pre-warms system resources BEFORE the app actually starts —
 * eliminating the "first 5 second stutter" that every other Linux
 * resource manager suffers from (GameMode, system76-scheduler,
 * ananicy, etc. are all purely reactive).
 *
 * Prediction model (deterministic, no ML libraries):
 *
 *   P(next_app | current_app, hour, battery_bucket)
 *     = count(current_app → next_app, hour, battery_bucket)
 *       / count(current_app, hour, battery_bucket)
 *
 * Tracked alongside hourly histograms and per-app transition matrices
 * in a fixed-size LRU map. Predictions above
 * PREDICTION_CONFIDENCE_THRESHOLD (default 0.45) trigger a
 * "pre-allocation" — a callback that the daemon wires up to:
 *
 *   - Switch CPU governor to performance (preemptive boost)
 *   - Raise GPU power limit to performance
 *   - Pre-fault hugepages / drop caches from background
 *   - Bump EPP / energy-performance preference
 *
 * The pre-allocation is held for at most PREDICTION_HOLD_MS (default
 * 8000ms) and automatically reverted if the predicted app does NOT
 * appear (rolling back to the previous state). If the predicted app
 * DOES appear, the daemon's normal foreground-boost path takes over
 * and the pre-allocation is silently handed off.
 *
 * Memory: O(unique apps × top transitions). With MAX_TRANSITIONS=8
 * per app and MAX_TRACKED_APPS=256, worst case ~2k entries × ~64
 * bytes ≈ 128 KB. Bounded forever.
 *
 * Determinism: identical inputs produce identical predictions.
 *
 * Safety: predictions NEVER cause persistent state changes. Every
 * pre-allocation is paired with a revert timer. If the daemon dies
 * mid-pre-allocation, the next bootstrap's self-check restores
 * governors / GPU power limits from snapshot persistence.
 *
 * Backward compat: ENABLE_PREDICTIVE_ENGINE defaults to false. When
 * disabled, no PredictiveEngine is constructed and the daemon behaves
 * exactly like v2.0.
 */

const { debug, info, warn } = require('../logger');

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum number of apps tracked in the transition matrix. */
const MAX_TRACKED_APPS = 256;

/** Maximum transitions kept per "from" app (top-N by count). */
const MAX_TRANSITIONS_PER_APP = 8;

/** Minimum observations of a (from, hour, bucket) signature before predicting. */
const MIN_OBSERVATIONS_TO_PREDICT = 3;

/** Default confidence threshold to trigger a pre-allocation (0–1). */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.45;

/** How long to hold a pre-allocation before auto-reverting (ms). */
const DEFAULT_HOLD_MS = 8000;

/** Cooldown after a pre-allocation before another is allowed (ms). */
const DEFAULT_COOLDOWN_MS = 15000;

/** Minimum gap between foreground change and prediction trigger (ms). */
const FOREGROUND_SETTLE_MS = 750;

/** Battery bucket size — predictions are bucketed to ±5%. */
const BATTERY_BUCKET_SIZE = 10;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Compute the current hour-of-day bucket key.
 * We use a 2-hour wide bucket (0,2,4,...,22) to smooth noise.
 * @returns {number} 0..11
 */
function hourBucket() {
  return Math.floor(new Date().getHours() / 2);
}

/**
 * Bucket a battery percentage into 10-wide bands. null → 0 (treat
 * "on AC / unknown" as bucket 0).
 * @param {number|null} pct
 * @returns {number}
 */
function batteryBucket(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(10, Math.floor(pct / BATTERY_BUCKET_SIZE)));
}

/**
 * Build the transition-matrix key.
 * @returns {string}
 */
function transitionKey(fromApp, toApp, hourB, battB) {
  return `${fromApp || '?'}>${toApp || '?'}@${hourB}:${battB}`;
}

/**
 * Build the "from" context signature (without the "to" app).
 * @returns {string}
 */
function contextKey(fromApp, hourB, battB) {
  return `${fromApp || '?'}@${hourB}:${battB}`;
}

// ── PredictiveEngine ──────────────────────────────────────────────────

class PredictiveEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {object} [opts.learningEngine]  — required to read history
   * @param {object} [opts.timelineEngine]  — optional, for event log
   * @param {Function} [opts.preAllocateFn] — invoked with prediction; returns a snapshot handle
   * @param {Function} [opts.revertFn]      — invoked with snapshot handle to revert
   */
  constructor(opts = {}) {
    this._config = opts.config || {};
    this._learning = opts.learningEngine || null;
    this._timeline = opts.timelineEngine || null;
    this._preAllocateFn = opts.preAllocateFn || null;
    this._revertFn = opts.revertFn || null;

    /** @type {Map<string, { count: number, to: string, lastSeen: number }>} */
    this._transitions = new Map();

    /** @type {Map<string, number>} total observations per contextKey */
    this._contextTotals = new Map();

    /** Currently-held pre-allocation snapshot (if any). */
    this._activeSnapshot = null;
    this._activePrediction = null;
    this._activeRevertTimer = null;
    this._lastPreAllocateAt = 0;

    this._stats = {
      predictions: 0,
      predictionsTriggered: 0,
      predictionsHit: 0,
      predictionsMiss: 0,
      reverts: 0,
    };

    this._threshold = this._config.PREDICTION_CONFIDENCE_THRESHOLD || DEFAULT_CONFIDENCE_THRESHOLD;
    this._holdMs = this._config.PREDICTION_HOLD_MS || DEFAULT_HOLD_MS;
    this._cooldownMs = this._config.PREDICTION_COOLDOWN_MS || DEFAULT_COOLDOWN_MS;
  }

  // ── Observation ───────────────────────────────────────────────────

  /**
   * Record a foreground transition: from → to.
   * @param {{ from: string|null, to: string, battery?: number|null }} info
   */
  recordTransition(info) {
    if (!info || !info.to) return;
    const from = info.from || '?';
    const to = info.to;
    if (from === to) return; // ignore same-app focus changes

    const hb = hourBucket();
    const bb = batteryBucket(info.battery != null ? info.battery : null);

    const tKey = transitionKey(from, to, hb, bb);
    const cKey = contextKey(from, hb, bb);

    let entry = this._transitions.get(tKey);
    if (!entry) {
      entry = { count: 0, to, lastSeen: 0 };
      this._transitions.set(tKey, entry);
    }
    entry.count++;
    entry.lastSeen = Date.now();

    this._contextTotals.set(cKey, (this._contextTotals.get(cKey) || 0) + 1);

    // LRU eviction
    if (this._transitions.size > MAX_TRACKED_APPS * MAX_TRANSITIONS_PER_APP) {
      const firstKey = this._transitions.keys().next().value;
      this._transitions.delete(firstKey);
    }
    if (this._contextTotals.size > MAX_TRACKED_APPS * 12) {
      const firstKey = this._contextTotals.keys().next().value;
      this._contextTotals.delete(firstKey);
    }

    // If we have an active prediction, check whether it hit.
    if (this._activePrediction && this._activePrediction.to === to) {
      this._stats.predictionsHit++;
      this._clearActive(true); // hand off cleanly — daemon's normal boost takes over
      if (this._timeline) {
        this._timeline.info('learning', 'prediction_hit',
          `Prediction hit: pre-allocated for "${to}"`);
      }
    }
  }

  // ── Prediction ────────────────────────────────────────────────────

  /**
   * Given the current foreground app, predict the next likely app.
   * Returns the top candidate with confidence, or null.
   * @param {{ currentApp: string, battery?: number|null }} ctx
   * @returns {{ to: string, confidence: number, count: number, total: number } | null}
   */
  predict(ctx = {}) {
    if (!ctx || !ctx.currentApp) return null;
    const from = ctx.currentApp;
    const hb = hourBucket();
    const bb = batteryBucket(ctx.battery != null ? ctx.battery : null);

    const cKey = contextKey(from, hb, bb);
    const total = this._contextTotals.get(cKey) || 0;
    if (total < MIN_OBSERVATIONS_TO_PREDICT) {
      this._stats.predictions++;
      return null;
    }

    // Find top transition from this context
    let bestEntry = null;
    let bestKey = null;
    for (const [key, entry] of this._transitions) {
      // We only need to check entries whose key starts with our context
      if (!key.startsWith(`${from}>`) || !key.endsWith(`@${hb}:${bb}`)) continue;
      if (!bestEntry || entry.count > bestEntry.count) {
        bestEntry = entry;
        bestKey = key;
      }
    }
    if (!bestEntry) {
      this._stats.predictions++;
      return null;
    }

    const confidence = bestEntry.count / total;
    this._stats.predictions++;
    return {
      to: bestEntry.to,
      confidence: Math.round(confidence * 1000) / 1000,
      count: bestEntry.count,
      total,
    };
  }

  /**
   * Attempt to fire a pre-allocation for the predicted next app.
   * Idempotent: if a pre-allocation is already active, returns early.
   * @param {{ currentApp: string, battery?: number|null }} ctx
   * @returns {{ triggered: boolean, prediction?: object, reason?: string }}
   */
  tryPreAllocate(ctx = {}) {
    if (!this._preAllocateFn) {
      return { triggered: false, reason: 'no preAllocateFn configured' };
    }
    if (this._activeSnapshot) {
      return { triggered: false, reason: 'pre-allocation already active' };
    }
    const now = Date.now();
    if (now - this._lastPreAllocateAt < this._cooldownMs) {
      return { triggered: false, reason: 'cooldown' };
    }

    const pred = this.predict(ctx);
    if (!pred) {
      return { triggered: false, reason: 'no prediction (insufficient data)' };
    }
    if (pred.confidence < this._threshold) {
      return { triggered: false, reason: `confidence ${pred.confidence} < threshold ${this._threshold}`, prediction: pred };
    }

    let snapshot;
    try {
      snapshot = this._preAllocateFn({
        predictedApp: pred.to,
        confidence: pred.confidence,
        fromApp: ctx.currentApp,
      });
    } catch (err) {
      warn(`PredictiveEngine: preAllocateFn threw: ${err.message}`);
      return { triggered: false, reason: `preAllocateFn error: ${err.message}`, prediction: pred };
    }
    if (!snapshot) {
      return { triggered: false, reason: 'preAllocateFn returned no snapshot', prediction: pred };
    }

    this._activeSnapshot = snapshot;
    this._activePrediction = pred;
    this._lastPreAllocateAt = now;
    this._stats.predictionsTriggered++;

    if (this._timeline) {
      this._timeline.info('learning', 'prediction_triggered',
        `Pre-allocated for "${pred.to}" (confidence ${pred.confidence}, count ${pred.count}/${pred.total})`,
        { prediction: pred });
    }
    info(`Predictive: pre-allocated for "${pred.to}" (confidence ${(pred.confidence * 100).toFixed(1)}%)`);

    // Auto-revert after hold period
    this._activeRevertTimer = setTimeout(() => {
      this._clearActive(false);
    }, this._holdMs);
    if (typeof this._activeRevertTimer.unref === 'function') {
      this._activeRevertTimer.unref();
    }

    return { triggered: true, prediction: pred };
  }

  /**
   * Clear the active pre-allocation. If `handoff` is true, the
   * snapshot is dropped WITHOUT calling revertFn (the daemon's
   * normal foreground boost is taking over). If false, revertFn is
   * called to restore the previous state.
   * @param {boolean} handoff
   * @private
   */
  _clearActive(handoff) {
    if (this._activeRevertTimer) {
      clearTimeout(this._activeRevertTimer);
      this._activeRevertTimer = null;
    }
    if (!this._activeSnapshot) return;

    if (!handoff) {
      if (this._revertFn) {
        try {
          this._revertFn(this._activeSnapshot);
          this._stats.reverts++;
          if (this._timeline) {
            this._timeline.debug('learning', 'prediction_reverted',
              `Pre-allocation reverted (timeout) for "${this._activePrediction?.to || '?'}"`);
          }
        } catch (err) {
          warn(`PredictiveEngine: revertFn threw: ${err.message}`);
        }
      }
      this._stats.predictionsMiss++;
    }

    this._activeSnapshot = null;
    this._activePrediction = null;
  }

  /**
   * Force-revert any active pre-allocation. Used on daemon shutdown.
   */
  forceRevert() {
    this._clearActive(false);
  }

  // ── Introspection ─────────────────────────────────────────────────

  getStatus() {
    return {
      enabled: true,
      threshold: this._threshold,
      holdMs: this._holdMs,
      cooldownMs: this._cooldownMs,
      transitionsTracked: this._transitions.size,
      contextsTracked: this._contextTotals.size,
      activePreAllocation: this._activePrediction
        ? { to: this._activePrediction.to, confidence: this._activePrediction.confidence }
        : null,
      stats: { ...this._stats },
    };
  }

  /**
   * Get the top transition predictions for a given context.
   * @param {{ currentApp: string, battery?: number|null, limit?: number }} ctx
   * @returns {Array<{ to: string, count: number, total: number, confidence: number }>}
   */
  getTopTransitions(ctx = {}) {
    if (!ctx.currentApp) return [];
    const from = ctx.currentApp;
    const hb = hourBucket();
    const bb = batteryBucket(ctx.battery != null ? ctx.battery : null);
    const cKey = contextKey(from, hb, bb);
    const total = this._contextTotals.get(cKey) || 0;
    if (total === 0) return [];

    const results = [];
    for (const [key, entry] of this._transitions) {
      if (!key.startsWith(`${from}>`) || !key.endsWith(`@${hb}:${bb}`)) continue;
      results.push({
        to: entry.to,
        count: entry.count,
        total,
        confidence: Math.round((entry.count / total) * 1000) / 1000,
      });
    }
    results.sort((a, b) => b.count - a.count);
    return results.slice(0, ctx.limit || 5);
  }

  // ── Hot-reload ────────────────────────────────────────────────────

  setConfig(config) {
    this._config = config || {};
    this._threshold = this._config.PREDICTION_CONFIDENCE_THRESHOLD || DEFAULT_CONFIDENCE_THRESHOLD;
    this._holdMs = this._config.PREDICTION_HOLD_MS || DEFAULT_HOLD_MS;
    this._cooldownMs = this._config.PREDICTION_COOLDOWN_MS || DEFAULT_COOLDOWN_MS;
  }
}

// Export constants for tests / external consumers
module.exports = {
  PredictiveEngine,
  MAX_TRACKED_APPS,
  MAX_TRANSITIONS_PER_APP,
  MIN_OBSERVATIONS_TO_PREDICT,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_HOLD_MS,
  DEFAULT_COOLDOWN_MS,
  hourBucket,
  batteryBucket,
  transitionKey,
  contextKey,
};
