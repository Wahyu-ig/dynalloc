'use strict';

/**
 * DynAlloc — Metrics Module
 *
 * Internal metrics collector. Tracks scheduler state, counters,
 * latencies, and system state for observability.
 *
 * Metrics can be displayed via log or programmatic access.
 */

// ── Metric Types ───────────────────────────────────────────────────────

class Counter {
  constructor(name, description = '') {
    this.name = name;
    this.description = description;
    this._value = 0;
  }

  increment(amount = 1) {
    this._value += amount;
  }

  get value() { return this._value; }

  reset() { this._value = 0; }
}

class Gauge {
  constructor(name, description = '') {
    this.name = name;
    this.description = description;
    this._value = 0;
  }

  set(value) { this._value = value; }

  get value() { return this._value; }
}

class Histogram {
  /**
   * @param {string} name
   * @param {string} description
   * @param {number[]} buckets - percentile buckets (ms)
   */
  constructor(name, description = '', buckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000]) {
    this.name = name;
    this.description = description;
    this.buckets = buckets;
    this._samples = [];
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = 0;
  }

  record(valueMs) {
    this._count++;
    this._sum += valueMs;
    if (valueMs < this._min) this._min = valueMs;
    if (valueMs > this._max) this._max = valueMs;
    // Keep last 1000 samples for percentile calculation.
    //
    // BUG FIX (v2.1.1): The previous formula was
    // `this._samples[this._count % 1000]`, which on the first overflow
    // (count=1001) wrote to index 1 instead of index 0 (the oldest
    // sample). Index 0 stayed stale for an extra 1000 records. Use
    // `(this._count - 1) % 1000` instead — `_count` was just
    // incremented, so `_count - 1` is the 0-indexed position of the
    // sample being written, and modulo 1000 lands on the oldest slot.
    if (this._samples.length < 1000) {
      this._samples.push(valueMs);
    } else {
      this._samples[(this._count - 1) % 1000] = valueMs;
    }
  }

  get count() { return this._count; }
  get sum() { return this._sum; }
  get avg() { return this._count > 0 ? this._sum / this._count : 0; }
  get min() { return this._count > 0 ? this._min : 0; }
  get max() { return this._count > 0 ? this._max : 0; }

  percentile(p) {
    if (this._samples.length === 0) return 0;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  reset() {
    this._samples = [];
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = 0;
  }
}

// ── Metrics Registry ───────────────────────────────────────────────────

class MetricsRegistry {
  constructor() {
    this._counters = new Map();
    this._gauges = new Map();
    this._histograms = new Map();
    this._startTime = Date.now();

    // Initialize all DynAlloc metrics
    this._initMetrics();
  }

  _initMetrics() {
    // Scheduler State
    this.gauge('scheduler_stress_level', 'Current scheduler stress level');
    this.gauge('cpu_pressure', 'Current CPU PSI pressure');
    this.gauge('memory_pressure', 'Current memory PSI pressure');

    // Counters
    this.counter('boost_count', 'Number of foreground boosts applied');
    this.counter('throttle_count', 'Number of background throttles applied');
    this.counter('restore_count', 'Number of process restorations');
    this.counter('scheduler_decision_count', 'Total scheduler decisions');
    this.counter('scheduler_state_transitions', 'Number of stress level transitions');
    this.counter('foreground_changes', 'Number of foreground PID changes');
    this.counter('media_detections', 'Number of multimedia detection runs');
    this.counter('media_protected_pids', 'PIDs protected by multimedia detection');

    // Gauges
    this.gauge('current_governor', 'Current CPU governor');
    this.gauge('foreground_pid', 'Current foreground PID');
    this.gauge('foreground_application', 'Current foreground application name');
    this.gauge('current_cgroup_mode', 'Current cgroup mode (cgroups/taskset)');
    this.gauge('throttled_process_count', 'Number of currently throttled processes');
    this.gauge('media_protected_count', 'Number of media-protected PIDs');
    this.gauge('adaptive_score', 'Current adaptive scheduler score');
    this.gauge('consecutive_normal_ticks', 'Consecutive NORMAL stress ticks');
    this.gauge('fast_tick_interval_ms', 'Current fast tick interval');

    // CPU History
    this.gauge('cpu_history_cpu_avg', 'CPU PSI moving average');
    this.gauge('cpu_history_mem_avg', 'Memory PSI moving average');

    // Histograms (latencies)
    this.histogram('scheduler_tick_latency_ms', 'Scheduler tick duration');
    this.histogram('process_scan_latency_ms', 'Process scan duration');
    this.histogram('process_classify_latency_ms', 'Process classification duration');
    this.histogram('foreground_detect_latency_ms', 'Foreground detection duration');
    this.histogram('media_detect_latency_ms', 'Multimedia detection duration');
    this.histogram('cgroup_switch_latency_ms', 'Cgroup assignment duration');
    this.histogram('governor_switch_latency_ms', 'Governor switch duration');

    // Daemon
    this.gauge('daemon_uptime_seconds', 'Daemon uptime in seconds');
    this.gauge('daemon_rss_mb', 'Daemon RSS memory usage in MB');
    this.gauge('daemon_cpu_percent', 'Daemon CPU usage percent');

    // v2.1.8: Thermal protection
    this.counter('thermal_pause_count', 'Times governor boost was paused due to high temp');
    this.counter('thermal_pause_boost_skipped', 'Boost actions that skipped governor switch due to thermal pause');
    this.gauge('thermal_temp_celsius', 'Current CPU temperature (°C)');
    this.gauge('thermal_pause_active', '1 if thermal pause is currently active, 0 otherwise');
  }

  // ── Accessor helpers ────────────────────────────────────────────────

  counter(name, description = '') {
    if (!this._counters.has(name)) {
      this._counters.set(name, new Counter(name, description));
    }
    return this._counters.get(name);
  }

  gauge(name, description = '') {
    if (!this._gauges.has(name)) {
      this._gauges.set(name, new Gauge(name, description));
    }
    return this._gauges.get(name);
  }

  histogram(name, description = '', buckets) {
    if (!this._histograms.has(name)) {
      this._histograms.set(name, new Histogram(name, description, buckets));
    }
    return this._histograms.get(name);
  }

  // ── Snapshot & Display ──────────────────────────────────────────────

  /**
   * Get a snapshot of all metrics as a plain object.
   */
  snapshot() {
    const result = {};

    for (const [name, c] of this._counters) {
      result[name] = c.value;
    }

    for (const [name, g] of this._gauges) {
      result[name] = g.value;
    }

    for (const [name, h] of this._histograms) {
      result[`${name}_count`] = h.count;
      result[`${name}_avg`] = Number(h.avg.toFixed(2));
      result[`${name}_p50`] = Number(h.percentile(50).toFixed(2));
      result[`${name}_p95`] = Number(h.percentile(95).toFixed(2));
      result[`${name}_p99`] = Number(h.percentile(99).toFixed(2));
      result[`${name}_min`] = Number(h.min.toFixed(2));
      result[`${name}_max`] = Number(h.max.toFixed(2));
    }

    result.uptime_seconds = Math.floor((Date.now() - this._startTime) / 1000);

    return result;
  }

  /**
   * Return a formatted string suitable for logging or command output.
   */
  formatReport() {
    const snap = this.snapshot();
    const lines = [];

    lines.push('=== DynAlloc Metrics ===');
    lines.push(`Uptime: ${snap.uptime_seconds}s`);

    lines.push('\n-- Scheduler --');
    lines.push(`Stress Level: ${snap.scheduler_stress_level}`);
    lines.push(`CPU Pressure: ${snap.cpu_pressure}`);
    lines.push(`Memory Pressure: ${snap.memory_pressure}`);
    lines.push(`Adaptive Score: ${snap.adaptive_score}`);
    lines.push(`Decisions: ${snap.scheduler_decision_count}`);
    lines.push(`State Transitions: ${snap.scheduler_state_transitions}`);

    lines.push('\n-- Actions --');
    lines.push(`Boosts: ${snap.boost_count}`);
    lines.push(`Throttles: ${snap.throttle_count}`);
    lines.push(`Restores: ${snap.restore_count}`);
    lines.push(`Foreground Changes: ${snap.foreground_changes}`);

    lines.push('\n-- System --');
    lines.push(`Foreground PID: ${snap.foreground_pid}`);
    lines.push(`Foreground App: ${snap.foreground_application}`);
    lines.push(`Governor: ${snap.current_governor}`);
    lines.push(`Cgroup Mode: ${snap.current_cgroup_mode}`);
    lines.push(`Throttled Procs: ${snap.throttled_process_count}`);
    lines.push(`Media Protected: ${snap.media_protected_count}`);

    lines.push('\n-- Latencies (ms) --');
    lines.push(`Scheduler Tick: avg=${snap.scheduler_tick_latency_ms_avg} p95=${snap.scheduler_tick_latency_ms_p95}`);
    lines.push(`Process Scan: avg=${snap.process_scan_latency_ms_avg} p95=${snap.process_scan_latency_ms_p95}`);
    lines.push(`Foreground Detect: avg=${snap.foreground_detect_latency_ms_avg} p95=${snap.foreground_detect_latency_ms_p95}`);
    lines.push(`Media Detect: avg=${snap.media_detect_latency_ms_avg} p95=${snap.media_detect_latency_ms_p95}`);

    lines.push('\n-- Daemon Resource --');
    lines.push(`RSS: ${snap.daemon_rss_mb} MB`);
    lines.push(`CPU: ${snap.daemon_cpu_percent}%`);
    lines.push(`Fast Tick Interval: ${snap.fast_tick_interval_ms}ms`);

    return lines.join('\n');
  }

  /**
   * Update daemon self-resource metrics (RSS, CPU).
   */
  updateDaemonResourceMetrics() {
    try {
      // RSS from /proc/self/status
      const status = require('fs').readFileSync('/proc/self/status', 'utf8');
      const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/i);
      if (rssMatch) {
        this.gauge('daemon_rss_mb').set(Math.round(parseInt(rssMatch[1], 10) / 1024));
      }
    } catch (_) { /* not available */ }

    try {
      // CPU from /proc/self/stat
      const stat = require('fs').readFileSync('/proc/self/stat', 'utf8');
      const parts = stat.split(' ');
      const utime = parseInt(parts[13], 10);
      const stime = parseInt(parts[14], 10);
      const totalTicks = utime + stime;
      const uptimeMs = Date.now() - this._startTime;
      const hz = 100; // assume 100Hz tick
      const cpuPercent = uptimeMs > 0 ? ((totalTicks / hz) / (uptimeMs / 1000)) * 100 : 0;
      this.gauge('daemon_cpu_percent').set(Number(Math.min(cpuPercent, 100).toFixed(1)));
    } catch (_) { /* not available */ }
  }

  reset() {
    for (const c of this._counters.values()) c.reset();
    for (const g of this._gauges.values()) g.set(0);
    for (const h of this._histograms.values()) h.reset();
    this._startTime = Date.now();
  }
}

// Singleton
let _instance = null;

function getMetrics() {
  if (!_instance) {
    _instance = new MetricsRegistry();
  }
  return _instance;
}

function resetMetrics() {
  if (_instance) {
    _instance.reset();
  }
  _instance = null;
}

module.exports = {
  getMetrics,
  resetMetrics,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
};