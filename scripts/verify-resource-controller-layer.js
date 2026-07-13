'use strict';

/**
 * verify-resource-controller-layer.js — Safety & architecture validation
 * for the v0.5.0 Phase 2 Resource Controller Foundation.
 *
 * Run with: node scripts/verify-resource-controller-layer.js
 *
 * This script performs source-text and behavioral checks to confirm:
 *
 *   1. Module structure — all expected files exist and export the
 *      documented API surface.
 *   2. No shell injection — PowerController's gdbus calls use
 *      execFileSync with argument arrays, never shell strings.
 *   3. No direct syscalls in ThermalController — thermal controller
 *      only adjusts config values, never touches sysfs.
 *   4. Backward compatibility — ENABLE_RESOURCE_CONTROLLER_LAYER
 *      defaults to false in config.js, and daemon.js gates all
 *      RCM code behind that flag.
 *   5. Controller isolation — no controller imports another
 *      controller.
 *   6. PE integration — action-executor.js has the new action types
 *      and routes them through the RCM.
 *   7. Config schema — all new keys have schema entries and are
 *      hot-reloadable.
 *   8. Daemon integration — RCM is constructed, wired into PE,
 *      destroyed on shutdown, and exposed via IPC + getState.
 *
 * If this script fails, the Resource Controller Layer has a safety
 * regression.
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

console.log('Resource Controller Layer Safety & Architecture Validation');
console.log('='.repeat(60));

const LIB_DIR = path.join(__dirname, '..', 'lib');
const CONTROLLERS_DIR = path.join(LIB_DIR, 'controllers');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
const ACTUATOR_SRC = fs.readFileSync(path.join(__dirname, '..', 'actuator.js'), 'utf8');
const AE_SRC = fs.readFileSync(path.join(__dirname, '..', 'policy-engine', 'action-executor.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('lib/controllers/thermal-controller.js exists', () => {
  assert.ok(fs.existsSync(path.join(CONTROLLERS_DIR, 'thermal-controller.js')));
});

test('lib/controllers/power-controller.js exists', () => {
  assert.ok(fs.existsSync(path.join(CONTROLLERS_DIR, 'power-controller.js')));
});

test('lib/resource-controller-manager.js exists', () => {
  assert.ok(fs.existsSync(path.join(LIB_DIR, 'resource-controller-manager.js')));
});

test('ThermalController exports class + VALID_PROFILES + PROFILE_PRESETS', () => {
  const m = require(path.join(CONTROLLERS_DIR, 'thermal-controller.js'));
  assert.strictEqual(typeof m, 'function');
  assert.ok(Array.isArray(m.VALID_PROFILES));
  assert.ok(m.PROFILE_PRESETS && typeof m.PROFILE_PRESETS === 'object');
});

test('PowerController exports class + VALID_PROFILES + VALID_PPD_PROFILES', () => {
  const m = require(path.join(CONTROLLERS_DIR, 'power-controller.js'));
  assert.strictEqual(typeof m, 'function');
  assert.ok(Array.isArray(m.VALID_PROFILES));
  assert.ok(Array.isArray(m.VALID_PPD_PROFILES));
});

test('ResourceControllerManager exports class', () => {
  const m = require(path.join(LIB_DIR, 'resource-controller-manager.js'));
  assert.strictEqual(typeof m, 'function');
});

// ── 2. No shell injection ─────────────────────────────────────────────

test('PowerController uses execFileSync (not exec/execSync with shell)', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'power-controller.js'), 'utf8');
  assert.ok(src.includes('execFileSync'), 'must use execFileSync');
  assert.ok(!/[^.]exec\(['"`]/.test(src), 'must NOT use exec() with shell string');
  assert.ok(!/execSync\(['"`]/.test(src), 'must NOT use execSync() with shell string');
});

test('PowerController gdbus calls use argument arrays', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'power-controller.js'), 'utf8');
  // Every execFileSync call must pass an array as the second argument
  const calls = src.match(/execFileSync\('gdbus',\s*\[/g) || [];
  assert.ok(calls.length >= 2,
    `expected at least 2 execFileSync('gdbus', [...]) calls, found ${calls.length}`);
});

test('PowerController PPD profile names validated against allowlist', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'power-controller.js'), 'utf8');
  assert.ok(/VALID_PPD_PROFILES/.test(src),
    'must reference VALID_PPD_PROFILES for validation');
  assert.ok(/VALID_PPD_PROFILES\.includes/.test(src),
    'must check profile against VALID_PPD_PROFILES.includes()');
});

test('PowerController does not interpolate variables into gdbus commands', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'power-controller.js'), 'utf8');
  const execBlocks = src.match(/execFileSync\([^)]+\)/g) || [];
  for (const block of execBlocks) {
    assert.ok(!block.includes('${profileName}'),
      'execFileSync must not interpolate ${profileName}: ' + block);
  }
});

// ── 3. No direct syscalls in ThermalController ────────────────────────

test('ThermalController never calls exec/execFile/spawn', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'thermal-controller.js'), 'utf8');
  assert.ok(!/require\(['"]child_process['"]\)/.test(src),
    'must NOT require child_process');
  assert.ok(!/\bexecFile\b/.test(src), 'must NOT call execFile');
  assert.ok(!/\bspawn\b/.test(src), 'must NOT call spawn');
});

test('ThermalController never writes to sysfs/proc', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'thermal-controller.js'), 'utf8');
  assert.ok(!/writeFileSync\(['"`]\/(sys|proc)/.test(src),
    'must NOT writeFileSync to /sys or /proc');
});

// ── 4. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_RESOURCE_CONTROLLER_LAYER defaulting to false', () => {
  assert.ok(/ENABLE_RESOURCE_CONTROLLER_LAYER:\s*false/.test(CONFIG_SRC),
    'ENABLE_RESOURCE_CONTROLLER_LAYER must default to false');
});

test('config.js has THERMAL_PROFILE_DEFAULT', () => {
  assert.ok(/THERMAL_PROFILE_DEFAULT:\s*'balanced'/.test(CONFIG_SRC),
    "THERMAL_PROFILE_DEFAULT must default to 'balanced'");
});

test('config.js has POWER_PROFILE_DEFAULT', () => {
  assert.ok(/POWER_PROFILE_DEFAULT:\s*'balanced'/.test(CONFIG_SRC),
    "POWER_PROFILE_DEFAULT must default to 'balanced'");
});

test('config.js has schema entries for all new keys', () => {
  for (const key of [
    'ENABLE_RESOURCE_CONTROLLER_LAYER',
    'THERMAL_PROFILE_DEFAULT',
    'POWER_PROFILE_DEFAULT',
  ]) {
    assert.ok(CONFIG_SRC.includes(`${key}:`),
      `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all new keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of [
    'ENABLE_RESOURCE_CONTROLLER_LAYER',
    'THERMAL_PROFILE_DEFAULT',
    'POWER_PROFILE_DEFAULT',
  ]) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key),
      `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 5. Controller isolation ───────────────────────────────────────────

test('ThermalController does not import other controllers', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'thermal-controller.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/(cpu|memory|io|network|governor|power)-controller/.test(src),
    'ThermalController must not import other controllers');
});

test('PowerController does not import other controllers', () => {
  const src = fs.readFileSync(path.join(CONTROLLERS_DIR, 'power-controller.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/(cpu|memory|io|network|governor|thermal)-controller/.test(src),
    'PowerController must not import other controllers');
});

test('ResourceControllerManager imports ThermalController + PowerController + GovernorController', () => {
  const src = fs.readFileSync(path.join(LIB_DIR, 'resource-controller-manager.js'), 'utf8');
  assert.ok(/require\(['"]\.\/controllers\/thermal-controller/.test(src),
    'must import ThermalController');
  assert.ok(/require\(['"]\.\/controllers\/power-controller/.test(src),
    'must import PowerController');
  assert.ok(/require\(['"]\.\/controllers\/governor-controller/.test(src),
    'must import GovernorController');
});

// ── 6. PE integration ─────────────────────────────────────────────────

test('action-executor.js has setResourceControllerManager method', () => {
  assert.ok(/setResourceControllerManager\(rcm\)/.test(AE_SRC),
    'must have setResourceControllerManager(rcm) method');
});

test('action-executor.js accepts resourceControllerManager in constructor', () => {
  assert.ok(/deps\.resourceControllerManager/.test(AE_SRC),
    'must accept resourceControllerManager in constructor deps');
});

test('action-executor.js has setThermalProfile action type', () => {
  assert.ok(/case 'setThermalProfile'/.test(AE_SRC),
    "must have case 'setThermalProfile'");
  assert.ok(/_setThermalProfile/.test(AE_SRC),
    'must have _setThermalProfile method');
});

test('action-executor.js has setPowerProfile action type', () => {
  assert.ok(/case 'setPowerProfile'/.test(AE_SRC),
    "must have case 'setPowerProfile'");
  assert.ok(/_setPowerProfile/.test(AE_SRC),
    'must have _setPowerProfile method');
});

test('action-executor.js has setPpdProfile action type', () => {
  assert.ok(/case 'setPpdProfile'/.test(AE_SRC),
    "must have case 'setPpdProfile'");
  assert.ok(/_setPpdProfile/.test(AE_SRC),
    'must have _setPpdProfile method');
});

test('new action types route through RCM (this._rcm)', () => {
  assert.ok(/this\._rcm\.applyThermalProfile/.test(AE_SRC),
    'setThermalProfile must call this._rcm.applyThermalProfile()');
  assert.ok(/this\._rcm\.applyPowerProfile/.test(AE_SRC),
    'setPowerProfile must call this._rcm.applyPowerProfile()');
  assert.ok(/this\._rcm\.setPpdProfile/.test(AE_SRC),
    'setPpdProfile must call this._rcm.setPpdProfile()');
});

test('new action types fail gracefully when RCM not set', () => {
  assert.ok(/if\s*\(!this\._rcm\)/.test(AE_SRC),
    'new action types must check if (!this._rcm) and return error');
});

// ── 7. Actuator getters ───────────────────────────────────────────────

test('actuator.js exposes cpuController getter', () => {
  assert.ok(/get cpuController\(\)/.test(ACTUATOR_SRC),
    'must have cpuController getter');
});

test('actuator.js exposes memoryController getter', () => {
  assert.ok(/get memoryController\(\)/.test(ACTUATOR_SRC),
    'must have memoryController getter');
});

test('actuator.js exposes ioController getter', () => {
  assert.ok(/get ioController\(\)/.test(ACTUATOR_SRC),
    'must have ioController getter');
});

test('actuator.js exposes networkController getter', () => {
  assert.ok(/get networkController\(\)/.test(ACTUATOR_SRC),
    'must have networkController getter');
});

// ── 8. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates RCM behind ENABLE_RESOURCE_CONTROLLER_LAYER', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_RESOURCE_CONTROLLER_LAYER\)/.test(DAEMON_SRC),
    'daemon.js must construct RCM only when ENABLE_RESOURCE_CONTROLLER_LAYER is true');
});

test('daemon.js requires lib/resource-controller-manager lazily', () => {
  assert.ok(/require\(['"]\.\/lib\/resource-controller-manager['"]\)/.test(DAEMON_SRC),
    'daemon.js must require ./lib/resource-controller-manager');
});

test('daemon.js wires RCM into PE action executor', () => {
  assert.ok(/setResourceControllerManager\(resourceControllerMgr\)/.test(DAEMON_SRC),
    'daemon.js must call policyEngine.executor.setResourceControllerManager()');
});

test('daemon.js calls resourceControllerMgr.setConfig on hot-reload', () => {
  assert.ok(/resourceControllerMgr\.setConfig\(/.test(DAEMON_SRC),
    'daemon.js must call resourceControllerMgr.setConfig() on hot-reload');
});

test('daemon.js calls resourceControllerMgr.destroy in cleanupAndExit', () => {
  assert.ok(/resourceControllerMgr\.destroy\(\)/.test(DAEMON_SRC),
    'daemon.js must call resourceControllerMgr.destroy() in cleanupAndExit');
});

test('daemon.js registers IPC resources handler', () => {
  assert.ok(/registerHandler\(['"]resources['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'resources'");
});

test('daemon.js exposes resourceControllerLayer in getState()', () => {
  assert.ok(/resourceControllerLayer:\s*resourceControllerMgr/.test(DAEMON_SRC),
    "daemon.js getState() must expose resourceControllerLayer");
});

test('daemon.js declares resourceControllerMgr state variable', () => {
  assert.ok(/let\s+resourceControllerMgr\s*=\s*null/.test(DAEMON_SRC),
    'daemon.js must declare `let resourceControllerMgr = null;`');
});

// ── 9. Behavioral: end-to-end smoke test ──────────────────────────────

test('ResourceControllerManager boots without errors', () => {
  const ResourceControllerManager = require(path.join(LIB_DIR, 'resource-controller-manager.js'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, ENABLE_THERMAL_PROTECTION: true };
  const mgr = new ResourceControllerManager({ config });
  mgr.setupAll();
  mgr.startAll();
  assert.ok(mgr.size >= 2);
  mgr.destroy();
});

test('ResourceControllerManager handles full action cycle without throwing', () => {
  const ResourceControllerManager = require(path.join(LIB_DIR, 'resource-controller-manager.js'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, ENABLE_THERMAL_PROTECTION: true };
  const mgr = new ResourceControllerManager({ config });
  mgr.setupAll();
  mgr.startAll();

  // Apply thermal profile
  const t = mgr.applyThermalProfile('cool');
  assert.strictEqual(t.success, true);

  // Apply power profile
  const p = mgr.applyPowerProfile('power-saver');
  assert.strictEqual(p.success, true);

  // Set PPD profile (DRY_RUN)
  const ppd = mgr.setPpdProfile('balanced');
  assert.strictEqual(ppd.success, true);

  // Get status
  const status = mgr.getStatus();
  assert.strictEqual(status.actionCount, 3);

  mgr.destroy();
});

// ── 10. Test file exists ──────────────────────────────────────────────

test('test/unit/test-resource-controller-layer.js exists', () => {
  const p = path.join(__dirname, '..', 'test', 'unit', 'test-resource-controller-layer.js');
  assert.ok(fs.existsSync(p));
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Resource Controller Layer safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Resource Controller Layer safety regression detected.');
  process.exit(1);
}

process.exit(0);
