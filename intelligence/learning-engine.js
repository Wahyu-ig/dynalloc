'use strict';

/**
 * DynAlloc — Intelligent Learning Engine
 *
 * Lightweight statistical learning engine that observes daemon behavior
 * and builds frequency-based profiles of:
 *   - Frequently used applications (by foreground time)
 *   - Common active hours (hour-of-day histogram)
 *   - Profile switching patterns (trigger → profile mappings)
 *   - Battery usage habits (discharge rate patterns)
 *   - CPU intensive workflows (high-pressure foreground apps)
 *   - Foreground application history (recent and long-term)
 *
 * No ML libraries — purely deterministic frequency counting,
 * time-windowed statistics, and simple heuristics.
 *
 * Memory-bounded: all internal stores have fixed max sizes.
 * The engine never blocks the event loop (O(1) or O(k) with small k).
 *
 * v2.0: Initial release.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum entries per frequency map (LRU eviction). */
const MAX_FREQ_ENTRIES = 2048;

/** Maximum timeline entries for foreground history. */
const MAX_FOREGROUND_HISTORY = 5000;

/** Maximum entries for profile switch history. */
const MAX_PROFILE_SWITCHES = 500;

/** Maximum entries for CPU intensive app tracking. */
const MAX_CPU_INTENSIVE = 256;

/** Maximum entries for battery habit tracking. */
const MAX_BATTERY_SAMPLES = 2000;

/** Maximum entries for recommendation queue. */
const MAX_RECOMMENDATIONS = 50;

/** Number of hourly buckets (0-23). */
const HOURS_IN_DAY = 24;

/** Minimum observations before making a recommendation. */
const MIN_OBSERVATIONS_FOR_RECOMMENDATION = 5;

/** Minimum confidence threshold for a strong recommendation (0-1). */
const STRONG_CONFIDENCE = 0.7;

/** Number of standard deviations for outlier detection. */
const OUTLIER_STDDEV_THRESHOLD = 1.5;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Clamp a number between min and max.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Evict oldest entries from a Map to keep it at or below maxSize.
 * Uses insertion-order (oldest first) since Map preserves insertion order.
 * @param {Map} map
 * @param {number} maxSize
 */
function evictOldest(map, maxSize) {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

/**
 * Compute mean and standard deviation of an array of numbers.
 * @param {number[]} arr
 * @returns {{ mean: number, stddev: number, count: number }}
 */
function computeStats(arr) {
  if (arr.length === 0) return { mean: 0, stddev: 0, count: 0 };
  const n = arr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    variance += d * d;
  }
  return { mean, stddev: Math.sqrt(variance / n), count: n };
}

/**
 * Get the current hour of day (0-23) in local time.
 * @returns {number}
 */
function currentHour() {
  return new Date().getHours();
}

// ── Learning Engine ────────────────────────────────────────────────────

class LearningEngine {
  /**
   * @param {{ config?: object, dataDir?: string }} [opts]
   */
  constructor(opts = {}) {
    this._config = opts.config || {};
    this._dataDir = opts.dataDir || path.join(
      os.homedir(), '.config', 'dynalloc', 'learning'
    );

    // ── Frequency stores ─────────────────────────────────────────────

    /**
     * App usage frequency: comm → { count, totalMs, lastSeen, categories: Set }
     * Tracks how often each application is in the foreground.
     * @type {Map<string, { count: number, totalMs: number, lastSeen: number, categories: Set<string> }>}
     */
    this._appFrequency = new Map();

    /**
     * Hour-of-day activity histogram: hour (0-23) → count of foreground changes.
     * @type {Int32Array}
     */
    this._hourlyActivity = new Int32Array(HOURS_IN_DAY);

    /**
     * Profile switch patterns: "triggerKey" → { profile, count, lastSeen }
     * triggerKey = JSON.stringify({ app, hour, battery, stressLevel })
     * @type {Map<string, { profile: string, count: number, lastSeen: number, trigger: object }>}
     */
    this._profilePatterns = new Map();

    /**
     * Battery usage samples: array of { ts, capacity, discharging, rate }
     * Used to learn typical discharge rates per hour.
     * @type {Array<{ ts: number, capacity: number, discharging: boolean, rate: number|null }>}
     */
    this._batterySamples = [];

    /**
     * CPU intensive app tracking: comm → { count, peakPressure, avgPressure, samples }
     * @type {Map<string, { count: number, peakPressure: number, avgPressure: number, samples: number[] }>}
     */
    this._cpuIntensiveApps = new Map();

    /**
     * Foreground history: array of { ts, pid, comm, duration? }
     * @type {Array<{ ts: number, pid: number, comm: string, duration?: number }>}
     */
    this._foregroundHistory = [];

    /**
     * Pending recommendations: array of recommendation objects.
     * @type {Array<object>}
     */
    this._recommendations = [];

    /**
     * Recommendation dedup set: "type:comm" → timestamp of last suggestion.
     * Prevents the same recommendation from being generated repeatedly.
     * @type {Map<string, number>}
     */
    this._suggestedRecently = new Map();

    /** Minimum interval between repeated suggestions (ms). */
    this._suggestionCooldownMs = (this._config.LEARNING_SUGGESTION_COOLDOWN_MS || 3600000); // 1h default

    /**
     * Profile switch history: array of { ts, from, to, reason, trigger }
     * @type {Array<{ ts: number, from: string|null, to: string, reason: string, trigger?: object }>}
     */
    this._profileSwitchHistory = [];

    // Stats
    this._totalObservations = 0;
    this._totalProfileSwitches = 0;
    this._startedAt = Date.now();

    // Try to load persisted data
    this._load();
  }

  // ── Persistence ──────────────────────────────────────────────────

  /**
   * Persist current learning state to disk.
   * Atomic write via tmp + rename.
   */
  persist() {
    try {
      const dir = this._dataDir;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        savedAt: Date.now(),
        totalObservations: this._totalObservations,
        totalProfileSwitches: this._totalProfileSwitches,
        appFrequency: this._serializeMap(this._appFrequency),
        hourlyActivity: Array.from(this._hourlyActivity),
        profilePatterns: this._serializeMap(this._profilePatterns),
        batterySamples: this._batterySamples.slice(-MAX_BATTERY_SAMPLES),
        cpuIntensiveApps: this._serializeMap(this._cpuIntensiveApps),
        foregroundHistory: this._foregroundHistory.slice(-MAX_FOREGROUND_HISTORY),
        profileSwitchHistory: this._profileSwitchHistory.slice(-MAX_PROFILE_SWITCHES),
      };

      const tmpPath = path.join(dir, 'learning-state.tmp');
      const finalPath = path.join(dir, 'learning-state.json');
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      // Non-fatal — learning data is best-effort
      debug(`LearningEngine persist error: ${err.message}`);
    }
  }

  /**
   * Load persisted learning state from disk.
   * @private
   */
  _load() {
    try {
      const filePath = path.join(this._dataDir, 'learning-state.json');
      if (!fs.existsSync(filePath)) return;

      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.version !== 1) return;

      this._totalObservations = data.totalObservations || 0;
      this._totalProfileSwitches = data.totalProfileSwitches || 0;

      if (data.appFrequency) {
        for (const [k, v] of Object.entries(data.appFrequency)) {
          v.categories = new Set(v.categories || []);
          this._appFrequency.set(k, v);
        }
      }

      if (data.hourlyActivity) {
        for (let i = 0; i < HOURS_IN_DAY && i < data.hourlyActivity.length; i++) {
          this._hourlyActivity[i] = data.hourlyActivity[i];
        }
      }

      if (data.profilePatterns) {
        for (const [k, v] of Object.entries(data.profilePatterns)) {
          this._profilePatterns.set(k, v);
        }
      }

      if (Array.isArray(data.batterySamples)) {
        this._batterySamples = data.batterySamples.slice(-MAX_BATTERY_SAMPLES);
      }

      if (data.cpuIntensiveApps) {
        for (const [k, v] of Object.entries(data.cpuIntensiveApps)) {
          this._cpuIntensiveApps.set(k, v);
        }
      }

      if (Array.isArray(data.foregroundHistory)) {
        this._foregroundHistory = data.foregroundHistory.slice(-MAX_FOREGROUND_HISTORY);
      }

      if (Array.isArray(data.profileSwitchHistory)) {
        this._profileSwitchHistory = data.profileSwitchHistory.slice(-MAX_PROFILE_SWITCHES);
      }
    } catch (_) {
      // Non-fatal — start fresh
    }
  }

  /**
   * @private
   * Serialize a Map to a plain object (categories Sets → arrays).
   */
  _serializeMap(map) {
    const obj = {};
    for (const [k, v] of map) {
      const copy = { ...v };
      if (copy.categories instanceof Set) {
        copy.categories = Array.from(copy.categories);
      }
      obj[k] = copy;
    }
    return obj;
  }

  // ── Observation Methods (called from daemon tick) ─────────────────

  /**
   * Record a foreground application change.
   * @param {{ pid: number, comm: string, schedClass?: string }} info
   * @param {{ cpuPressure?: number, memPressure?: number, stressLevel?: string, battery?: object }} context
   */
  recordForeground(info, context = {}) {
    if (!info || !info.comm) return;

    const comm = info.comm;
    const ts = Date.now();
    const hour = currentHour();

    // Record previous foreground duration if available
    if (this._foregroundHistory.length > 0) {
      const prev = this._foregroundHistory[this._foregroundHistory.length - 1];
      if (!prev.duration && prev.ts) {
        prev.duration = ts - prev.ts;
      }
    }

    // Update app frequency
    let entry = this._appFrequency.get(comm);
    if (!entry) {
      entry = { count: 0, totalMs: 0, lastSeen: 0, categories: new Set() };
      this._appFrequency.set(comm, entry);
    }
    entry.count++;
    entry.lastSeen = ts;
    if (info.schedClass) entry.categories.add(info.schedClass);
    evictOldest(this._appFrequency, MAX_FREQ_ENTRIES);

    // Update hourly activity
    this._hourlyActivity[hour]++;

    // Update foreground history
    this._foregroundHistory.push({ ts, pid: info.pid, comm });
    while (this._foregroundHistory.length > MAX_FOREGROUND_HISTORY) {
      this._foregroundHistory.shift();
    }

    // Track CPU intensive foreground apps
    const cpuP = context.cpuPressure || 0;
    if (cpuP > 15) { // significant CPU pressure while this app is foreground
      let cpuEntry = this._cpuIntensiveApps.get(comm);
      if (!cpuEntry) {
        cpuEntry = { count: 0, peakPressure: 0, avgPressure: 0, samples: [] };
        this._cpuIntensiveApps.set(comm, cpuEntry);
      }
      cpuEntry.count++;
      cpuEntry.samples.push(cpuP);
      if (cpuP > cpuEntry.peakPressure) cpuEntry.peakPressure = cpuP;
      const stats = computeStats(cpuEntry.samples);
      cpuEntry.avgPressure = stats.mean;
      // Keep only last 100 samples per app
      if (cpuEntry.samples.length > 100) cpuEntry.samples.shift();
      evictOldest(this._cpuIntensiveApps, MAX_CPU_INTENSIVE);
    }

    this._totalObservations++;
  }

  /**
   * Record a battery status sample.
   * @param {{ capacity: number, discharging: boolean }} status
   */
  recordBattery(status) {
    if (!status || typeof status.capacity !== 'number') return;

    const ts = Date.now();
    const prev = this._batterySamples.length > 0
      ? this._batterySamples[this._batterySamples.length - 1]
      : null;

    let rate = null;
    if (prev && prev.discharging && status.discharging) {
      const dtHours = (ts - prev.ts) / 3600000;
      if (dtHours > 0.001) { // avoid division by very small numbers
        rate = (prev.capacity - status.capacity) / dtHours; // %/hour
      }
    }

    this._batterySamples.push({
      ts,
      capacity: status.capacity,
      discharging: status.discharging,
      rate,
    });
    while (this._batterySamples.length > MAX_BATTERY_SAMPLES) {
      this._batterySamples.shift();
    }
  }

  /**
   * Record a profile switch event.
   * @param {{ from?: string, to: string, reason: string, trigger?: object }} info
   */
  recordProfileSwitch(info) {
    if (!info || !info.to) return;

    const ts = Date.now();

    // Record in history
    this._profileSwitchHistory.push({
      ts,
      from: info.from || null,
      to: info.to,
      reason: info.reason || '',
      trigger: info.trigger || null,
    });
    while (this._profileSwitchHistory.length > MAX_PROFILE_SWITCHES) {
      this._profileSwitchHistory.shift();
    }

    // Learn pattern: group by trigger signature
    if (info.trigger) {
      const key = JSON.stringify({
        app: info.trigger.comm || info.trigger.pid || 'unknown',
        hour: new Date(ts).getHours(),
        battery: info.trigger.battery != null ? Math.round(info.trigger.battery / 10) * 10 : null,
      });

      let pattern = this._profilePatterns.get(key);
      if (!pattern) {
        pattern = { profile: info.to, count: 0, lastSeen: 0, trigger: info.trigger };
        this._profilePatterns.set(key, pattern);
      }
      // If the profile changed for the same trigger, update to the latest
      pattern.profile = info.to;
      pattern.count++;
      pattern.lastSeen = ts;
      evictOldest(this._profilePatterns, MAX_FREQ_ENTRIES);
    }

    this._totalProfileSwitches++;
  }

  /**
   * Record a governor change.
   * @param {{ governor: string, cores: number[], reason: string }} info
   */
  recordGovernorChange(info) {
    // Governor changes are a type of profile switch
    this.recordProfileSwitch({
      from: null,
      to: `governor:${info.governor}`,
      reason: info.reason,
      trigger: info.trigger || null,
    });
  }

  // ── Query Methods ────────────────────────────────────────────────

  /**
   * Get the most frequently used applications, sorted by count descending.
   * @param {number} [limit=10]
   * @returns {Array<{ comm: string, count: number, totalMs: number, lastSeen: number, categories: string[] }>}
   */
  getTopApps(limit = 10) {
    const entries = [];
    for (const [comm, data] of this._appFrequency) {
      entries.push({
        comm,
        count: data.count,
        totalMs: data.totalMs,
        lastSeen: data.lastSeen,
        categories: Array.from(data.categories),
      });
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, limit);
  }

  /**
   * Get the hourly activity histogram.
   * @returns {number[]} Array of 24 values (indices 0-23).
   */
  getHourlyActivity() {
    return Array.from(this._hourlyActivity);
  }

  /**
   * Get the most active hours (above average).
   * @returns {number[]} Array of hour indices (0-23) sorted by activity descending.
   */
  getPeakHours() {
    const total = this._hourlyActivity.reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const avg = total / HOURS_IN_DAY;
    const peak = [];
    for (let h = 0; h < HOURS_IN_DAY; h++) {
      if (this._hourlyActivity[h] > avg) {
        peak.push(h);
      }
    }
    peak.sort((a, b) => this._hourlyActivity[b] - this._hourlyActivity[a]);
    return peak;
  }

  /**
   * Get CPU intensive applications sorted by frequency.
   * @param {number} [limit=10]
   * @returns {Array<{ comm: string, count: number, peakPressure: number, avgPressure: number }>}
   */
  getCpuIntensiveApps(limit = 10) {
    const entries = [];
    for (const [comm, data] of this._cpuIntensiveApps) {
      entries.push({
        comm,
        count: data.count,
        peakPressure: data.peakPressure,
        avgPressure: data.avgPressure,
      });
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, limit);
  }

  /**
   * Get battery discharge rate statistics.
   * @returns {{ avgRate: number, minRate: number, maxRate: number, samples: number, isAnomalous: boolean }}
   */
  getBatteryStats() {
    const rates = this._batterySamples
      .filter(s => s.discharging && s.rate !== null && s.rate > 0 && s.rate < 50)
      .map(s => s.rate);

    const stats = computeStats(rates);

    // Check if current rate is anomalous
    let isAnomalous = false;
    if (rates.length >= 5 && stats.stddev > 0) {
      const current = this._batterySamples.length > 0
        ? this._batterySamples[this._batterySamples.length - 1].rate
        : null;
      if (current !== null && Math.abs(current - stats.mean) > OUTLIER_STDDEV_THRESHOLD * stats.stddev) {
        isAnomalous = true;
      }
    }

    return {
      avgRate: Math.round(stats.mean * 100) / 100,
      minRate: Math.round(Math.min(...rates) * 100) / 100 || 0,
      maxRate: Math.round(Math.max(...rates) * 100) / 100 || 0,
      samples: stats.count,
      isAnomalous,
    };
  }

  /**
   * Get the foreground application history (most recent first).
   * @param {number} [limit=50]
   * @returns {Array<{ ts: number, pid: number, comm: string, duration?: number }>}
   */
  getForegroundHistory(limit = 50) {
    const start = Math.max(0, this._foregroundHistory.length - limit);
    return this._foregroundHistory.slice(start).reverse();
  }

  /**
   * Get profile switch patterns, sorted by frequency.
   * @param {number} [limit=10]
   * @returns {Array<{ trigger: object, profile: string, count: number, lastSeen: number }>}
   */
  getProfilePatterns(limit = 10) {
    const entries = [];
    for (const [key, data] of this._profilePatterns) {
      entries.push({
        trigger: data.trigger,
        profile: data.profile,
        count: data.count,
        lastSeen: data.lastSeen,
      });
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, limit);
  }

  /**
   * Get profile switch history (most recent first).
   * @param {number} [limit=50]
   * @returns {Array<{ ts: number, from: string|null, to: string, reason: string }>}
   */
  getProfileSwitchHistory(limit = 50) {
    const start = Math.max(0, this._profileSwitchHistory.length - limit);
    return this._profileSwitchHistory.slice(start).reverse();
  }

  /**
   * Get full learning engine status.
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: true,
      totalObservations: this._totalObservations,
      totalProfileSwitches: this._totalProfileSwitches,
      uniqueApps: this._appFrequency.size,
      uniquePatterns: this._profilePatterns.size,
      cpuIntensiveApps: this._cpuIntensiveApps.size,
      foregroundHistorySize: this._foregroundHistory.length,
      batterySamples: this._batterySamples.length,
      profileSwitches: this._profileSwitchHistory.length,
      peakHours: this.getPeakHours(),
      topApps: this.getTopApps(5),
      uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000),
      dataDir: this._dataDir,
    };
  }

  /**
   * Clear all learning data.
   */
  clear() {
    this._appFrequency.clear();
    this._hourlyActivity.fill(0);
    this._profilePatterns.clear();
    this._batterySamples.length = 0;
    this._cpuIntensiveApps.clear();
    this._foregroundHistory.length = 0;
    this._profileSwitchHistory.length = 0;
    this._recommendations.length = 0;
    this._suggestedRecently.clear();
    this._totalObservations = 0;
    this._totalProfileSwitches = 0;

    // Delete persisted file
    try {
      const filePath = path.join(this._dataDir, 'learning-state.json');
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) { /* noop */ }
  }
}

// Need a local debug reference since we can't import logger here
// (learning engine should work standalone for testing)
function debug(msg) {
  // Silenced in production; overridden in tests
}

module.exports = {
  LearningEngine,
  MAX_FREQ_ENTRIES,
  MAX_FOREGROUND_HISTORY,
  MAX_PROFILE_SWITCHES,
  MAX_CPU_INTENSIVE,
  MAX_BATTERY_SAMPLES,
  MAX_RECOMMENDATIONS,
  MIN_OBSERVATIONS_FOR_RECOMMENDATION,
  STRONG_CONFIDENCE,
  computeStats,
  currentHour,
};