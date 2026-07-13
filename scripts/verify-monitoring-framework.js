'use strict';

/**
 * verify-monitoring-framework.js — Safety & architecture validation for
 * the v0.5.0 Phase 6 Monitoring, Diagnostics & Benchmark Framework.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try { fn(); console.log(`  \u2714 ${name}`); pass++; }
  catch (err) { console.log(`  \u2718 ${name}: ${err.message}`); fail++; }
}

console.log('Monitoring Framework Safety & Architecture Validation');
console.log('='.repeat(60));

const MONITORING_DIR = path.join(__dirname, '..', 'monitoring');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('monitoring/system-monitor.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'system-monitor.js')));
});

test('monitoring/diagnostics-engine.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'diagnostics-engine.js')));
});

test('monitoring/health-checker.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'health-checker.js')));
});

test('monitoring/benchmark-framework.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'benchmark-framework.js')));
});

test('monitoring/metrics-collector.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'metrics-collector.js')));
});

test('monitoring/index.js exists', () => {
  assert.ok(fs.existsSync(path.join(MONITORING_DIR, 'index.js')));
});

test('monitoring/index.js exports all 5 classes', () => {
  const idx = require(MONITORING_DIR);
  assert.strictEqual(typeof idx.SystemMonitor, 'function');
  assert.strictEqual(typeof idx.DiagnosticsEngine, 'function');
  assert.strictEqual(typeof idx.HealthChecker, 'function');
  assert.strictEqual(typeof idx.BenchmarkFramework, 'function');
  assert.strictEqual(typeof idx.MetricsCollector, 'function');
});

// ── 2. No syscalls ────────────────────────────────────────────────────

test('monitoring modules never call exec/execFile/spawn', () => {
  const files = fs.readdirSync(MONITORING_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(MONITORING_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src), `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

// ── 3. No polling (except HealthChecker which unrefs) ─────────────────

test('HealthChecker uses setInterval but unrefs it', () => {
  const src = fs.readFileSync(path.join(MONITORING_DIR, 'health-checker.js'), 'utf8');
  assert.ok(/setInterval\(/.test(src), 'should use setInterval');
  assert.ok(/\.unref\(\)/.test(src), 'must unref the timer');
});

test('other monitoring modules use no setInterval', () => {
  const files = fs.readdirSync(MONITORING_DIR).filter((f) => f.endsWith('.js') && f !== 'health-checker.js');
  for (const f of files) {
    const src = fs.readFileSync(path.join(MONITORING_DIR, f), 'utf8');
    assert.ok(!/setInterval\(/.test(src), `${f}: must NOT use setInterval`);
  }
});

// ── 4. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_MONITORING_FRAMEWORK defaulting to false', () => {
  assert.ok(/ENABLE_MONITORING_FRAMEWORK:\s*false/.test(CONFIG_SRC));
});

test('config.js has MONITORING_HEALTH_CHECK_INTERVAL_MS default', () => {
  assert.ok(/MONITORING_HEALTH_CHECK_INTERVAL_MS:\s*30000/.test(CONFIG_SRC));
});

test('config.js has schema entries for monitoring keys', () => {
  for (const key of ['ENABLE_MONITORING_FRAMEWORK', 'MONITORING_HEALTH_CHECK_INTERVAL_MS', 'MONITORING_BENCHMARK_ENABLED']) {
    assert.ok(CONFIG_SRC.includes(`${key}:`), `CONFIG_SCHEMA must have ${key}`);
  }
});

test('monitoring keys in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of ['ENABLE_MONITORING_FRAMEWORK', 'MONITORING_HEALTH_CHECK_INTERVAL_MS', 'MONITORING_BENCHMARK_ENABLED']) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key), `${key} must be hot-reloadable`);
  }
});

// ── 5. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates monitoring behind ENABLE_MONITORING_FRAMEWORK', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_MONITORING_FRAMEWORK\)/.test(DAEMON_SRC));
});

test('daemon.js registers IPC monitor handler', () => {
  assert.ok(/registerHandler\(['"]monitor['"]/.test(DAEMON_SRC));
});

test('daemon.js registers IPC diagnostics handler', () => {
  assert.ok(/registerHandler\(['"]diagnostics['"]/.test(DAEMON_SRC));
});

test('daemon.js registers IPC health handler', () => {
  assert.ok(/registerHandler\(['"]health['"]/.test(DAEMON_SRC));
});

test('daemon.js registers IPC benchmark handler', () => {
  assert.ok(/registerHandler\(['"]benchmark['"]/.test(DAEMON_SRC));
});

test('daemon.js calls healthChecker.stop in cleanup', () => {
  assert.ok(/healthChecker\.stop\(\)/.test(DAEMON_SRC));
});

test('daemon.js exposes monitoring in getState()', () => {
  assert.ok(/monitoring:/.test(DAEMON_SRC));
});

// ── 6. Controller isolation ───────────────────────────────────────────

test('monitoring modules do not import detectors/adaptive/recognition', () => {
  const files = fs.readdirSync(MONITORING_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(MONITORING_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/detectors/.test(src), `${f}: must NOT import detectors/`);
    assert.ok(!/require\(['"]\.\.\/adaptive/.test(src), `${f}: must NOT import adaptive/`);
    assert.ok(!/require\(['"]\.\.\/recognition/.test(src), `${f}: must NOT import recognition/`);
  }
});

// ── 7. Behavioral smoke test ──────────────────────────────────────────

test('SystemMonitor.snapshot works without providers', () => {
  const { SystemMonitor } = require(MONITORING_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const m = new SystemMonitor({ config: { ...DEFAULT_CONFIG, DRY_RUN: true }, providers: {} });
  const snap = m.snapshot();
  assert.ok(snap.timestamp);
  assert.ok(snap.cpu);
});

test('HealthChecker.check returns 6 checks', () => {
  const { HealthChecker } = require(MONITORING_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const hc = new HealthChecker({ config: { ...DEFAULT_CONFIG, DRY_RUN: true }, providers: {} });
  const result = hc.check();
  assert.strictEqual(result.checks.length, 6);
});

test('BenchmarkFramework.run benchmarks memory', () => {
  const { BenchmarkFramework } = require(MONITORING_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const bf = new BenchmarkFramework({ config: { ...DEFAULT_CONFIG, DRY_RUN: true }, providers: {} });
  const result = bf.run('memory', { iterations: 10 });
  assert.strictEqual(result.iterations, 10);
  assert.ok(result.min >= 0);
});

test('MetricsCollector works without registry', () => {
  const { MetricsCollector } = require(MONITORING_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const mc = new MetricsCollector({ config: { ...DEFAULT_CONFIG, DRY_RUN: true }, metrics: null });
  mc.increment('test', 5);
  assert.strictEqual(mc.snapshot().test, 5);
});

// ── 8. Test file exists ───────────────────────────────────────────────

test('test/unit/test-monitoring-framework.js exists', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'test', 'unit', 'test-monitoring-framework.js')));
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Monitoring Framework safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Monitoring Framework safety regression detected.');
  process.exit(1);
}

process.exit(0);
