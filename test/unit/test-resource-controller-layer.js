'use strict';

/**
 * test-resource-controller-layer.js — Unit tests for the v0.5.0 Phase 2
 * Resource Controller Foundation.
 *
 * Run with: node --test test/unit/test-resource-controller-layer.js
 *
 * Covers:
 *   - ThermalController profile application + pause/resume + snapshot/rollback
 *   - PowerController profile application + PPD profile get/set + snapshot/rollback
 *   - ResourceControllerManager registration + lifecycle + action routing
 *   - ActionExecutor new action types (setThermalProfile, setPowerProfile, setPpdProfile)
 *   - Backward compatibility (existing controllers unchanged)
 *
 * All tests run in DRY_RUN mode — no real syscalls.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ThermalController = require(path.join(__dirname, '..', '..', 'lib', 'controllers', 'thermal-controller.js'));
const PowerController = require(path.join(__dirname, '..', '..', 'lib', 'controllers', 'power-controller.js'));
const ResourceControllerManager = require(path.join(__dirname, '..', '..', 'lib', 'resource-controller-manager.js'));
const { ActionExecutor } = require(path.join(__dirname, '..', '..', 'policy-engine', 'action-executor.js'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));

// ── Test helpers ──────────────────────────────────────────────────────

function makeConfig(overrides) {
  return { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
}

function makeDeps(overrides) {
  const config = makeConfig(overrides && overrides.config);
  const logger = require(path.join(__dirname, '..', '..', 'logger.js'));
  return {
    config,
    logger,
    cgroupManager: null,
    tracker: { log() {} },
  };
}

// ── ThermalController ─────────────────────────────────────────────────

test('ThermalController extends ResourceController', () => {
  const ResourceController = require(path.join(__dirname, '..', '..', 'lib', 'resource-controller.js'));
  assert.ok(ThermalController.prototype instanceof ResourceController);
});

test('ThermalController isAvailable returns true when ENABLE_THERMAL_PROTECTION is true', () => {
  const c = new ThermalController(makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } }));
  assert.strictEqual(c.isAvailable(), true);
});

test('ThermalController isAvailable returns false when ENABLE_THERMAL_PROTECTION is false', () => {
  const c = new ThermalController(makeDeps({ config: { ENABLE_THERMAL_PROTECTION: false } }));
  assert.strictEqual(c.isAvailable(), false);
});

test('ThermalController applyProfile("balanced") restores factory defaults', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  // Mutate config away from defaults
  deps.config.THERMAL_PAUSE_THRESHOLD = 99;
  deps.config.THERMAL_PAUSE_DURATION_MS = 99999;
  deps.config.THERMAL_RESUME_THRESHOLD = 99;
  // Apply balanced — should restore defaults
  const result = c.applyProfile('balanced');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.profile, 'balanced');
  assert.strictEqual(deps.config.THERMAL_PAUSE_THRESHOLD, DEFAULT_CONFIG.THERMAL_PAUSE_THRESHOLD);
  assert.strictEqual(deps.config.THERMAL_PAUSE_DURATION_MS, DEFAULT_CONFIG.THERMAL_PAUSE_DURATION_MS);
  assert.strictEqual(deps.config.THERMAL_RESUME_THRESHOLD, DEFAULT_CONFIG.THERMAL_RESUME_THRESHOLD);
});

test('ThermalController applyProfile("cool") sets aggressive thresholds', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  const result = c.applyProfile('cool');
  assert.strictEqual(result.success, true);
  assert.strictEqual(deps.config.THERMAL_PAUSE_THRESHOLD, 75);
  assert.strictEqual(deps.config.THERMAL_PAUSE_DURATION_MS, 45000);
  assert.strictEqual(deps.config.THERMAL_RESUME_THRESHOLD, 65);
});

test('ThermalController applyProfile("silent") sets maximum protection', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  const result = c.applyProfile('silent');
  assert.strictEqual(result.success, true);
  assert.strictEqual(deps.config.THERMAL_PAUSE_THRESHOLD, 65);
  assert.strictEqual(deps.config.THERMAL_PAUSE_DURATION_MS, 60000);
  assert.strictEqual(deps.config.THERMAL_RESUME_THRESHOLD, 55);
});

test('ThermalController applyProfile rejects unknown profile', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  const result = c.applyProfile('unknown');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('unknown thermal profile'));
});

test('ThermalController applyProfile fails when thermal protection disabled', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: false } });
  const c = new ThermalController(deps);
  const result = c.applyProfile('cool');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('disabled'));
});

test('ThermalController pause/resume/isPaused', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  assert.strictEqual(c.isPaused(), false);
  const result = c.pause(5000);
  assert.strictEqual(result.success, true);
  assert.ok(result.pausedUntil > Date.now());
  assert.strictEqual(c.isPaused(), true);
  c.resume();
  assert.strictEqual(c.isPaused(), false);
});

test('ThermalController pause rejects invalid duration', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  assert.strictEqual(c.pause(100).success, false);   // too short
  assert.strictEqual(c.pause(700000).success, false); // too long
  assert.strictEqual(c.pause('5000').success, false); // not a number
});

test('ThermalController restoreSnapshot reverts last applyProfile', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  const originalThreshold = deps.config.THERMAL_PAUSE_THRESHOLD;
  c.applyProfile('cool');  // changes threshold to 75
  assert.strictEqual(deps.config.THERMAL_PAUSE_THRESHOLD, 75);
  assert.strictEqual(c.restoreSnapshot(), true);
  assert.strictEqual(deps.config.THERMAL_PAUSE_THRESHOLD, originalThreshold);
});

test('ThermalController restoreSnapshot returns false when no snapshot', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  assert.strictEqual(c.restoreSnapshot(), false);
});

test('ThermalController getStatus returns snapshot', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  c.applyProfile('cool');
  const status = c.getStatus();
  assert.strictEqual(status.name, 'thermal');
  assert.strictEqual(status.available, true);
  assert.strictEqual(status.currentProfile, 'cool');
  assert.strictEqual(status.config.THERMAL_PAUSE_THRESHOLD, 75);
});

// ── PowerController ───────────────────────────────────────────────────

test('PowerController extends ResourceController', () => {
  const ResourceController = require(path.join(__dirname, '..', '..', 'lib', 'resource-controller.js'));
  assert.ok(PowerController.prototype instanceof ResourceController);
});

test('PowerController isAvailable always returns true', () => {
  const c = new PowerController(makeDeps());
  assert.strictEqual(c.isAvailable(), true);
});

test('PowerController applyProfile("balanced") restores factory defaults', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  deps.config.FOREGROUND_CPU_WEIGHT = 999;
  deps.config.BACKGROUND_CPU_WEIGHT = 999;
  deps.config.ENABLE_GOVERNOR_SWITCH = false;
  const result = c.applyProfile('balanced');
  assert.strictEqual(result.success, true);
  assert.strictEqual(deps.config.FOREGROUND_CPU_WEIGHT, DEFAULT_CONFIG.FOREGROUND_CPU_WEIGHT);
  assert.strictEqual(deps.config.BACKGROUND_CPU_WEIGHT, DEFAULT_CONFIG.BACKGROUND_CPU_WEIGHT);
  assert.strictEqual(deps.config.ENABLE_GOVERNOR_SWITCH, DEFAULT_CONFIG.ENABLE_GOVERNOR_SWITCH);
});

test('PowerController applyProfile("power-saver") sets conservative values', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.applyProfile('power-saver');
  assert.strictEqual(result.success, true);
  assert.strictEqual(deps.config.FOREGROUND_CPU_WEIGHT, 600);
  assert.strictEqual(deps.config.BACKGROUND_CPU_WEIGHT, 10);
  assert.strictEqual(deps.config.ENABLE_GOVERNOR_SWITCH, false);
});

test('PowerController applyProfile("performance") sets aggressive values', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.applyProfile('performance');
  assert.strictEqual(result.success, true);
  assert.strictEqual(deps.config.FOREGROUND_CPU_WEIGHT, 1000);
  assert.strictEqual(deps.config.BACKGROUND_CPU_WEIGHT, 20);
  assert.strictEqual(deps.config.ENABLE_GOVERNOR_SWITCH, true);
});

test('PowerController applyProfile rejects unknown profile', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.applyProfile('unknown');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('unknown power profile'));
});

test('PowerController restoreSnapshot reverts last applyProfile', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const originalWeight = deps.config.FOREGROUND_CPU_WEIGHT;
  c.applyProfile('performance');
  assert.strictEqual(deps.config.FOREGROUND_CPU_WEIGHT, 1000);
  assert.strictEqual(c.restoreSnapshot(), true);
  assert.strictEqual(deps.config.FOREGROUND_CPU_WEIGHT, originalWeight);
});

test('PowerController setPpdProfile validates profile name', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.setPpdProfile('invalid-profile');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('invalid PPD profile'));
});

test('PowerController setPpdProfile succeeds in DRY_RUN', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.setPpdProfile('performance');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.profile, 'performance');
});

test('PowerController getPpdProfile returns available in DRY_RUN', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  const result = c.getPpdProfile();
  assert.strictEqual(result.available, true);
  assert.ok(typeof result.profile === 'string');
});

test('PowerController getStatus returns snapshot', () => {
  const deps = makeDeps();
  const c = new PowerController(deps);
  c.applyProfile('power-saver');
  const status = c.getStatus();
  assert.strictEqual(status.name, 'power');
  assert.strictEqual(status.available, true);
  assert.strictEqual(status.currentProfile, 'power-saver');
  assert.strictEqual(status.config.FOREGROUND_CPU_WEIGHT, 600);
});

// ── ResourceControllerManager ─────────────────────────────────────────

test('ResourceControllerManager requires opts.config', () => {
  assert.throws(() => new ResourceControllerManager({}), TypeError);
  assert.throws(() => new ResourceControllerManager(), TypeError);
});

test('ResourceControllerManager registers built-in controllers when actuator+governor provided', () => {
  // Use a real Actuator + CgroupManager so the manager can reference controllers
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const GovernorManager = require(path.join(__dirname, '..', '..', 'governor.js'));
  const config = makeConfig();
  const actuator = new Actuator(config);
  const governor = new GovernorManager();
  const mgr = new ResourceControllerManager({ config, actuator, governor });
  // Should have: cpu, memory, io, network (null since ENABLE_NETWORK_QOS=false),
  // governor, thermal, power
  const names = mgr.registeredControllers;
  assert.ok(names.includes('cpu'));
  assert.ok(names.includes('memory'));
  assert.ok(names.includes('io'));
  assert.ok(names.includes('governor'));
  assert.ok(names.includes('thermal'));
  assert.ok(names.includes('power'));
  // 'network' is registered only when ENABLE_NETWORK_QOS=true (the default
  // here is false, so the controller instance is null and not registered)
  mgr.destroy();
});

test('ResourceControllerManager registers network controller when ENABLE_NETWORK_QOS=true', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const config = makeConfig({ ENABLE_NETWORK_QOS: true });
  const actuator = new Actuator(config);
  const mgr = new ResourceControllerManager({ config, actuator });
  assert.ok(mgr.registeredControllers.includes('network'));
  mgr.destroy();
});

test('ResourceControllerManager registers only thermal+power when no actuator/governor', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const names = mgr.registeredControllers;
  assert.ok(names.includes('thermal'));
  assert.ok(names.includes('power'));
  assert.ok(!names.includes('cpu'));
  assert.ok(!names.includes('memory'));
  assert.ok(!names.includes('io'));
  assert.ok(!names.includes('governor'));
  mgr.destroy();
});

test('ResourceControllerManager registerController validates name', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const ResourceController = require(path.join(__dirname, '..', '..', 'lib', 'resource-controller.js'));
  // Valid name
  const c1 = new (class extends ResourceController {
    constructor() { super('custom', makeDeps()); }
  })();
  assert.strictEqual(mgr.registerController(c1), true);
  // Duplicate
  const c2 = new (class extends ResourceController {
    constructor() { super('custom', makeDeps()); }
  })();
  assert.strictEqual(mgr.registerController(c2), false);
  mgr.destroy();
});

test('ResourceControllerManager setupAll/startAll/stopAll/destroy lifecycle', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  mgr.setupAll();
  mgr.startAll();
  assert.strictEqual(mgr.size >= 2, true);  // at least thermal+power
  mgr.stopAll();
  mgr.destroy();
});

test('ResourceControllerManager applyThermalProfile routes to ThermalController', () => {
  const config = makeConfig({ ENABLE_THERMAL_PROTECTION: true });
  const mgr = new ResourceControllerManager({ config });
  const result = mgr.applyThermalProfile('cool');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.profile, 'cool');
  assert.strictEqual(config.THERMAL_PAUSE_THRESHOLD, 75);
  assert.strictEqual(mgr.actionCount, 1);
  mgr.destroy();
});

test('ResourceControllerManager applyPowerProfile routes to PowerController', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const result = mgr.applyPowerProfile('performance');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.profile, 'performance');
  assert.strictEqual(config.FOREGROUND_CPU_WEIGHT, 1000);
  assert.strictEqual(mgr.actionCount, 1);
  mgr.destroy();
});

test('ResourceControllerManager setPpdProfile routes to PowerController', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const result = mgr.setPpdProfile('balanced');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.profile, 'balanced');
  mgr.destroy();
});

test('ResourceControllerManager setGovernor fails when no governor controller', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const result = mgr.setGovernor([0, 1], 'performance');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('governor controller not registered'));
  mgr.destroy();
});

test('ResourceControllerManager getController returns registered controller', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const thermal = mgr.getController('thermal');
  assert.ok(thermal instanceof ThermalController);
  assert.strictEqual(mgr.getController('nonexistent'), undefined);
  mgr.destroy();
});

test('ResourceControllerManager setConfig propagates to all controllers', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const newConfig = { ...config, THERMAL_PAUSE_THRESHOLD: 99 };
  mgr.setConfig(newConfig);
  const thermal = mgr.getController('thermal');
  assert.strictEqual(thermal.config.THERMAL_PAUSE_THRESHOLD, 99);
  mgr.destroy();
});

test('ResourceControllerManager getStatus returns snapshot', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  mgr.startAll();
  mgr.applyThermalProfile('cool');
  const status = mgr.getStatus();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.running, true);
  assert.ok(status.controllerCount >= 2);
  assert.strictEqual(status.actionCount, 1);
  assert.ok(Array.isArray(status.controllers));
  mgr.destroy();
});

test('ResourceControllerManager destroy is idempotent', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  mgr.destroy();
  mgr.destroy();  // should not throw
});

test('ResourceControllerManager unregisterController removes controller', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const initialSize = mgr.size;
  assert.strictEqual(mgr.unregisterController('thermal'), true);
  assert.strictEqual(mgr.size, initialSize - 1);
  assert.strictEqual(mgr.unregisterController('nonexistent'), false);
  mgr.destroy();
});

// ── ActionExecutor new action types ───────────────────────────────────

test('ActionExecutor accepts resourceControllerManager in constructor', () => {
  const config = makeConfig();
  const executor = new ActionExecutor({
    actuator: null,
    governor: null,
    scheduler: null,
    config,
    eventBus: null,
    stateStore: null,
    resourceControllerManager: { applyThermalProfile: () => ({ success: true }) },
  });
  assert.strictEqual(executor._rcm !== null, true);
});

test('ActionExecutor setResourceControllerManager sets reference', () => {
  const config = makeConfig();
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
  });
  assert.strictEqual(executor._rcm, null);
  const fakeRcm = { applyThermalProfile: () => ({ success: true }) };
  executor.setResourceControllerManager(fakeRcm);
  assert.strictEqual(executor._rcm, fakeRcm);
});

test('ActionExecutor setThermalProfile fails when RCM not set', async () => {
  const config = makeConfig();
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
  });
  const result = await executor.execute({ type: 'setThermalProfile', profile: 'cool' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('not enabled'));
});

test('ActionExecutor setThermalProfile routes through RCM', async () => {
  const config = makeConfig({ ENABLE_THERMAL_PROTECTION: true });
  const mgr = new ResourceControllerManager({ config });
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
    resourceControllerManager: mgr,
  });
  const result = await executor.execute({ type: 'setThermalProfile', profile: 'cool' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(config.THERMAL_PAUSE_THRESHOLD, 75);
  mgr.destroy();
});

test('ActionExecutor setPowerProfile routes through RCM', async () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
    resourceControllerManager: mgr,
  });
  const result = await executor.execute({ type: 'setPowerProfile', profile: 'performance' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(config.FOREGROUND_CPU_WEIGHT, 1000);
  mgr.destroy();
});

test('ActionExecutor setPpdProfile routes through RCM', async () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
    resourceControllerManager: mgr,
  });
  const result = await executor.execute({ type: 'setPpdProfile', profile: 'balanced' });
  assert.strictEqual(result.success, true);
  mgr.destroy();
});

test('ActionExecutor setThermalProfile rejects missing profile field', async () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config });
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
    resourceControllerManager: mgr,
  });
  const result = await executor.execute({ type: 'setThermalProfile' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('profile missing'));
  mgr.destroy();
});

test('ActionExecutor setThermalProfile rejects invalid profile name', async () => {
  const config = makeConfig({ ENABLE_THERMAL_PROTECTION: true });
  const mgr = new ResourceControllerManager({ config });
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
    resourceControllerManager: mgr,
  });
  const result = await executor.execute({ type: 'setThermalProfile', profile: 'invalid' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('unknown thermal profile'));
  mgr.destroy();
});

// ── Backward compatibility ────────────────────────────────────────────

test('ActionExecutor existing action types still work without RCM', async () => {
  // Verify that adding the new action types did not break existing ones.
  // We test 'log' since it requires no system state.
  const config = makeConfig();
  const executor = new ActionExecutor({
    actuator: null, governor: null, scheduler: null, config,
    eventBus: null, stateStore: null,
  });
  const result = await executor.execute({ type: 'log', level: 'info', message: 'test' });
  assert.strictEqual(result.success, true);
});

test('Actuator exposes controller getters', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const config = makeConfig();
  const actuator = new Actuator(config);
  assert.ok(actuator.cpuController);
  assert.ok(actuator.memoryController);
  assert.ok(actuator.ioController);
  assert.strictEqual(actuator.networkController, null);  // ENABLE_NETWORK_QOS=false
  assert.ok(actuator.cgroupManagerRef);
});

test('Actuator controller getters return the same instances used internally', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const config = makeConfig();
  const actuator = new Actuator(config);
  assert.strictEqual(actuator.cpuController, actuator._cpu);
  assert.strictEqual(actuator.memoryController, actuator._memory);
  assert.strictEqual(actuator.ioController, actuator._io);
});

// ── Edge cases ────────────────────────────────────────────────────────

test('ResourceControllerManager handles missing actuator gracefully', () => {
  const config = makeConfig();
  const mgr = new ResourceControllerManager({ config, actuator: null, governor: null });
  // thermal + power still register
  assert.strictEqual(mgr.size, 2);
  mgr.destroy();
});

test('ThermalController pause with exact boundary values', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: true } });
  const c = new ThermalController(deps);
  // 1000ms is the minimum allowed
  assert.strictEqual(c.pause(1000).success, true);
  // 600000ms is the maximum allowed
  assert.strictEqual(c.pause(600000).success, true);
  c.destroy();
});

test('PowerController does not require ENABLE_THERMAL_PROTECTION', () => {
  const deps = makeDeps({ config: { ENABLE_THERMAL_PROTECTION: false } });
  const c = new PowerController(deps);
  // Power controller is independent of thermal protection
  assert.strictEqual(c.isAvailable(), true);
  const result = c.applyProfile('balanced');
  assert.strictEqual(result.success, true);
  c.destroy();
});
