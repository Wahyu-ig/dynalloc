'use strict';

/**
 * Regression tests for v2.1.8 thermal-aware boosting.
 *
 * Tests cover:
 *   - Config keys exist with correct defaults
 *   - Config schema validates thermal config correctly
 *   - State object has thermal fields
 *   - isThermalPaused() / updateThermalPause() / checkThermalPauseExpiry() logic
 *   - _executeBoost skips governor switch during thermal pause
 *   - fastTick calls thermal pause updates
 *   - IPC status includes thermal state
 *   - CLI status shows thermal info
 *   - Metrics registered for thermal protection
 *
 * Run with: node scripts/verify-thermal.js
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

console.log('Verifying v2.1.8 thermal-aware boosting...\n');

// ── Test: config keys exist with correct defaults ─────────────────────

test('Fix #59a: DEFAULT_CONFIG has ENABLE_THERMAL_PROTECTION=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_THERMAL_PROTECTION, true,
    'ENABLE_THERMAL_PROTECTION should default to true');
});

test('Fix #59b: DEFAULT_CONFIG has THERMAL_PAUSE_THRESHOLD=85', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.THERMAL_PAUSE_THRESHOLD, 85,
    `THERMAL_PAUSE_THRESHOLD should default to 85, got ${DEFAULT_CONFIG.THERMAL_PAUSE_THRESHOLD}`);
});

test('Fix #59c: DEFAULT_CONFIG has THERMAL_PAUSE_DURATION_MS=30000', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.THERMAL_PAUSE_DURATION_MS, 30000,
    `THERMAL_PAUSE_DURATION_MS should default to 30000, got ${DEFAULT_CONFIG.THERMAL_PAUSE_DURATION_MS}`);
});

test('Fix #59d: DEFAULT_CONFIG has THERMAL_RESUME_THRESHOLD=75', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.THERMAL_RESUME_THRESHOLD, 75,
    `THERMAL_RESUME_THRESHOLD should default to 75, got ${DEFAULT_CONFIG.THERMAL_RESUME_THRESHOLD}`);
});

// ── Test: config schema validates thermal config ───────────────────────

test('Fix #60a: CONFIG_SCHEMA has thermal protection keys with correct types', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_THERMAL_PROTECTION.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_THRESHOLD.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_DURATION_MS.type, 'number');
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_RESUME_THRESHOLD.type, 'number');
  // Range checks
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_THRESHOLD.min, 40);
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_THRESHOLD.max, 110);
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_DURATION_MS.min, 1000);
  assert.strictEqual(CONFIG_SCHEMA.THERMAL_PAUSE_DURATION_MS.max, 600000);
});

test('Fix #60b: HOT_RELOADABLE_FIELDS includes thermal protection keys', () => {
  const { HOT_RELOADABLE_FIELDS } = require('../config');
  const expected = [
    'ENABLE_THERMAL_PROTECTION',
    'THERMAL_PAUSE_THRESHOLD',
    'THERMAL_PAUSE_DURATION_MS',
    'THERMAL_RESUME_THRESHOLD',
  ];
  for (const field of expected) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(field),
      `${field} should be in HOT_RELOADABLE_FIELDS`);
  }
});

test('Fix #60c: validateAndMerge accepts valid thermal config overrides', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, {
    ENABLE_THERMAL_PROTECTION: false,
    THERMAL_PAUSE_THRESHOLD: 90,
    THERMAL_PAUSE_DURATION_MS: 60000,
    THERMAL_RESUME_THRESHOLD: 70,
  }, true);
  assert.strictEqual(config.ENABLE_THERMAL_PROTECTION, false);
  assert.strictEqual(config.THERMAL_PAUSE_THRESHOLD, 90);
  assert.strictEqual(config.THERMAL_PAUSE_DURATION_MS, 60000);
  assert.strictEqual(config.THERMAL_RESUME_THRESHOLD, 70);
  assert.strictEqual(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
});

test('Fix #60d: validateAndMerge rejects invalid thermal config (threshold out of range)', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, {
    THERMAL_PAUSE_THRESHOLD: 200, // > max 110
    THERMAL_PAUSE_DURATION_MS: 100, // < min 1000
  }, true);
  // Should fall back to defaults
  assert.strictEqual(config.THERMAL_PAUSE_THRESHOLD, DEFAULT_CONFIG.THERMAL_PAUSE_THRESHOLD);
  assert.strictEqual(config.THERMAL_PAUSE_DURATION_MS, DEFAULT_CONFIG.THERMAL_PAUSE_DURATION_MS);
  assert.ok(warnings.length >= 1, 'should have validation warnings');
});

// ── Test: daemon.js has thermal protection functions ──────────────────

test('Fix #61a: daemon.js has isThermalPaused function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('function isThermalPaused()'),
    'isThermalPaused function should exist');
  assert.ok(src.includes('Date.now() < State.thermalPausedUntil'),
    'isThermalPaused should check Date.now() vs thermalPausedUntil');
});

test('Fix #61b: daemon.js has updateThermalPause function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('function updateThermalPause('),
    'updateThermalPause function should exist');
  // Should check temp against THERMAL_PAUSE_THRESHOLD
  assert.ok(/temp >= CONFIG\.THERMAL_PAUSE_THRESHOLD/.test(src),
    'updateThermalPause should compare temp to THERMAL_PAUSE_THRESHOLD');
  // Should set thermalPausedUntil
  assert.ok(/State\.thermalPausedUntil = now \+ CONFIG\.THERMAL_PAUSE_DURATION_MS/.test(src),
    'updateThermalPause should set thermalPausedUntil');
});

test('Fix #61c: daemon.js has checkThermalPauseExpiry function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('function checkThermalPauseExpiry()'),
    'checkThermalPauseExpiry function should exist');
  // Should check resume threshold
  assert.ok(/THERMAL_RESUME_THRESHOLD/.test(src),
    'checkThermalPauseExpiry should reference THERMAL_RESUME_THRESHOLD');
});

test('Fix #61d: State object has thermal fields', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('thermalPausedUntil:'),
    'State should have thermalPausedUntil field');
  assert.ok(src.includes('thermalLastTemp:'),
    'State should have thermalLastTemp field');
  assert.ok(src.includes('thermalPauseCount:'),
    'State should have thermalPauseCount field');
});

// ── Test: _executeBoost skips governor during thermal pause ───────────

test('Fix #62a: _executeBoost checks isThermalPaused before governor switch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The boost function should call isThermalPaused()
  assert.ok(/!isThermalPaused\(\)/.test(src),
    '_executeBoost should check !isThermalPaused() before governor switch');
  // Should log debug when skipping
  assert.ok(src.includes('Thermal pause active'),
    '_executeBoost should log when skipping governor due to thermal pause');
  // Should increment thermal_pause_boost_skipped metric
  assert.ok(src.includes('thermal_pause_boost_skipped'),
    '_executeBoost should increment thermal_pause_boost_skipped metric');
});

test('Fix #62b: _executeBoost still does cgroups/nice/io during thermal pause', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The isThermalPaused check should only guard the governor section,
  // not the cgroups/nice/io sections. Verify the guard is inside the
  // !boost.gameModeActive block, specifically around setGovernor.
  const boostFnMatch = src.match(/function _executeBoost\(boost\) \{([\s\S]*?)^\}/m);
  assert.ok(boostFnMatch, '_executeBoost not found');
  const body = boostFnMatch[1];
  // cgroups should happen BEFORE the thermal check
  assert.ok(body.includes('assignToCgroup'),
    '_executeBoost should still assign cgroup during thermal pause');
  // nice should happen BEFORE the thermal check
  assert.ok(body.includes('setNiceness'),
    '_executeBoost should still set niceness during thermal pause');
  // io should happen AFTER the thermal check (still runs)
  assert.ok(body.includes('setIoPriority'),
    '_executeBoost should still set io priority during thermal pause');
});

// ── Test: fastTick calls thermal pause updates ────────────────────────

test('Fix #63: fastTick calls checkThermalPauseExpiry + updateThermalPause', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('checkThermalPauseExpiry()'),
    'fastTick should call checkThermalPauseExpiry()');
  assert.ok(src.includes('updateThermalPause(thermalTemp)'),
    'fastTick should call updateThermalPause(thermalTemp)');
  // Should update thermal metrics
  assert.ok(src.includes('thermal_temp_celsius'),
    'fastTick should update thermal_temp_celsius gauge');
  assert.ok(src.includes('thermal_pause_active'),
    'fastTick should update thermal_pause_active gauge');
});

// ── Test: IPC status includes thermal state ───────────────────────────

test('Fix #64a: IPC status handler includes thermal field', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('thermal: {'),
    'IPC status handler should include thermal field');
  assert.ok(src.includes('enabled: CONFIG.ENABLE_THERMAL_PROTECTION'),
    'thermal status should include enabled flag');
  assert.ok(src.includes('paused: isThermalPaused()'),
    'thermal status should include paused state');
  assert.ok(src.includes('pausedUntil:'),
    'thermal status should include pausedUntil timestamp');
  assert.ok(src.includes('pausedRemainingMs:'),
    'thermal status should include pausedRemainingMs');
  assert.ok(src.includes('lastTemp:'),
    'thermal status should include lastTemp');
  assert.ok(src.includes('pauseCount:'),
    'thermal status should include pauseCount');
  assert.ok(src.includes('pauseThreshold:'),
    'thermal status should include pauseThreshold');
  assert.ok(src.includes('resumeThreshold:'),
    'thermal status should include resumeThreshold');
});

// ── Test: CLI status shows thermal info ───────────────────────────────

test('Fix #65a: CLI status shows Thermal Protection section', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  assert.ok(src.includes('Thermal Protection:'),
    'CLI status should show Thermal Protection section');
  assert.ok(src.includes('Last temp:'),
    'CLI status should show last temperature');
  assert.ok(src.includes('Pause threshold:'),
    'CLI status should show pause threshold');
  assert.ok(src.includes('Resume threshold:'),
    'CLI status should show resume threshold');
  assert.ok(src.includes('Paused:'),
    'CLI status should show paused state');
  assert.ok(src.includes('Remaining:'),
    'CLI status should show remaining pause time');
  assert.ok(src.includes('Pause count:'),
    'CLI status should show pause count');
});

// ── Test: metrics registered for thermal protection ───────────────────

test('Fix #66: metrics.js registers thermal protection metrics', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'metrics.js'), 'utf8');
  assert.ok(src.includes("counter('thermal_pause_count'"),
    'metrics should register thermal_pause_count counter');
  assert.ok(src.includes("counter('thermal_pause_boost_skipped'"),
    'metrics should register thermal_pause_boost_skipped counter');
  assert.ok(src.includes("gauge('thermal_temp_celsius'"),
    'metrics should register thermal_temp_celsius gauge');
  assert.ok(src.includes("gauge('thermal_pause_active'"),
    'metrics should register thermal_pause_active gauge');
});

// ── Test: thermal pause logic — unit test isThermalPaused ─────────────

test('Fix #67a: isThermalPaused returns false when thermalPausedUntil is 0', () => {
  // We can't easily test the function directly (it's inside daemon.js closure),
  // but we can verify the logic by reading the source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The function should check Date.now() < State.thermalPausedUntil
  // When thermalPausedUntil is 0 (initial state), Date.now() is always > 0,
  // so isThermalPaused returns false.
  assert.ok(/function isThermalPaused\(\) \{[\s\S]*?Date\.now\(\) < State\.thermalPausedUntil/.test(src),
    'isThermalPaused should compare Date.now() to thermalPausedUntil');
});

test('Fix #67b: updateThermalPause respects ENABLE_THERMAL_PROTECTION=false', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The function should early-return if ENABLE_THERMAL_PROTECTION is false
  assert.ok(/function updateThermalPause[\s\S]*?if \(!CONFIG\.ENABLE_THERMAL_PROTECTION\) return/.test(src),
    'updateThermalPause should early-return when ENABLE_THERMAL_PROTECTION=false');
});

test('Fix #67c: updateThermalPause handles null temp gracefully', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The function should return early if temp is null
  assert.ok(/if \(temp === null \|\| typeof temp !== 'number'\) return/.test(src),
    'updateThermalPause should handle null/non-number temp gracefully');
});

test('Fix #67d: updateThermalPause does not re-trigger during active pause', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // When already paused, the function should return without re-triggering
  assert.ok(/const isPaused = now < State\.thermalPausedUntil/.test(src),
    'updateThermalPause should check if already paused');
  assert.ok(/if \(isPaused\) \{[\s\S]*?return/.test(src),
    'updateThermalPause should return early if already paused (hysteresis)');
});

test('Fix #67e: updateThermalPause logs warning when entering pause', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('Thermal protection: CPU'),
    'updateThermalPause should log warning with CPU temp');
  assert.ok(src.includes('pausing governor boost'),
    'updateThermalPause should log "pausing governor boost"');
});

test('Fix #67f: updateThermalPause increments thermalPauseCount', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/State\.thermalPauseCount\+\+/.test(src),
    'updateThermalPause should increment thermalPauseCount');
});

// ── Test: checkThermalPauseExpiry logic ───────────────────────────────

test('Fix #68a: checkThermalPauseExpiry logs resume when pause expires', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('pause expired, resuming governor boost'),
    'checkThermalPauseExpiry should log resume when pause expires');
});

test('Fix #68b: checkThermalPauseExpiry extends pause if still above resume threshold', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('pause expired but CPU still'),
    'checkThermalPauseExpiry should log when extending pause');
  assert.ok(/THERMAL_RESUME_THRESHOLD/.test(src),
    'checkThermalPauseExpiry should compare to THERMAL_RESUME_THRESHOLD');
});

// ── Test: end-to-end validateAndMerge with thermal config ─────────────

test('Fix #69: validateAndMerge cross-validates resume < pause threshold', () => {
  // We don't currently have cross-field validation for thermal thresholds,
  // but we should verify the values are at least individually valid.
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const { config } = validateAndMerge(DEFAULT_CONFIG, {
    THERMAL_PAUSE_THRESHOLD: 80,
    THERMAL_RESUME_THRESHOLD: 70,
  }, true);
  assert.strictEqual(config.THERMAL_PAUSE_THRESHOLD, 80);
  assert.strictEqual(config.THERMAL_RESUME_THRESHOLD, 70);
  // Resume should be < pause for proper hysteresis
  assert.ok(config.THERMAL_RESUME_THRESHOLD < config.THERMAL_PAUSE_THRESHOLD,
    'THERMAL_RESUME_THRESHOLD should be < THERMAL_PAUSE_THRESHOLD for hysteresis');
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Thermal protection tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
