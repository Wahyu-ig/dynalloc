'use strict';

/**
 * test-monitoring-framework.js — Unit tests for the v0.5.0 Phase 6
 * Monitoring, Diagnostics & Benchmark Framework.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SystemMonitor = require(path.join(__dirname, '..', '..', 'monitoring', 'system-monitor.js'));
const DiagnosticsEngine = require(path.join(__dirname, '..', '..', 'monitoring', 'diagnostics-engine.js'));
const HealthChecker = require(path.join(__dirname, '..', '..', 'monitoring', 'health-checker.js'));
const BenchmarkFramework = require(path.join(__dirname, '..', '..', 'monitoring', 'benchmark-framework.js'));
const MetricsCollector = require(path.join(__dirname, '..', '..', 'monitoring', 'metrics-collector.js'));
const monitoringIndex = require(path.join(__dirname, '..', '..', 'monitoring'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));

function makeConfig(overrides) {
  return { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
}

function makeFakeProviders() {
  return {
    getState: () => ({ stressLevel: 'NORMAL', foregroundPid: 1234 }),
    getUptime: () => 42,
    getDetectorStatus: () => ({ enabled: true, running: true, detectors: [{ name: 'workload' }] }),
    getRcmStatus: () => ({ enabled: true, running: true, controllers: [{ name: 'cpu', available: true }] }),
    getProfileManagerStatus: () => ({ enabled: true, running: true, activeProfileId: 'balanced', demandSet: [], switchCount: 1 }),
    getAdaptiveStatus: () => ({ enabled: true, running: true, activeProfileId: 'balanced', transitionManager: { historySize: 3 } }),
    getRecognitionStatus: () => ({ enabled: true, running: true, recognizer: { ruleCount: 14 }, demandedProfile: null }),
    getPolicyEngineStatus: () => ({ running: true, ruleCount: 5 }),
    getPluginNames: () => ['game', 'browser'],
    getBusStatus: () => ({ destroyed: false, listeners: 10 }),
    getMetricsSnapshot: () => ({ boost_count: 5, cpu_pressure: 10 }),
  };
}

// ── SystemMonitor ─────────────────────────────────────────────────────

test('SystemMonitor requires config', () => {
  assert.throws(() => new SystemMonitor({}), TypeError);
});

test('SystemMonitor.snapshot returns object with expected fields', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: makeFakeProviders() });
  const snap = m.snapshot();
  assert.ok(snap.timestamp);
  assert.ok(snap.cpu);
  assert.ok(snap.memory);
  assert.ok(snap.thermal !== undefined);
  assert.ok(snap.workload);
  assert.ok(snap.profile);
  assert.ok(Array.isArray(snap.controllers));
  assert.ok(snap.process);
});

test('SystemMonitor.snapshot increments count', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: makeFakeProviders() });
  m.snapshot();
  m.snapshot();
  assert.strictEqual(m.snapshotCount, 2);
});

test('SystemMonitor reads workload from providers', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: makeFakeProviders() });
  const snap = m.snapshot();
  assert.strictEqual(snap.workload.classification, 'NORMAL');
  assert.strictEqual(snap.workload.foregroundPid, 1234);
});

test('SystemMonitor reads profile from providers', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: makeFakeProviders() });
  const snap = m.snapshot();
  assert.strictEqual(snap.profile.active, 'balanced');
  assert.strictEqual(snap.profile.switchCount, 1);
});

test('SystemMonitor reads controllers from providers', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: makeFakeProviders() });
  const snap = m.snapshot();
  assert.strictEqual(snap.controllers.length, 1);
  assert.strictEqual(snap.controllers[0].name, 'cpu');
});

test('SystemMonitor reads process info from /proc', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: {} });
  const snap = m.snapshot();
  assert.ok(snap.process.daemonRssKb >= 0);
  assert.ok(snap.process.daemonCpuTicks >= 0);
});

test('SystemMonitor handles missing providers gracefully', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: {} });
  const snap = m.snapshot();
  assert.strictEqual(snap.cpu.pressure, 0);
  assert.strictEqual(snap.thermal.temp, null);
  assert.strictEqual(snap.battery, null);
  assert.deepStrictEqual(snap.controllers, []);
});

test('SystemMonitor getStatus returns snapshot', () => {
  const m = new SystemMonitor({ config: makeConfig(), providers: {} });
  const status = m.getStatus();
  assert.strictEqual(status.snapshotCount, 0);
  assert.strictEqual(status.hasProviders, false);
});

// ── DiagnosticsEngine ─────────────────────────────────────────────────

test('DiagnosticsEngine requires config', () => {
  assert.throws(() => new DiagnosticsEngine({}), TypeError);
});

test('DiagnosticsEngine.report returns full report', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: makeFakeProviders() });
  const report = d.report();
  assert.ok(report.timestamp);
  assert.ok(report.daemon);
  assert.ok(Array.isArray(report.detectors));
  assert.ok(report.profiles);
  assert.ok(report.adaptive);
  assert.ok(report.recognition);
  assert.ok(report.errors);
  assert.ok(report.warnings);
});

test('DiagnosticsEngine.report reads detectors', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: makeFakeProviders() });
  const report = d.report();
  assert.strictEqual(report.detectors.length, 1);
  assert.strictEqual(report.detectors[0].name, 'workload');
});

test('DiagnosticsEngine.report reads profile manager', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: makeFakeProviders() });
  const report = d.report();
  assert.strictEqual(report.profiles.active, 'balanced');
  assert.strictEqual(report.profiles.switchCount, 1);
});

test('DiagnosticsEngine recordError/recordWarning', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: {} });
  d.recordError('test error');
  d.recordWarning('test warning');
  const report = d.report();
  assert.ok(report.errors.some((e) => e.message.includes('test error')));
  assert.ok(report.warnings.some((w) => w.message.includes('test warning')));
});

test('DiagnosticsEngine error/warning log is bounded', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: {} });
  for (let i = 0; i < 100; i++) d.recordError(`err${i}`);
  assert.ok(d._errors.length <= 50);  // maxLogSize = 50
});

test('DiagnosticsEngine getStatus returns snapshot', () => {
  const d = new DiagnosticsEngine({ config: makeConfig(), providers: {} });
  d.report();
  const status = d.getStatus();
  assert.strictEqual(status.reportCount, 1);
  assert.strictEqual(status.errorCount, 0);
});

// ── HealthChecker ─────────────────────────────────────────────────────

test('HealthChecker requires config', () => {
  assert.throws(() => new HealthChecker({}), TypeError);
});

test('HealthChecker.check returns health report', () => {
  const hc = new HealthChecker({ config: makeConfig(), providers: makeFakeProviders() });
  const result = hc.check();
  assert.ok(typeof result.healthy === 'boolean');
  assert.ok(Array.isArray(result.checks));
  assert.strictEqual(result.checks.length, 6);
});

test('HealthChecker detects unhealthy event bus', () => {
  const hc = new HealthChecker({
    config: makeConfig(),
    providers: { ...makeFakeProviders(), getBusStatus: () => ({ destroyed: true }) },
  });
  const result = hc.check();
  assert.strictEqual(result.healthy, false);
  assert.ok(result.checks.some((c) => c.name === 'event-bus' && !c.healthy));
});

test('HealthChecker detects unhealthy profile manager (no active profile)', () => {
  const hc = new HealthChecker({
    config: makeConfig(),
    providers: { ...makeFakeProviders(), getProfileManagerStatus: () => ({ enabled: true, running: true, activeProfileId: null }) },
  });
  const result = hc.check();
  assert.strictEqual(result.healthy, false);
  assert.ok(result.checks.some((c) => c.name === 'profile-manager' && !c.healthy));
});

test('HealthChecker reports healthy when subsystems disabled', () => {
  const hc = new HealthChecker({
    config: makeConfig(),
    providers: { ...makeFakeProviders(), getDetectorStatus: () => ({ enabled: false }) },
  });
  const result = hc.check();
  const detCheck = result.checks.find((c) => c.name === 'detectors');
  assert.strictEqual(detCheck.healthy, true);
});

test('HealthChecker start/stop lifecycle', () => {
  const hc = new HealthChecker({ config: makeConfig({ MONITORING_HEALTH_CHECK_INTERVAL_MS: 60000 }), providers: {} });
  hc.start();
  assert.strictEqual(hc.getStatus().running, true);
  hc.stop();
  assert.strictEqual(hc.getStatus().running, false);
});

test('HealthChecker records issues', () => {
  const hc = new HealthChecker({
    config: makeConfig(),
    providers: { ...makeFakeProviders(), getBusStatus: () => ({ destroyed: true }) },
  });
  hc.check();
  assert.ok(hc.getStatus().issueCount > 0);
});

test('HealthChecker checkCount increments', () => {
  const hc = new HealthChecker({ config: makeConfig(), providers: {} });
  hc.check();
  hc.check();
  assert.strictEqual(hc.checkCount, 2);
});

// ── BenchmarkFramework ────────────────────────────────────────────────

test('BenchmarkFramework requires config', () => {
  assert.throws(() => new BenchmarkFramework({}), TypeError);
});

test('BenchmarkFramework.run benchmarks memory', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  const result = bf.run('memory', { iterations: 10 });
  assert.strictEqual(result.name, 'memory');
  assert.strictEqual(result.iterations, 10);
  assert.ok(result.min >= 0);
  assert.ok(result.avg >= 0);
  assert.ok(result.p50 >= 0);
  assert.ok(result.p95 >= 0);
});

test('BenchmarkFramework.run benchmarks cpu', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  const result = bf.run('cpu', { iterations: 50 });
  assert.strictEqual(result.iterations, 50);
  assert.ok(result.max >= result.min);
});

test('BenchmarkFramework.run rejects unknown benchmark', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  const result = bf.run('nonexistent');
  assert.ok(result.error);
});

test('BenchmarkFramework.runAll runs all benchmarks', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  const results = bf.runAll({ iterations: 10 });
  assert.ok(results.length >= 5);
  for (const r of results) {
    assert.ok(r.name);
  }
});

test('BenchmarkFramework stores history', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  bf.run('memory', { iterations: 5 });
  bf.run('cpu', { iterations: 5 });
  const history = bf.getHistory(10);
  assert.strictEqual(history.length, 2);
});

test('BenchmarkFramework getStatus returns available benchmarks', () => {
  const bf = new BenchmarkFramework({ config: makeConfig(), providers: {} });
  const status = bf.getStatus();
  assert.ok(status.availableBenchmarks.length >= 5);
});

// ── MetricsCollector ──────────────────────────────────────────────────

test('MetricsCollector requires config', () => {
  assert.throws(() => new MetricsCollector({}), TypeError);
});

test('MetricsCollector increment/setGauge without registry uses internal storage', () => {
  const mc = new MetricsCollector({ config: makeConfig(), metrics: null });
  mc.increment('test_counter', 5);
  mc.setGauge('test_gauge', 42);
  const snap = mc.snapshot();
  assert.strictEqual(snap.test_counter, 5);
  assert.strictEqual(snap.test_gauge, 42);
});

test('MetricsCollector snapshot merges custom + registry', () => {
  const fakeMetrics = {
    counter: () => ({ increment: () => {} }),
    gauge: () => ({ set: () => {} }),
    histogram: () => ({ record: () => {} }),
    snapshot: () => ({ registry_metric: 99 }),
  };
  const mc = new MetricsCollector({ config: makeConfig(), metrics: fakeMetrics });
  mc.increment('custom_counter', 3);
  const snap = mc.snapshot();
  assert.strictEqual(snap.registry_metric, 99);
  // custom_counter was incremented via registry (fakeMetrics.counter),
  // so it won't appear in custom storage
});

test('MetricsCollector formatReport returns text', () => {
  const mc = new MetricsCollector({ config: makeConfig(), metrics: null });
  mc.increment('a.b', 1);
  mc.setGauge('c.d', 2);
  const report = mc.formatReport();
  assert.ok(typeof report === 'string');
  assert.ok(report.includes('a.b'));
  assert.ok(report.includes('c.d'));
});

test('MetricsCollector exportJSON returns JSON string', () => {
  const mc = new MetricsCollector({ config: makeConfig(), metrics: null });
  mc.increment('test', 1);
  const json = mc.exportJSON();
  assert.ok(typeof json === 'string');
  assert.ok(JSON.parse(json).test !== undefined);
});

test('MetricsCollector getStatus returns snapshot', () => {
  const mc = new MetricsCollector({ config: makeConfig(), metrics: null });
  mc.increment('x', 1);
  mc.snapshot();
  const status = mc.getStatus();
  assert.strictEqual(status.hasRegistry, false);
  assert.strictEqual(status.customCounterCount, 1);
  assert.strictEqual(status.collectionCount, 1);
});

// ── Public API ────────────────────────────────────────────────────────

test('monitoring/index.js exports all classes', () => {
  assert.strictEqual(typeof monitoringIndex.SystemMonitor, 'function');
  assert.strictEqual(typeof monitoringIndex.DiagnosticsEngine, 'function');
  assert.strictEqual(typeof monitoringIndex.HealthChecker, 'function');
  assert.strictEqual(typeof monitoringIndex.BenchmarkFramework, 'function');
  assert.strictEqual(typeof monitoringIndex.MetricsCollector, 'function');
});

// ── No syscalls / polling ─────────────────────────────────────────────

test('monitoring modules never call exec/execFile/spawn', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '..', 'monitoring');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src), `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

test('monitoring modules use no setInterval except HealthChecker (unref\'d)', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '..', 'monitoring');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f === 'health-checker.js') {
      // HealthChecker uses setInterval but must unref it
      assert.ok(/setInterval\(/.test(src), 'health-checker should use setInterval');
      assert.ok(/\.unref\(\)/.test(src), 'health-checker must unref the timer');
    } else {
      assert.ok(!/setInterval\(/.test(src), `${f}: must NOT use setInterval`);
    }
  }
});
