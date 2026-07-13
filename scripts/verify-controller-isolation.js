'use strict';

/**
 * verify-controller-isolation.js — Phase 1 architecture validation.
 *
 * Confirms that the new lib/ controllers are independent — each can be
 * require()'d and instantiated in isolation, without pulling in unrelated
 * controllers. This is the "Controllers remain independent" rule from
 * the Architecture Validation checklist.
 *
 * Run with: node scripts/verify-controller-isolation.js
 */

const assert = require('assert');
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

console.log('Phase 1 Controller Isolation Test');
console.log('='.repeat(60));

// ── Each controller can be required in isolation ────────────────────────

const ResourceController = require(path.join(__dirname, '..', 'lib', 'resource-controller.js'));
const CgroupManager = require(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'));
const CpuController = require(path.join(__dirname, '..', 'lib', 'controllers', 'cpu-controller.js'));
const MemoryController = require(path.join(__dirname, '..', 'lib', 'controllers', 'memory-controller.js'));
const IoController = require(path.join(__dirname, '..', 'lib', 'controllers', 'io-controller.js'));
const GovernorController = require(path.join(__dirname, '..', 'lib', 'controllers', 'governor-controller.js'));

test('ResourceController is a class', () => {
  assert.strictEqual(typeof ResourceController, 'function');
  assert.ok(ResourceController.prototype);
});

test('CgroupManager is a class', () => {
  assert.strictEqual(typeof CgroupManager, 'function');
  assert.ok(CgroupManager.prototype);
});

test('CpuController is a subclass of ResourceController', () => {
  assert.strictEqual(typeof CpuController, 'function');
  assert.ok(CpuController.prototype instanceof ResourceController,
    'CpuController must extend ResourceController');
});

test('MemoryController is a subclass of ResourceController', () => {
  assert.strictEqual(typeof MemoryController, 'function');
  assert.ok(MemoryController.prototype instanceof ResourceController,
    'MemoryController must extend ResourceController');
});

test('IoController is a subclass of ResourceController', () => {
  assert.strictEqual(typeof IoController, 'function');
  assert.ok(IoController.prototype instanceof ResourceController,
    'IoController must extend ResourceController');
});

test('GovernorController is a subclass of ResourceController', () => {
  assert.strictEqual(typeof GovernorController, 'function');
  assert.ok(GovernorController.prototype instanceof ResourceController,
    'GovernorController must extend ResourceController');
});

// ── Each controller can be instantiated independently ──────────────────

const minimalConfig = { DRY_RUN: true };
const minimalDeps = {
  config: minimalConfig,
  logger: require(path.join(__dirname, '..', 'logger.js')),
  cgroupManager: new CgroupManager(minimalConfig),
  tracker: { log() {} },
};

test('CpuController constructs with minimal deps', () => {
  const c = new CpuController(minimalDeps);
  assert.strictEqual(c.name, 'cpu');
  assert.strictEqual(c.isAvailable(), true);
});

test('MemoryController constructs with minimal deps', () => {
  const c = new MemoryController(minimalDeps);
  assert.strictEqual(c.name, 'memory');
  assert.strictEqual(c.isAvailable(), true);
});

test('IoController constructs with minimal deps', () => {
  const c = new IoController(minimalDeps);
  assert.strictEqual(c.name, 'io');
  assert.strictEqual(c.isAvailable(), true);
});

test('GovernorController is unavailable when no governorManager provided', () => {
  const c = new GovernorController(minimalDeps);
  assert.strictEqual(c.name, 'governor');
  assert.strictEqual(c.isAvailable(), false,
    'GovernorController.isAvailable() must be false when no governorManager in deps');
});

test('ResourceController rejects empty name', () => {
  assert.throws(() => new ResourceController('', minimalDeps),
    /name must be a non-empty string/);
});

test('ResourceController rejects non-object deps', () => {
  assert.throws(() => new ResourceController('test', null),
    /deps must be an object/);
});

// ── Lifecycle hooks exist and are no-ops by default ───────────────────

test('All controllers have setup/start/stop lifecycle hooks', () => {
  for (const Controller of [CpuController, MemoryController, IoController, GovernorController]) {
    const c = new Controller(minimalDeps);
    assert.strictEqual(typeof c.setup, 'function', `${c.name}.setup must be a function`);
    assert.strictEqual(typeof c.start, 'function', `${c.name}.start must be a function`);
    assert.strictEqual(typeof c.stop, 'function', `${c.name}.stop must be a function`);
    // Should be no-ops
    assert.strictEqual(c.setup(), undefined);
    assert.strictEqual(c.start(), undefined);
    assert.strictEqual(c.stop(), undefined);
  }
});

test('All controllers expose getStatus() returning {name, available}', () => {
  for (const Controller of [CpuController, MemoryController, IoController, GovernorController]) {
    const c = new Controller(minimalDeps);
    const status = c.getStatus();
    assert.ok(typeof status === 'object');
    assert.strictEqual(status.name, c.name);
    assert.strictEqual(typeof status.available, 'boolean');
  }
});

test('All controllers support setConfig() for hot-reload', () => {
  for (const Controller of [CpuController, MemoryController, IoController, GovernorController]) {
    const c = new Controller(minimalDeps);
    const newConfig = { DRY_RUN: false };
    c.setConfig(newConfig);
    assert.strictEqual(c.config, newConfig);
    assert.strictEqual(c.isDryRun, false);
  }
});

// ── CgroupManager independence ──────────────────────────────────────────

test('CgroupManager can be constructed without any controller', () => {
  const mgr = new CgroupManager({ DRY_RUN: true });
  assert.strictEqual(mgr.isDryRun, true);
  assert.strictEqual(mgr.cgroupsReady, false);
});

test('CgroupManager exposes path getters', () => {
  const mgr = new CgroupManager({
    DRY_RUN: true,
    CGROUP_ROOT: '/sys/fs/cgroup',
    CGROUP_PARENT_SLICE: 'dynalloc.slice',
    CGROUP_MODE: 'root',
  });
  assert.strictEqual(typeof mgr.cgroupBasePath, 'string');
  assert.strictEqual(mgr.cgroupBasePath, '/sys/fs/cgroup');
  assert.ok(mgr.foregroundCgroupPath.includes('foreground.slice'));
  assert.ok(mgr.backgroundCgroupPath.includes('background.slice'));
  assert.ok(mgr.parentCgroupPath.includes('dynalloc.slice'));
});

test('CgroupManager.detectOptionalControllers returns {memory, io}', () => {
  // Use DEFAULT_CONFIG so CGROUP_ROOT etc are populated — mirrors how
  // the daemon constructs CgroupManager via the Actuator facade.
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const mgr = new CgroupManager({ ...DEFAULT_CONFIG, DRY_RUN: true });
  const result = mgr.detectOptionalControllers();
  assert.ok(typeof result === 'object');
  assert.ok('memory' in result);
  assert.ok('io' in result);
  assert.strictEqual(typeof result.memory, 'boolean');
  assert.strictEqual(typeof result.io, 'boolean');
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Controller isolation: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Phase 1 controller isolation test failed.');
  process.exit(1);
}

process.exit(0);
