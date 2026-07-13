'use strict';

/**
 * DynAlloc — Monitoring Layer :: Metrics Collector
 * ==================================================
 *
 * A lightweight wrapper around the existing `metrics.js` registry.
 * Provides a unified API for collecting + exporting metrics from all
 * subsystems without duplicating the metric storage.
 *
 * The collector does NOT replace `metrics.js` — it wraps it, adding:
 *   - Subsystem namespacing (e.g. 'detector.ticks', 'profile.switches')
 *   - Export to JSON/plain-object
 *   - Consistent naming conventions
 *
 * Backward compatibility: only constructed when
 * ENABLE_MONITORING_FRAMEWORK is true. When disabled, the existing
 * `metrics.js` registry continues to work as before.
 */

const logger = require('../logger');
const { debug } = logger;

class MetricsCollector {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {object} [opts.metrics] - existing metrics registry (from metrics.js)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('MetricsCollector: opts.config is required');
    }
    this._config = opts.config;
    this._metrics = opts.metrics || null;
    this._customCounters = new Map();
    this._customGauges = new Map();
    this._collectionCount = 0;
  }

  /**
   * Increment a counter.
   */
  increment(name, amount = 1) {
    if (this._metrics) {
      try { this._metrics.counter(name).increment(amount); return; } catch (_) { /* fall through */ }
    }
    // Fallback to internal storage
    const c = this._customCounters.get(name) || 0;
    this._customCounters.set(name, c + amount);
  }

  /**
   * Set a gauge value.
   */
  setGauge(name, value) {
    if (this._metrics) {
      try { this._metrics.gauge(name).set(value); return; } catch (_) { /* fall through */ }
    }
    this._customGauges.set(name, value);
  }

  /**
   * Record a histogram sample.
   */
  recordHistogram(name, value) {
    if (this._metrics) {
      try { this._metrics.histogram(name).record(value); return; } catch (_) { /* fall through */ }
    }
    // No fallback for histograms (they need bucket arrays)
  }

  /**
   * Get a snapshot of all metrics (from registry + custom).
   */
  snapshot() {
    this._collectionCount++;
    let registrySnap = {};
    if (this._metrics) {
      try { registrySnap = this._metrics.snapshot(); } catch (_) { /* noop */ }
    }
    // Merge custom counters/gauges
    for (const [name, value] of this._customCounters) {
      if (!(name in registrySnap)) registrySnap[name] = value;
    }
    for (const [name, value] of this._customGauges) {
      if (!(name in registrySnap)) registrySnap[name] = value;
    }
    return registrySnap;
  }

  /**
   * Export metrics as a formatted report (text).
   */
  formatReport() {
    const snap = this.snapshot();
    const lines = ['=== DynAlloc Metrics (Monitoring Framework) ==='];

    // Group by prefix
    const grouped = {};
    for (const [key, value] of Object.entries(snap)) {
      const prefix = key.split(/[._]/)[0] || 'misc';
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push({ key, value });
    }

    for (const [prefix, entries] of Object.entries(grouped)) {
      lines.push(`\n-- ${prefix} --`);
      for (const { key, value } of entries.sort((a, b) => a.key.localeCompare(b.key))) {
        lines.push(`  ${key}: ${value}`);
      }
    }

    lines.push(`\n-- Summary --`);
    lines.push(`  Collection count: ${this._collectionCount}`);
    lines.push(`  Total metrics: ${Object.keys(snap).length}`);

    return lines.join('\n');
  }

  /**
   * Export metrics as JSON.
   */
  exportJSON() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  get collectionCount() {
    return this._collectionCount;
  }

  getStatus() {
    return {
      hasRegistry: this._metrics !== null,
      customCounterCount: this._customCounters.size,
      customGaugeCount: this._customGauges.size,
      collectionCount: this._collectionCount,
    };
  }
}

module.exports = MetricsCollector;
