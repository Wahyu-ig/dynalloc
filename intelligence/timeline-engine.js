'use strict';

/**
 * DynAlloc — Timeline Engine
 *
 * Internal timeline that records important events for diagnostics,
 * debugging, and the HTML report. Events are queryable by the CLI
 * via the `timeline` IPC command.
 *
 * Event categories:
 *   - daemon:      start, stop, config_reload, watchdog
 *   - scheduler:   stress_change, boost, throttle, restore
 *   - governor:    change, restore, capture
 *   - policy:      rule_match, action_exec, reload, error
 *   - profile:     switch, activate, deactivate
 *   - plugin:      load, unload, detect, error
 *   - system:      battery_low, thermal_high, psi_high, psi_normal
 *   - learning:    recommendation, pattern_detected, anomaly
 *   - focus:       foreground_changed, event_driven_focus
 *   - adaptive:    transition, rollback, user_override
 *
 * Memory-bounded ring buffer. Zero external dependencies.
 *
 * v2.0: Initial release.
 */

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum timeline entries. */
const MAX_ENTRIES = 10000;

/** Event categories (frozen set for validation). */
const CATEGORIES = Object.freeze([
  'daemon', 'scheduler', 'governor', 'policy', 'profile',
  'plugin', 'system', 'learning', 'focus', 'adaptive',
  'timeline', 'doctor', 'report',
]);

/** Minimum severity levels (ordered). */
const SEVERITIES = Object.freeze(['info', 'warn', 'error']);

// ── Timeline Engine ────────────────────────────────────────────────────

class TimelineEngine {
  constructor(opts = {}) {
    this._config = opts.config || {};

    /**
     * Ring buffer of timeline entries, newest at the end.
     * @type {Array<object>}
     */
    this._entries = [];

    /** Auto-incrementing ID. */
    this._nextId = 0;

    /** Total events recorded (including evicted ones). */
    this._totalRecorded = 0;
  }

  /**
   * Record a timeline event.
   *
   * @param {object} opts
   * @param {string} opts.category - One of CATEGORIES
   * @param {string} opts.event - Short event name (e.g. "boost", "policy_triggered")
   * @param {string} [opts.summary] - Human-readable one-line description
   * @param {string} [opts.severity='info'] - "info" | "warn" | "error"
   * @param {object} [opts.data] - Arbitrary structured data
   * @returns {object} The recorded event.
   */
  record(opts) {
    if (!opts || !opts.category || !opts.event) return null;

    const entry = {
      id: this._nextId++,
      ts: Date.now(),
      category: opts.category,
      event: opts.event,
      summary: opts.summary || opts.event,
      severity: opts.severity || 'info',
      data: opts.data || null,
    };

    this._entries.push(entry);
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.shift();
    }
    this._totalRecorded++;

    return entry;
  }

  /**
   * Convenience: record an info event.
   * @param {string} category
   * @param {string} event
   * @param {string} [summary]
   * @param {object} [data]
   */
  info(category, event, summary, data) {
    return this.record({ category, event, summary, severity: 'info', data });
  }

  /**
   * Convenience: record a warning event.
   * @param {string} category
   * @param {string} event
   * @param {string} [summary]
   * @param {object} [data]
   */
  warn(category, event, summary, data) {
    return this.record({ category, event, summary, severity: 'warn', data });
  }

  /**
   * Convenience: record an error event.
   * @param {string} category
   * @param {string} event
   * @param {string} [summary]
   * @param {object} [data]
   */
  error(category, event, summary, data) {
    return this.record({ category, event, summary, severity: 'error', data });
  }

  // ── Query Methods ────────────────────────────────────────────────

  /**
   * Query the timeline.
   *
   * @param {{ category?: string, event?: string, severity?: string, since?: number, until?: number, limit?: number, offset?: number, search?: string }} opts
   * @returns {{ entries: object[], total: number, filtered: number }}
   */
  query(opts = {}) {
    let entries = this._entries;

    // Filter by category
    if (opts.category) {
      entries = entries.filter(e => e.category === opts.category);
    }

    // Filter by event
    if (opts.event) {
      entries = entries.filter(e => e.event === opts.event);
    }

    // Filter by severity
    if (opts.severity) {
      entries = entries.filter(e => e.severity === opts.severity);
    }

    // Filter by time range
    if (opts.since != null) {
      entries = entries.filter(e => e.ts >= opts.since);
    }
    if (opts.until != null) {
      entries = entries.filter(e => e.ts <= opts.until);
    }

    // Full-text search in summary
    if (opts.search) {
      const lower = opts.search.toLowerCase();
      entries = entries.filter(e =>
        e.summary.toLowerCase().includes(lower) ||
        e.event.toLowerCase().includes(lower)
      );
    }

    const filtered = entries.length;

    // Pagination
    const offset = Math.max(0, opts.offset || 0);
    const limit = Math.min(opts.limit || 100, 1000);
    entries = entries.slice(offset, offset + limit);

    // Return newest first
    return {
      entries: entries.reverse(),
      total: this._totalRecorded,
      filtered,
    };
  }

  /**
   * Get a single event by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getById(id) {
    return this._entries.find(e => e.id === id) || null;
  }

  /**
   * Get timeline statistics.
   * @returns {object}
   */
  getStats() {
    const byCategory = {};
    const bySeverity = { info: 0, warn: 0, error: 0 };

    for (const e of this._entries) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    }

    return {
      bufferSize: this._entries.length,
      maxBufferSize: MAX_ENTRIES,
      totalRecorded: this._totalRecorded,
      byCategory,
      bySeverity,
      firstTs: this._entries.length > 0 ? this._entries[0].ts : null,
      lastTs: this._entries.length > 0 ? this._entries[this._entries.length - 1].ts : null,
    };
  }

  /**
   * Get the N most recent events (newest first).
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  recent(limit = 20) {
    const start = Math.max(0, this._entries.length - limit);
    return this._entries.slice(start).reverse();
  }

  /**
   * Get engine status.
   * @returns {object}
   */
  getStatus() {
    const stats = this.getStats();
    return {
      enabled: true,
      ...stats,
    };
  }

  /**
   * Clear all timeline entries.
   */
  clear() {
    this._entries.length = 0;
    this._nextId = 0;
    this._totalRecorded = 0;
  }

  /**
   * Export timeline as a plain array (for HTML report / serialization).
   * @param {number} [limit=1000]
   * @returns {object[]}
   */
  exportData(limit = 1000) {
    const start = Math.max(0, this._entries.length - limit);
    return this._entries.slice(start).map(e => ({
      id: e.id,
      ts: e.ts,
      time: new Date(e.ts).toISOString(),
      category: e.category,
      event: e.event,
      summary: e.summary,
      severity: e.severity,
      data: e.data,
    }));
  }
}

module.exports = {
  TimelineEngine,
  MAX_ENTRIES,
  CATEGORIES,
  SEVERITIES,
};