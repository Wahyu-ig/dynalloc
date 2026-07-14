'use strict';

/**
 * DynAlloc — Recommendation Engine
 *
 * Generates actionable suggestions based on observed patterns
 * from the LearningEngine. Recommendations are NEVER applied
 * automatically — they always require explicit user approval.
 *
 * Recommendation types:
 *   - auto-profile: "App X is usually active at this time with Profile Y.
 *                   Create a permanent policy?"
 *   - battery-habit: "You always switch to Battery Saver below Z%.
 *                     Create a permanent policy?"
 *   - cpu-intensive: "App X consistently causes high CPU pressure.
 *                     Consider adding a pre-emptive throttle rule?"
 *   - time-based:    "You typically use Gaming apps around 19:00-22:00.
 *                     Schedule a profile switch?"
 *   - anomaly:       "Battery discharge rate is unusual. Check for
 *                     background processes?"
 *
 * v2.0: Initial release.
 */

const {
  MIN_OBSERVATIONS_FOR_RECOMMENDATION,
  STRONG_CONFIDENCE,
} = require('./learning-engine');

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum pending recommendations. */
const MAX_PENDING = 50;

/** Cooldown: don't re-suggest the same type+key within this window (ms). */
const DEFAULT_COOLDOWN_MS = 3600000; // 1 hour

// ── Recommendation Engine ──────────────────────────────────────────────

class RecommendationEngine {
  /**
   * @param {{ learningEngine: object, config?: object }} opts
   */
  constructor(opts) {
    if (!opts || !opts.learningEngine) {
      throw new Error('RecommendationEngine requires a learningEngine');
    }
    this._learning = opts.learningEngine;
    this._config = opts.config || {};

    /**
     * Pending (unapproved, undismessed) recommendations.
     * @type {Array<object>}
     */
    this._pending = [];

    /**
     * Dismissed recommendations: "type:key" → timestamp.
     * Dismissed recs won't reappear until cooldown expires.
     * @type {Map<string, number>}
     */
    this._dismissed = new Map();

    /**
     * Approved recommendations history.
     * @type {Array<{ id: string, type: string, summary: string, approvedAt: number }>}
     */
    this._approved = [];

    this._cooldownMs = this._config.LEARNING_RECOMMENDATION_COOLDOWN_MS || DEFAULT_COOLDOWN_MS;

    /** Auto-generated ID counter. */
    this._nextId = 1;
  }

  /**
   * Generate new recommendations based on current learning state.
   * Called periodically (not every tick — use LEARNING_RECOMMENDATION_INTERVAL_MS).
   *
   * @param {{ hour?: number, battery?: number, stressLevel?: string, foregroundComm?: string }} [context]
   * @returns {object[]} New recommendations generated this call.
   */
  generate(context = {}) {
    const newRecs = [];
    const hour = context.hour != null ? context.hour : new Date().getHours();

    try {
      // 1. Time-based profile suggestions
      this._checkTimeBasedProfiles(hour, newRecs);

      // 2. Battery habit patterns
      if (context.battery != null) {
        this._checkBatteryHabits(context.battery, newRecs);
      }

      // 3. CPU intensive app patterns
      if (context.foregroundComm) {
        this._checkCpuIntensiveApp(context.foregroundComm, newRecs);
      }

      // 4. App-frequency based profile suggestions
      if (context.foregroundComm) {
        this._checkAppProfilePattern(context.foregroundComm, hour, context, newRecs);
      }

      // 5. Battery anomaly detection
      this._checkBatteryAnomaly(newRecs);
    } catch (err) {
      // Never let recommendation generation crash the daemon
      // (this would be called from the learning tick)
    }

    return newRecs;
  }

  /**
   * Check for time-based profile activation patterns.
   * @private
   */
  _checkTimeBasedProfiles(hour, newRecs) {
    const patterns = this._learning.getProfilePatterns(20);
    const hourPatterns = patterns.filter(p =>
      p.count >= MIN_OBSERVATIONS_FOR_RECOMMENDATION &&
      p.trigger && p.trigger.hour === hour
    );

    // Group by profile
    const byProfile = new Map();
    for (const p of hourPatterns) {
      const key = p.profile;
      if (!byProfile.has(key)) byProfile.set(key, []);
      byProfile.get(key).push(p);
    }

    for (const [profile, entries] of byProfile) {
      const totalCount = entries.reduce((s, e) => s + e.count, 0);
      const confidence = Math.min(1, totalCount / (MIN_OBSERVATIONS_FOR_RECOMMENDATION * 3));

      if (confidence < STRONG_CONFIDENCE) continue;

      const topApp = entries.sort((a, b) => b.count - a.count)[0];
      const dedupKey = `time-profile:${profile}:${hour}`;

      if (this._isDismissed(dedupKey) || this._isPending(dedupKey)) continue;

      const rec = this._createRecommendation({
        type: 'time-based',
        key: dedupKey,
        priority: confidence > 0.9 ? 'high' : 'medium',
        summary: `You often use ${topApp.trigger.app || 'certain apps'} around ${hour}:00 with "${profile}".`,
        suggestion: `Create a time-based policy to auto-activate "${profile}" at ${hour}:00?`,
        confidence,
        data: { hour, profile, apps: entries.map(e => e.trigger.app).filter(Boolean) },
      });
      newRecs.push(rec);
    }
  }

  /**
   * Check for battery-based habit patterns.
   * @private
   */
  _checkBatteryHabits(battery, newRecs) {
    const patterns = this._learning.getProfilePatterns(20);
    const batteryPatterns = patterns.filter(p =>
      p.count >= MIN_OBSERVATIONS_FOR_RECOMMENDATION &&
      p.trigger && p.trigger.battery != null &&
      p.profile.toLowerCase().includes('battery')
    );

    for (const p of batteryPatterns) {
      const batteryBucket = p.trigger.battery;
      if (battery > batteryBucket + 10) continue; // not relevant now

      const confidence = Math.min(1, p.count / (MIN_OBSERVATIONS_FOR_RECOMMENDATION * 2));
      const dedupKey = `battery-habit:${p.profile}:${batteryBucket}`;

      if (this._isDismissed(dedupKey) || this._isPending(dedupKey)) continue;

      const rec = this._createRecommendation({
        type: 'battery-habit',
        key: dedupKey,
        priority: battery <= batteryBucket ? 'high' : 'low',
        summary: `You frequently switch to "${p.profile}" when battery is around ${batteryBucket}%.`,
        suggestion: `Create a permanent policy for "${p.profile}" at ${batteryBucket}% battery?`,
        confidence,
        data: { batteryBucket, profile: p.profile },
      });
      newRecs.push(rec);
    }
  }

  /**
   * Check if the current foreground app is consistently CPU intensive.
   * @private
   */
  _checkCpuIntensiveApp(comm, newRecs) {
    const cpuApps = this._learning.getCpuIntensiveApps(20);
    const match = cpuApps.find(a => a.comm === comm);

    if (!match || match.count < MIN_OBSERVATIONS_FOR_RECOMMENDATION) return;

    const confidence = Math.min(1, match.count / (MIN_OBSERVATIONS_FOR_RECOMMENDATION * 2));
    const dedupKey = `cpu-intensive:${comm}`;

    if (this._isDismissed(dedupKey) || this._isPending(dedupKey)) return;

    const rec = this._createRecommendation({
      type: 'cpu-intensive',
      key: dedupKey,
      priority: match.avgPressure > 50 ? 'high' : 'medium',
      summary: `"${comm}" consistently causes high CPU pressure (avg: ${match.avgPressure.toFixed(1)}%, peak: ${match.peakPressure.toFixed(1)}%).`,
      suggestion: `Consider creating a policy to proactively manage resources when "${comm}" is running?`,
      confidence,
      data: { comm, avgPressure: match.avgPressure, peakPressure: match.peakPressure, count: match.count },
    });
    newRecs.push(rec);
  }

  /**
   * Check for app-specific profile activation patterns.
   * @private
   */
  _checkAppProfilePattern(comm, hour, context, newRecs) {
    const patterns = this._learning.getProfilePatterns(20);
    const appPatterns = patterns.filter(p =>
      p.count >= MIN_OBSERVATIONS_FOR_RECOMMENDATION &&
      p.trigger && p.trigger.app === comm
    );

    for (const p of appPatterns) {
      const confidence = Math.min(1, p.count / (MIN_OBSERVATIONS_FOR_RECOMMENDATION * 2));
      const dedupKey = `auto-profile:${comm}:${p.profile}`;

      if (this._isDismissed(dedupKey) || this._isPending(dedupKey)) continue;

      const rec = this._createRecommendation({
        type: 'auto-profile',
        key: dedupKey,
        priority: confidence > 0.85 ? 'high' : 'medium',
        summary: `"${comm}" is usually associated with "${p.profile}" (${p.count} times).`,
        suggestion: `Create a policy to auto-activate "${p.profile}" when "${comm}" is detected?`,
        confidence,
        data: { comm, profile: p.profile, count: p.count, trigger: p.trigger },
      });
      newRecs.push(rec);
    }
  }

  /**
   * Check for battery discharge rate anomalies.
   * @private
   */
  _checkBatteryAnomaly(newRecs) {
    const stats = this._learning.getBatteryStats();
    if (!stats.isAnomalous || stats.samples < 5) return;

    const dedupKey = 'battery-anomaly:discharge-rate';

    if (this._isDismissed(dedupKey) || this._isPending(dedupKey)) return;

    const rec = this._createRecommendation({
      type: 'anomaly',
      key: dedupKey,
      priority: 'high',
      summary: `Battery discharge rate (${stats.avgRate}%/hr avg) is unusual compared to your baseline.`,
      suggestion: 'Check for unexpected background processes or consider enabling battery saver.',
      confidence: 0.8,
      data: { avgRate: stats.avgRate, samples: stats.samples },
    });
    newRecs.push(rec);
  }

  // ── Recommendation Lifecycle ─────────────────────────────────────

  /**
   * Create a recommendation object.
   * @private
   */
  _createRecommendation(opts) {
    const rec = {
      id: `rec-${this._nextId++}`,
      type: opts.type,
      key: opts.key,
      priority: opts.priority || 'medium',  // low | medium | high
      summary: opts.summary,
      suggestion: opts.suggestion,
      confidence: opts.confidence || 0,
      data: opts.data || {},
      createdAt: Date.now(),
      status: 'pending', // pending | approved | dismissed | expired
    };

    this._pending.push(rec);
    while (this._pending.length > MAX_PENDING) {
      const oldest = this._pending.shift();
      oldest.status = 'expired';
    }

    return rec;
  }

  /**
   * Check if a recommendation key is currently pending.
   * @private
   */
  _isPending(key) {
    return this._pending.some(r => r.key === key && r.status === 'pending');
  }

  /**
   * Check if a recommendation key was recently dismissed (within cooldown).
   * @private
   */
  _isDismissed(key) {
    const ts = this._dismissed.get(key);
    if (ts == null) return false;
    if (Date.now() - ts > this._cooldownMs) {
      this._dismissed.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Approve a recommendation by ID.
   * This does NOT apply the recommendation — it just marks it as approved
   * so the user can see it was accepted. The actual policy creation
   * is a separate manual step.
   *
   * @param {string} id
   * @returns {{ success: boolean, recommendation?: object, error?: string }}
   */
  approve(id) {
    const idx = this._pending.findIndex(r => r.id === id && r.status === 'pending');
    if (idx === -1) {
      return { success: false, error: `recommendation "${id}" not found or not pending` };
    }

    const rec = this._pending[idx];
    rec.status = 'approved';
    rec.approvedAt = Date.now();
    this._pending.splice(idx, 1);
    this._approved.push({
      id: rec.id,
      type: rec.type,
      summary: rec.summary,
      approvedAt: rec.approvedAt,
    });

    // Clean up dismissed entry if it exists
    this._dismissed.delete(rec.key);

    return { success: true, recommendation: rec };
  }

  /**
   * Dismiss a recommendation by ID.
   * @param {string} id
   * @returns {{ success: boolean, error?: string }}
   */
  dismiss(id) {
    const idx = this._pending.findIndex(r => r.id === id && r.status === 'pending');
    if (idx === -1) {
      return { success: false, error: `recommendation "${id}" not found or not pending` };
    }

    const rec = this._pending[idx];
    rec.status = 'dismissed';
    rec.dismissedAt = Date.now();
    this._pending.splice(idx, 1);
    this._dismissed.set(rec.key, Date.now());

    return { success: true };
  }

  /**
   * Get all pending recommendations.
   * @returns {object[]}
   */
  getPending() {
    return this._pending.filter(r => r.status === 'pending');
  }

  /**
   * Get all recommendations (pending + recent approved/dismissed).
   * @param {{ includeExpired?: boolean }} [opts]
   * @returns {object[]}
   */
  getAll(opts = {}) {
    const result = [...this._pending];
    if (opts.includeExpired) {
      // Also return recent approved/dismissed (last 50)
      const recent = this._approved.slice(-50).reverse().map(a => ({
        ...a, status: 'approved',
      }));
      result.push(...recent);
    }
    return result;
  }

  /**
   * Get recommendation engine status.
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: true,
      pendingCount: this._pending.filter(r => r.status === 'pending').length,
      dismissedCount: this._dismissed.size,
      approvedCount: this._approved.length,
      totalGenerated: this._nextId - 1,
    };
  }

  /**
   * Clear all recommendations and history.
   */
  clear() {
    this._pending.length = 0;
    this._dismissed.clear();
    this._approved.length = 0;
    this._nextId = 1;
  }
}

module.exports = {
  RecommendationEngine,
  MAX_PENDING,
  DEFAULT_COOLDOWN_MS,
};