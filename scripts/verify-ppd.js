'use strict';

/**
 * Regression tests for v2.1.7 PPD (power-profiles-daemon) coordination.
 *
 * Tests cover:
 *   - sensor.checkPowerProfilesDaemon() returns correct shape
 *   - sensor.isPowerProfilesDaemonActive() async version works
 *   - self-check.checkPowerProfilesDaemon() reports PPD status
 *   - config has ENABLE_PPD_COORDINATION key with default true
 *   - daemon.js bootstrap mutes governor switch when PPD detected
 *   - CLI doctor shows PPD status + diagnostic
 *
 * Run with: node scripts/verify-ppd.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Verifying v2.1.7 PPD coordination...\n');

// ── Test: sensor.checkPowerProfilesDaemon ────────────────────────────────

test('Fix #50a: sensor exports checkPowerProfilesDaemon function', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor.checkPowerProfilesDaemon, 'function',
    'checkPowerProfilesDaemon should be a function');
});

test('Fix #50b: checkPowerProfilesDaemon returns {active, profile?} shape', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const result = sensor.checkPowerProfilesDaemon();
  assert.ok(typeof result === 'object', 'should return object');
  assert.ok('active' in result, 'should have active field');
  assert.strictEqual(typeof result.active, 'boolean',
    'active should be boolean');
  // If active is true, profile should be present
  if (result.active) {
    assert.ok('profile' in result, 'should have profile field when active');
    assert.strictEqual(typeof result.profile, 'string',
      'profile should be string');
  }
});

test('Fix #50c: checkPowerProfilesDaemon does not throw on systems without PPD', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  // The function should return a valid {active, profile?} object without throwing,
  // regardless of whether PPD is installed on the current system.
  let result;
  assert.doesNotThrow(() => { result = sensor.checkPowerProfilesDaemon(); });
  assert.ok(typeof result === 'object', 'should return an object');
  assert.ok('active' in result, 'should have active field');
  assert.strictEqual(typeof result.active, 'boolean', 'active should be a boolean');
});

test('Fix #50d: checkPowerProfilesDaemon returns {active: false} when gdbus unavailable', () => {
  // Stub execFileSync to throw (simulating gdbus not installed)
  delete require.cache[require.resolve('../sensor')];
  const origExecFileSync = execFileSync;
  // Patch the child_process module's execFileSync
  const cp = require('child_process');
  const origExec = cp.execFileSync;
  cp.execFileSync = function () {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  };
  try {
    const sensor = require('../sensor');
    const result = sensor.checkPowerProfilesDaemon();
    assert.strictEqual(result.active, false,
      'should return {active: false} when gdbus unavailable');
  } finally {
    cp.execFileSync = origExec;
    delete require.cache[require.resolve('../sensor')];
  }
});

// ── Test: sensor.isPowerProfilesDaemonActive (async) ─────────────────────

testAsync('Fix #51a: sensor exports isPowerProfilesDaemonActive async function', async () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor.isPowerProfilesDaemonActive, 'function',
    'isPowerProfilesDaemonActive should be a function');
});

testAsync('Fix #51b: isPowerProfilesDaemonActive returns Promise with {active} shape', async () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const result = await sensor.isPowerProfilesDaemonActive();
  assert.ok(typeof result === 'object', 'should return object');
  assert.ok('active' in result, 'should have active field');
  assert.strictEqual(typeof result.active, 'boolean');
});

// ── Test: self-check reports PPD ─────────────────────────────────────────

test('Fix #52a: self-check runSelfCheck includes powerProfilesDaemon field', () => {
  const { runSelfCheck } = require('../self-check');
  const report = runSelfCheck();
  assert.ok('powerProfilesDaemon' in report,
    'report should have powerProfilesDaemon field');
  assert.ok(typeof report.powerProfilesDaemon === 'object');
  assert.ok('active' in report.powerProfilesDaemon);
});

test('Fix #52b: self-check checkPowerProfilesDaemon function exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('function checkPowerProfilesDaemon()'),
    'checkPowerProfilesDaemon function should exist in self-check.js');
  // Should query the PPD DBus interface
  assert.ok(src.includes('net.hadess.PowerProfiles'),
    'should query net.hadess.PowerProfiles DBus service');
  assert.ok(src.includes('ActiveProfile'),
    'should query ActiveProfile property');
});

test('Fix #52c: self-check printReport shows PPD status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('Power Profiles Daemon:'),
    'printReport should show Power Profiles Daemon status');
  assert.ok(src.includes('ppd.active'),
    'printReport should check ppd.active');
  assert.ok(src.includes('ppd.profile'),
    'printReport should show ppd.profile');
});

test('Fix #52d: self-check capabilities include POWER_PROFILES_DAEMON', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes("POWER_PROFILES_DAEMON"),
    'capabilities list should include POWER_PROFILES_DAEMON');
});

// ── Test: config has ENABLE_PPD_COORDINATION ─────────────────────────────

test('Fix #53a: DEFAULT_CONFIG has ENABLE_PPD_COORDINATION=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_PPD_COORDINATION, true,
    'ENABLE_PPD_COORDINATION should default to true');
});

test('Fix #53b: CONFIG_SCHEMA has ENABLE_PPD_COORDINATION as boolean', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.ok('ENABLE_PPD_COORDINATION' in CONFIG_SCHEMA,
    'CONFIG_SCHEMA should have ENABLE_PPD_COORDINATION');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_PPD_COORDINATION.type, 'boolean');
});

test('Fix #53c: HOT_RELOADABLE_FIELDS includes ENABLE_PPD_COORDINATION', () => {
  const { HOT_RELOADABLE_FIELDS } = require('../config');
  assert.ok(HOT_RELOADABLE_FIELDS.includes('ENABLE_PPD_COORDINATION'),
    'ENABLE_PPD_COORDINATION should be hot-reloadable');
});

// ── Test: daemon.js bootstrap mutes governor switch when PPD detected ────

test('Fix #54a: daemon.js imports checkPowerProfilesDaemon from sensor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('checkPowerProfilesDaemon'),
    'daemon.js should import checkPowerProfilesDaemon');
});

test('Fix #54b: daemon.js bootstrap checks PPD before governor setup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The PPD check should be in the governor section (step 9)
  assert.ok(/ENABLE_PPD_COORDINATION/.test(src),
    'daemon should check ENABLE_PPD_COORDINATION');
  assert.ok(/checkPowerProfilesDaemon\(\)/.test(src),
    'daemon should call checkPowerProfilesDaemon()');
  // When PPD is active, it should set ENABLE_GOVERNOR_SWITCH = false
  assert.ok(/CONFIG\.ENABLE_GOVERNOR_SWITCH = false/.test(src),
    'daemon should mute ENABLE_GOVERNOR_SWITCH when PPD detected');
});

test('Fix #54c: daemon.js logs warning when PPD detected', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('Power Profiles Daemon (PPD) terdeteksi'),
    'daemon should log PPD detection warning');
  assert.ok(src.includes('Governor switching dimatikan'),
    'daemon should log governor switch muting warning');
  assert.ok(src.includes('ENABLE_PPD_COORDINATION=false'),
    'daemon should mention how to override (ENABLE_PPD_COORDINATION=false)');
});

test('Fix #54d: daemon.js respects ENABLE_PPD_COORDINATION=false (skip PPD check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The PPD check should be guarded by ENABLE_PPD_COORDINATION
  assert.ok(/CONFIG\.ENABLE_GOVERNOR_SWITCH && CONFIG\.ENABLE_PPD_COORDINATION/.test(src),
    'PPD check should be guarded by both ENABLE_GOVERNOR_SWITCH && ENABLE_PPD_COORDINATION');
});

test('Fix #54e: daemon.js logs when governor switch is disabled', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // After the PPD check, if ENABLE_GOVERNOR_SWITCH is still false, log it
  assert.ok(/else if \(!CONFIG\.ENABLE_GOVERNOR_SWITCH\)/.test(src),
    'daemon should have else-if branch for disabled governor switch');
  assert.ok(src.includes('CPU governor switching dimatikan'),
    'daemon should log when governor switch is disabled');
});

// ── Test: CLI doctor shows PPD ────────────────────────────────────────────

test('Fix #55a: doctor-engine reports Power Profiles Daemon status', () => {
  const DoctorEngineModule = require('../intelligence/doctor-engine');
  const DoctorEngine = DoctorEngineModule.DoctorEngine || DoctorEngineModule;
  const engine = new DoctorEngine();
  const result = engine.run({
    config: { ENABLE_PPD_COORDINATION: true },
    selfCheckReport: { cpufreq: { available: true }, powerProfilesDaemon: { active: true, profile: 'performance' } },
    daemonState: {},
  });
  const ppdCheck = result.checks.find(c => c.name === 'Power Profiles Daemon');
  assert.ok(ppdCheck, 'doctor should check Power Profiles Daemon');
  assert.ok(ppdCheck.message.includes('performance'), 'doctor should report the active PPD profile');
});

test('Fix #55b: doctor-engine shows PPD diagnostic when active', () => {
  const DoctorEngineModule = require('../intelligence/doctor-engine');
  const DoctorEngine = DoctorEngineModule.DoctorEngine || DoctorEngineModule;
  const engine = new DoctorEngine();
  const result = engine.run({
    config: { ENABLE_PPD_COORDINATION: true },
    selfCheckReport: { cpufreq: { available: true }, powerProfilesDaemon: { active: true, profile: 'performance' } },
    daemonState: {},
  });
  const coordCheck = result.checks.find(c => c.name === 'Governor / PPD Coordination');
  assert.ok(coordCheck, 'doctor should check if PPD is active for diagnostic');
  assert.ok(coordCheck.message.includes('DynAlloc governor switching is muted'),
    'doctor should mention governor switch is muted when PPD active');
  assert.ok(coordCheck.message.includes('ENABLE_PPD_COORDINATION=false to override'),
    'doctor should mention how to override');
});

// ── Test: validateAndMerge with PPD config ────────────────────────────────

test('Fix #56: validateAndMerge accepts ENABLE_PPD_COORDINATION override', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, {
    ENABLE_PPD_COORDINATION: false,
  }, true);
  assert.strictEqual(config.ENABLE_PPD_COORDINATION, false,
    'ENABLE_PPD_COORDINATION should be overridable to false');
  assert.strictEqual(warnings.length, 0, 'should have no validation warnings');
});

// ── Test: PPD DBus interface details ──────────────────────────────────────

test('Fix #57a: PPD detection queries system bus (not session)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sensor.js'), 'utf8');
  // PPD runs on the system bus, not the session bus
  assert.ok(/'--system'/.test(src),
    'checkPowerProfilesDaemon should use --system bus');
  // GameMode uses --session, PPD uses --system — verify they're different
  const ppdSection = src.substring(src.indexOf('checkPowerProfilesDaemon'));
  assert.ok(ppdSection.includes('--system'),
    'PPD detection should use --system bus');
  assert.ok(ppdSection.includes('net.hadess.PowerProfiles'),
    'PPD detection should query net.hadess.PowerProfiles');
  assert.ok(ppdSection.includes('/net/hadess/PowerProfiles'),
    'PPD detection should use /net/hadess/PowerProfiles object path');
  assert.ok(ppdSection.includes('ActiveProfile'),
    'PPD detection should query ActiveProfile property');
});

test('Fix #57b: PPD detection parses profile from DBus response', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sensor.js'), 'utf8');
  // The parser should extract the profile string from the DBus response
  // Response format: (<uint32 0>, '<"balanced">')
  assert.ok(/<["']\(\\[\^"'\]\+\)\["']>/.test(src) || /<["']([^"']+)["']>/.test(src),
    'checkPowerProfilesDaemon should parse profile from DBus response');
});

// ── Test: end-to-end self-check report ────────────────────────────────────

test('Fix #58: self-check report includes powerProfilesDaemon with correct shape', () => {
  const { runSelfCheck } = require('../self-check');
  const report = runSelfCheck();
  const ppd = report.powerProfilesDaemon;
  assert.ok(typeof ppd === 'object');
  assert.strictEqual(typeof ppd.active, 'boolean');
  // In test env, PPD is likely not running
  if (!ppd.active) {
    // When not active, profile field may be absent — that's OK
    assert.ok(!('profile' in ppd) || ppd.profile === undefined,
      'profile should be absent/undefined when PPD not active');
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PPD coordination tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
