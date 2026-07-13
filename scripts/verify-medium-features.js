'use strict';

/**
 * Regression tests for v2.1.10 medium-priority features.
 *
 * Tests cover:
 *   #14 Watchdog timer
 *   #15 systemd unit name classification
 *   #16 Configurable battery low threshold
 *   #13 NUMA-aware pinning
 *   #10 Per-app profile overrides
 *   #9 GPU awareness
 *   #12 Network awareness
 *   #11 Learning mode
 *
 * Run with: node scripts/verify-medium-features.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Verifying v2.1.10 medium-priority features...\n');

// ── #14: Watchdog timer ────────────────────────────────────────────────

test('#14a: config has ENABLE_WATCHDOG=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_WATCHDOG, true);
});

test('#14b: config has WATCHDOG_TIMEOUT_MS=30000', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.WATCHDOG_TIMEOUT_MS, 30000);
});

test('#14c: config has WATCHDOG_CHECK_INTERVAL_MS=10000', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.WATCHDOG_CHECK_INTERVAL_MS, 10000);
});

test('#14d: daemon.js has setupWatchdog function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('function setupWatchdog()'), 'setupWatchdog should exist');
  assert.ok(src.includes('lastFastTickTime'), 'should track lastFastTickTime');
  assert.ok(src.includes('watchdog_restarts'), 'should increment watchdog_restarts metric');
});

test('#14e: daemon.js fastTick updates lastFastTickTime', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/function fastTick\(\)[\s\S]*?lastFastTickTime = Date\.now\(\)/.test(src),
    'fastTick should set lastFastTickTime');
});

test('#14f: clearAllTimers includes watchdogTimer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/if \(watchdogTimer\)/.test(src), 'clearAllTimers should clear watchdogTimer');
});

test('#14g: CONFIG_SCHEMA has watchdog keys', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_WATCHDOG.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.WATCHDOG_TIMEOUT_MS.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.WATCHDOG_CHECK_INTERVAL_MS.type, 'number');
});

// ── #15: systemd unit name classification ──────────────────────────────

test('#15a: sensor exports getSystemdUnit function', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor.getSystemdUnit, 'function');
});

test('#15b: getSystemdUnit returns null for invalid PID', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(sensor.getSystemdUnit(-1), null);
  assert.strictEqual(sensor.getSystemdUnit(0), null);
  assert.strictEqual(sensor.getSystemdUnit(null), null);
  assert.strictEqual(sensor.getSystemdUnit('abc'), null);
});

test('#15c: getSystemdUnit returns null for dead PID', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const result = sensor.getSystemdUnit(2147483647);
  assert.strictEqual(result, null);
});

test('#15d: config has ENABLE_SYSTEMD_UNIT_CLASSIFICATION=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_SYSTEMD_UNIT_CLASSIFICATION, true);
});

test('#15e: CONFIG_SCHEMA has ENABLE_SYSTEMD_UNIT_CLASSIFICATION', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_SYSTEMD_UNIT_CLASSIFICATION.type, 'boolean');
});

// ── #16: Configurable battery low threshold ────────────────────────────

test('#16a: config has BATTERY_LOW_THRESHOLD=20', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.BATTERY_LOW_THRESHOLD, 20);
});

test('#16b: CONFIG_SCHEMA has BATTERY_LOW_THRESHOLD as number', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.BATTERY_LOW_THRESHOLD.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.BATTERY_LOW_THRESHOLD.min, 1);
  assert.strictEqual(CONFIG_SCHEMA.BATTERY_LOW_THRESHOLD.max, 50);
});

test('#16c: event-sources uses config BATTERY_LOW_THRESHOLD', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policy-engine', 'event-sources.js'), 'utf8');
  assert.ok(/this\._batteryLowThreshold = .*BATTERY_LOW_THRESHOLD/.test(src),
    'event-sources should use config.BATTERY_LOW_THRESHOLD instead of hardcoded 20');
  // Should NOT have the old hardcoded value as the sole source
  assert.ok(!/this\._batteryLowThreshold = 20;\s*\/\//.test(src),
    'should not have hardcoded 20 as the only value');
});

test('#16d: validateAndMerge accepts BATTERY_LOW_THRESHOLD override', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const { config } = validateAndMerge(DEFAULT_CONFIG, { BATTERY_LOW_THRESHOLD: 15 }, true);
  assert.strictEqual(config.BATTERY_LOW_THRESHOLD, 15);
});

// ── #13: NUMA-aware pinning ────────────────────────────────────────────

test('#13a: config has ENABLE_NUMA_AWARE_PINNING=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_NUMA_AWARE_PINNING, true);
});

test('#13b: CONFIG_SCHEMA has ENABLE_NUMA_AWARE_PINNING', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_NUMA_AWARE_PINNING.type, 'boolean');
});

test('#13c: cpu-topology.js has NUMA detection', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cpu-topology.js'), 'utf8');
  assert.ok(src.includes('detectNUMU') || src.includes('numaNodes'),
    'cpu-topology should detect NUMA nodes');
});

// ── #10: Per-app profile overrides ─────────────────────────────────────

test('#10a: per-app-profiles.js module exists and exports PerAppProfiles', () => {
  const { PerAppProfiles } = require('../per-app-profiles');
  assert.strictEqual(typeof PerAppProfiles, 'function');
});

test('#10b: PerAppProfiles getProfile returns null for unknown comm', () => {
  const { PerAppProfiles } = require('../per-app-profiles');
  const config = { ENABLE_PER_APP_PROFILES: true, PER_APP_PROFILES_DIR: '/nonexistent' };
  const p = new PerAppProfiles(config);
  assert.strictEqual(p.getProfile('nonexistent-app'), null);
});

test('#10c: PerAppProfiles returns null when disabled', () => {
  const { PerAppProfiles } = require('../per-app-profiles');
  const config = { ENABLE_PER_APP_PROFILES: false, PER_APP_PROFILES_DIR: null };
  const p = new PerAppProfiles(config);
  assert.strictEqual(p.getProfile('firefox'), null);
});

test('#10d: PerAppProfiles isProtected returns false when no profile', () => {
  const { PerAppProfiles } = require('../per-app-profiles');
  const config = { ENABLE_PER_APP_PROFILES: true, PER_APP_PROFILES_DIR: '/nonexistent' };
  const p = new PerAppProfiles(config);
  assert.strictEqual(p.isProtected('firefox'), false);
});

test('#10e: PerAppProfiles loads from real directory', () => {
  const { PerAppProfiles } = require('../per-app-profiles');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-profiles-'));
  try {
    // Write a test profile
    fs.writeFileSync(path.join(tmpDir, 'firefox.json'), JSON.stringify({
      name: 'firefox',
      schedClass: 'INTERACTIVE',
      nice: -3,
      protect: true,
    }));
    const config = { ENABLE_PER_APP_PROFILES: true, PER_APP_PROFILES_DIR: tmpDir };
    const p = new PerAppProfiles(config);
    p.reload();
    assert.strictEqual(p.profileCount, 1);
    const profile = p.getProfile('firefox');
    assert.ok(profile);
    assert.strictEqual(profile.schedClass, 'INTERACTIVE');
    assert.strictEqual(profile.nice, -3);
    assert.strictEqual(p.isProtected('firefox'), true);
    assert.strictEqual(p.getOverrideSchedClass('firefox'), 'INTERACTIVE');
    assert.strictEqual(p.getOverrideNice('firefox'), -3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#10f: config has ENABLE_PER_APP_PROFILES=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_PER_APP_PROFILES, true);
  assert.strictEqual(DEFAULT_CONFIG.PER_APP_PROFILES_DIR, null);
});

test('#10g: daemon.js initializes perAppProfiles in bootstrap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('PerAppProfiles'), 'daemon should import PerAppProfiles');
  assert.ok(/perAppProfiles = new PerAppProfiles/.test(src),
    'daemon should create PerAppProfiles instance');
  assert.ok(src.includes("ipcServer.registerHandler('profiles'"),
    'daemon should register profiles IPC handler');
});

// ── #9: GPU awareness ──────────────────────────────────────────────────

test('#9a: sensor exports getGpuUtilization function', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor.getGpuUtilization, 'function');
});

test('#9b: getGpuUtilization returns {type, utilization} shape', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const result = sensor.getGpuUtilization();
  assert.ok(typeof result === 'object');
  assert.ok('type' in result);
  assert.ok('utilization' in result);
  // type should be one of nvidia/intel/amd/none
  assert.ok(['nvidia', 'intel', 'amd', 'none'].includes(result.type));
});

test('#9c: config has GPU awareness keys', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_GPU_AWARENESS, true);
  assert.strictEqual(DEFAULT_CONFIG.GPU_BOUND_GPU_THRESHOLD, 80);
  assert.strictEqual(DEFAULT_CONFIG.GPU_BOUND_CPU_THRESHOLD, 10);
});

test('#9d: CONFIG_SCHEMA has GPU awareness keys', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_GPU_AWARENESS.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.GPU_BOUND_GPU_THRESHOLD.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.GPU_BOUND_CPU_THRESHOLD.type, 'number');
});

test('#9e: daemon.js reads GPU utilization in fastTick', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('getGpuUtilization'), 'daemon should call getGpuUtilization');
  assert.ok(/gpu_utilization/.test(src), 'daemon should record gpu_utilization metric');
});

// ── #12: Network awareness ─────────────────────────────────────────────

test('#12a: sensor exports getNetworkRxBytes function', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor.getNetworkRxBytes, 'function');
});

test('#12b: getNetworkRxBytes returns {rxBytes, txBytes} or null', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const result = sensor.getNetworkRxBytes();
  if (result !== null) {
    assert.ok(typeof result === 'object');
    assert.ok('rxBytes' in result);
    assert.ok('txBytes' in result);
    assert.strictEqual(typeof result.rxBytes, 'number');
    assert.strictEqual(typeof result.txBytes, 'number');
  }
});

test('#12c: config has network awareness keys', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_NETWORK_AWARENESS, true);
  assert.strictEqual(DEFAULT_CONFIG.NETWORK_HEAVY_RX_KBPS, 1024);
});

test('#12d: CONFIG_SCHEMA has network awareness keys', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_NETWORK_AWARENESS.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.NETWORK_HEAVY_RX_KBPS.type, 'number');
});

test('#12e: daemon.js reads network RX in fastTick', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('getNetworkRxBytes'), 'daemon should call getNetworkRxBytes');
  assert.ok(src.includes('networkRxKbps'), 'daemon should compute networkRxKbps');
  assert.ok(/network_rx_kbps/.test(src), 'daemon should record network_rx_kbps metric');
});

// ── #11: Learning mode ─────────────────────────────────────────────────

test('#11a: learning-logger.js module exists and exports LearningLogger', () => {
  const { LearningLogger } = require('../learning-logger');
  assert.strictEqual(typeof LearningLogger, 'function');
});

test('#11b: LearningLogger logAction is no-op when disabled', () => {
  const { LearningLogger } = require('../learning-logger');
  const config = { ENABLE_LEARNING_MODE: false, LEARNING_LOG_FILE: '/tmp/test-learn.log' };
  const ll = new LearningLogger(config);
  assert.doesNotThrow(() => ll.logAction('boost', { pid: 123, comm: 'test' }));
});

test('#11c: LearningLogger suggestRules returns enough=false when insufficient entries', () => {
  const { LearningLogger } = require('../learning-logger');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `dynalloc-learn-test-${process.pid}.log`);
  const config = {
    ENABLE_LEARNING_MODE: true,
    LEARNING_LOG_FILE: tmpFile,
    LEARNING_MIN_ENTRIES: 50,
  };
  const ll = new LearningLogger(config);
  // Write a few entries
  for (let i = 0; i < 5; i++) {
    ll.logAction('boost', { pid: 100 + i, comm: 'firefox' });
  }
  const result = ll.suggestRules();
  assert.strictEqual(result.enough, false);
  assert.ok(result.current < result.needed);
  try { fs.unlinkSync(tmpFile); } catch (_) {}
});

test('#11d: LearningLogger suggestRules returns suggestions when enough entries', () => {
  const { LearningLogger } = require('../learning-logger');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `dynalloc-learn-test-${process.pid}.log`);
  const config = {
    ENABLE_LEARNING_MODE: true,
    LEARNING_LOG_FILE: tmpFile,
    LEARNING_MIN_ENTRIES: 10,
  };
  const ll = new LearningLogger(config);
  // Write 10 boost entries for firefox
  for (let i = 0; i < 10; i++) {
    ll.logAction('boost', { pid: 100 + i, comm: 'firefox' });
  }
  const result = ll.suggestRules();
  assert.strictEqual(result.enough, true);
  assert.ok(result.suggestions.length > 0);
  const s = result.suggestions[0];
  assert.strictEqual(s.type, 'boost');
  assert.strictEqual(s.comm, 'firefox');
  assert.ok(s.rule.id.includes('firefox'));
  try { fs.unlinkSync(tmpFile); } catch (_) {}
});

test('#11e: LearningLogger clear removes log file', () => {
  const { LearningLogger } = require('../learning-logger');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `dynalloc-learn-clear-${process.pid}.log`);
  const config = {
    ENABLE_LEARNING_MODE: true,
    LEARNING_LOG_FILE: tmpFile,
    LEARNING_MIN_ENTRIES: 5,
  };
  const ll = new LearningLogger(config);
  ll.logAction('boost', { pid: 1, comm: 'test' });
  assert.ok(fs.existsSync(tmpFile));
  ll.clear();
  assert.ok(!fs.existsSync(tmpFile));
});

test('#11f: config has learning mode keys', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_LEARNING_MODE, false); // opt-in
  assert.strictEqual(DEFAULT_CONFIG.LEARNING_MIN_ENTRIES, 50);
  assert.strictEqual(DEFAULT_CONFIG.LEARNING_LOG_FILE, null);
});

test('#11g: CONFIG_SCHEMA has learning mode keys', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_LEARNING_MODE.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.LEARNING_MIN_ENTRIES.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.LEARNING_LOG_FILE.type, 'path');
  assert.ok(CONFIG_SCHEMA.LEARNING_LOG_FILE.nullable);
});

test('#11h: daemon.js initializes learningLogger and logs manual actions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('LearningLogger'), 'daemon should import LearningLogger');
  assert.ok(/learningLogger = new LearningLogger/.test(src),
    'daemon should create LearningLogger instance');
  assert.ok(src.includes("ipcServer.registerHandler('learn'"),
    'daemon should register learn IPC handler');
  // manualBoost should log to learningLogger
  assert.ok(/learningLogger\.logAction\('boost'/.test(src),
    'manualBoost should log to learningLogger');
  // manualThrottle should log to learningLogger
  assert.ok(/learningLogger\.logAction\('throttle'/.test(src),
    'manualThrottle should log to learningLogger');
});

// ── HOT_RELOADABLE_FIELDS includes all new keys ────────────────────────

test('HOT_RELOADABLE_FIELDS includes all v2.1.10 keys', () => {
  const { HOT_RELOADABLE_FIELDS } = require('../config');
  const expected = [
    'ENABLE_WATCHDOG', 'WATCHDOG_TIMEOUT_MS', 'WATCHDOG_CHECK_INTERVAL_MS',
    'BATTERY_LOW_THRESHOLD',
    'ENABLE_NUMA_AWARE_PINNING',
    'ENABLE_SYSTEMD_UNIT_CLASSIFICATION',
    'ENABLE_PER_APP_PROFILES', 'PER_APP_PROFILES_DIR',
    'ENABLE_GPU_AWARENESS', 'GPU_BOUND_GPU_THRESHOLD', 'GPU_BOUND_CPU_THRESHOLD',
    'ENABLE_NETWORK_AWARENESS', 'NETWORK_HEAVY_RX_KBPS',
    'ENABLE_LEARNING_MODE', 'LEARNING_LOG_FILE', 'LEARNING_MIN_ENTRIES',
  ];
  for (const field of expected) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(field),
      `${field} should be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Medium-priority feature tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1500);
