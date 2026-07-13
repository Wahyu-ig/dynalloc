'use strict';

/**
 * DynAlloc — Monitoring Layer :: Benchmark Framework
 * ====================================================
 *
 * Provides repeatable benchmarks for key daemon operations.
 * Benchmarks are ON-DEMAND only — they do not run continuously.
 *
 * Available benchmarks:
 *
 *   - startup: measure daemon bootstrap time (simulated)
 *   - policyEvaluation: measure PE rule evaluation latency
 *   - profileSwitching: measure profile activation latency
 *   - eventProcessing: measure event bus emit → listener latency
 *   - controllerExecution: measure RCM action latency
 *   - memory: measure current RSS + heap usage
 *   - cpu: measure daemon CPU overhead
 *
 * Each benchmark returns:
 *
 *   { name, iterations, min, max, avg, p50, p95, p99, durationMs }
 *
 * Usage:
 *
 *   const bench = new BenchmarkFramework({ config, providers });
 *   const result = bench.run('profileSwitching', { iterations: 100 });
 *
 * Backward compatibility: only constructed when
 * ENABLE_MONITORING_FRAMEWORK is true. Benchmarks are on-demand only.
 */

const logger = require('../logger');
const { debug, info } = logger;

class BenchmarkFramework {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {object} [opts.providers] - { getState, getRcm, getPm, getBus, ... }
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('BenchmarkFramework: opts.config is required');
    }
    this._config = opts.config;
    this._providers = opts.providers || {};
    this._results = [];  // bounded history
    this._maxResults = 50;
  }

  /**
   * Run a named benchmark.
   * @param {string} name - benchmark name
   * @param {object} [opts] - { iterations: 100 }
   * @returns {object} benchmark result
   */
  run(name, opts) {
    const iterations = (opts && typeof opts.iterations === 'number') ? opts.iterations : 100;
    const fn = this._getBenchmark(name);
    if (!fn) {
      return { name, error: `unknown benchmark "${name}"`, iterations: 0 };
    }

    const samples = [];
    const startTotal = Date.now();

    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      try {
        fn();
      } catch (err) {
        return { name, error: err.message, iterations: i };
      }
      const elapsedNs = Number(process.hrtime.bigint() - start);
      samples.push(elapsedNs / 1e6);  // convert to ms
    }

    const totalMs = Date.now() - startTotal;
    samples.sort((a, b) => a - b);

    const result = {
      name,
      iterations,
      min: samples[0] || 0,
      max: samples[samples.length - 1] || 0,
      avg: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: this._percentile(samples, 50),
      p95: this._percentile(samples, 95),
      p99: this._percentile(samples, 99),
      durationMs: totalMs,
      timestamp: new Date().toISOString(),
    };

    this._results.push(result);
    if (this._results.length > this._maxResults) {
      this._results = this._results.slice(-this._maxResults);
    }

    return result;
  }

  /**
   * Run all available benchmarks.
   * @param {object} [opts] - { iterations: 50 }
   * @returns {object[]} array of results
   */
  runAll(opts) {
    const names = ['eventProcessing', 'memory', 'cpu', 'policyEvaluation', 'profileSwitching', 'controllerExecution'];
    return names.map((name) => this.run(name, opts));
  }

  /**
   * Get benchmark history.
   * @param {number} [count=10]
   */
  getHistory(count = 10) {
    return this._results.slice(-count);
  }

  getStatus() {
    return {
      resultCount: this._results.length,
      availableBenchmarks: ['eventProcessing', 'memory', 'cpu', 'policyEvaluation', 'profileSwitching', 'controllerExecution', 'startup'],
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  _getBenchmark(name) {
    const benchmarks = {
      eventProcessing: () => this._benchEventProcessing(),
      memory: () => this._benchMemory(),
      cpu: () => this._benchCpu(),
      policyEvaluation: () => this._benchPolicyEvaluation(),
      profileSwitching: () => this._benchProfileSwitching(),
      controllerExecution: () => this._benchControllerExecution(),
      startup: () => this._benchStartup(),
    };
    return benchmarks[name];
  }

  _benchEventProcessing() {
    // Measure event bus emit → listener latency
    if (!this._providers.getBus) return;
    const bus = this._providers.getBus();
    if (!bus) return;
    let received = false;
    const id = bus.on('__benchmark__', () => { received = true; });
    bus.emit('__benchmark__', { test: true });
    bus.off(id);
    if (!received) throw new Error('event not received');
  }

  _benchMemory() {
    // Measure memory access latency (trivial — just reading process.memoryUsage)
    const mem = process.memoryUsage();
    if (!mem.rss) throw new Error('memoryUsage failed');
  }

  _benchCpu() {
    // Measure CPU overhead (trivial computation)
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += i;
    if (sum !== 499500) throw new Error('CPU computation failed');
  }

  _benchPolicyEvaluation() {
    // Measure PE rule evaluation (if available)
    if (!this._providers.evaluatePolicy) return;
    this._providers.evaluatePolicy();
  }

  _benchProfileSwitching() {
    // Measure profile demand + re-evaluate latency (if available)
    if (!this._providers.benchProfileSwitch) return;
    this._providers.benchProfileSwitch();
  }

  _benchControllerExecution() {
    // Measure RCM action latency (if available)
    if (!this._providers.benchControllerExec) return;
    this._providers.benchControllerExec();
  }

  _benchStartup() {
    // Measure simulated startup (require + construct)
    // This is a one-shot benchmark, not iterated.
    const start = process.hrtime.bigint();
    try {
      require('../config');
    } catch (_) { /* may already be cached */ }
    const elapsed = Number(process.hrtime.bigint() - start);
    return elapsed / 1e6;  // ms
  }

  _percentile(sortedSamples, p) {
    if (sortedSamples.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sortedSamples.length) - 1;
    return sortedSamples[Math.max(0, Math.min(idx, sortedSamples.length - 1))];
  }
}

module.exports = BenchmarkFramework;
