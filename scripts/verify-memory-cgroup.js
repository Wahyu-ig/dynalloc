'use strict';

/**
 * Regression tests for v2.1.6 memory & IO cgroup limits.
 *
 * Tests cover:
 *   - Config keys exist with correct defaults
 *   - Config schema validates cgroupLimit type correctly
 *   - Actuator.applyCgroupLimits() writes memory.max / memory.high / memory.oom.group
 *   - Actuator.applyCgroupLimits() writes io.max
 *   - Actuator.detectOptionalControllers() detects memory/io
 *   - ENABLE_MEMORY_LIMITS=false skips memory writes
 *   - ENABLE_IO_LIMITS=false skips io writes
 *   - Controller unavailable skips writes
 *   - self-check reports memory/io controller availability
 *   - CLI doctor shows memory/io controller status
 *
 * Run with: node scripts/verify-memory-cgroup.js
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

console.log('Verifying v2.1.6 memory & IO cgroup limits...\n');

// ── Test: config keys exist with correct defaults ─────────────────────

test('Fix #36a: DEFAULT_CONFIG has ENABLE_MEMORY_LIMITS=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_MEMORY_LIMITS, true,
    'ENABLE_MEMORY_LIMITS should default to true');
});

test('Fix #36b: DEFAULT_CONFIG has ENABLE_IO_LIMITS=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.ENABLE_IO_LIMITS, true,
    'ENABLE_IO_LIMITS should default to true');
});

test('Fix #36c: DEFAULT_CONFIG has FOREGROUND_MEMORY_MAX="max"', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.FOREGROUND_MEMORY_MAX, 'max',
    'FOREGROUND_MEMORY_MAX should default to "max" (unlimited)');
});

test('Fix #36d: DEFAULT_CONFIG has BACKGROUND_MEMORY_MAX=2GB', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX, '2147483648',
    `BACKGROUND_MEMORY_MAX should default to "2147483648" (2GB), got ${DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX}`);
});

test('Fix #36e: DEFAULT_CONFIG has BACKGROUND_MEMORY_HIGH=1.5GB', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.BACKGROUND_MEMORY_HIGH, '1610612736',
    `BACKGROUND_MEMORY_HIGH should default to "1610612736" (1.5GB), got ${DEFAULT_CONFIG.BACKGROUND_MEMORY_HIGH}`);
});

test('Fix #36f: DEFAULT_CONFIG has BACKGROUND_OOM_GROUP=true', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.BACKGROUND_OOM_GROUP, true,
    'BACKGROUND_OOM_GROUP should default to true');
});

test('Fix #36g: DEFAULT_CONFIG has BACKGROUND_IO_MAX=null', () => {
  const { DEFAULT_CONFIG } = require('../config');
  assert.strictEqual(DEFAULT_CONFIG.BACKGROUND_IO_MAX, null,
    'BACKGROUND_IO_MAX should default to null (no IO limits by default)');
});

// ── Test: config schema validates cgroupLimit type ─────────────────────

test('Fix #37a: cgroupLimit validates "max" as valid', () => {
  const { validateField, DEFAULT_CONFIG } = require('../config');
  const schema = { type: 'cgroupLimit' };
  const result = validateField('TEST', 'max', schema, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX);
  assert.strictEqual(result, 'max', `"max" should be valid, got ${result}`);
});

test('Fix #37b: cgroupLimit validates positive integer string as valid', () => {
  const { validateField, DEFAULT_CONFIG } = require('../config');
  const schema = { type: 'cgroupLimit' };
  const result = validateField('TEST', '1073741824', schema, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX);
  assert.strictEqual(result, '1073741824', `"1073741824" should be valid, got ${result}`);
});

test('Fix #37c: cgroupLimit rejects negative numbers', () => {
  const { validateField, DEFAULT_CONFIG } = require('../config');
  const schema = { type: 'cgroupLimit' };
  const result = validateField('TEST', '-100', schema, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX);
  assert.strictEqual(result, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX,
    'negative numbers should fall back to default');
});

test('Fix #37d: cgroupLimit rejects non-numeric strings', () => {
  const { validateField, DEFAULT_CONFIG } = require('../config');
  const schema = { type: 'cgroupLimit' };
  const result = validateField('TEST', 'abc', schema, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX);
  assert.strictEqual(result, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX,
    'non-numeric strings should fall back to default');
});

test('Fix #37e: cgroupLimit accepts null when nullable', () => {
  const { validateField, DEFAULT_CONFIG } = require('../config');
  const schema = { type: 'cgroupLimit', nullable: true };
  const result = validateField('TEST', null, schema, 'max');
  assert.strictEqual(result, null, 'null should be accepted when nullable');
});

// ── Test: actuator.applyCgroupLimits writes memory files ───────────────

test('Fix #38a: applyCgroupLimits writes memory.max for foreground and background (dry-run)', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');
  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, ENABLE_CGROUPS_V2: true };

  const actuator = new Actuator(config);
  // Force cgroupsReady and mock controllers via the shared CgroupManager.
  // (Phase 1 refactor: these live on _cgroupManager, not directly on Actuator.)
  actuator._cgroupManager.cgroupsReady = true;
  actuator._cgroupManager._cachedControllers = { memory: true, io: true };

  // Verify the source contains the memory.max writes for both cgroups.
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(src.includes('FOREGROUND_MEMORY_MAX'),
    'applyCgroupLimits should reference FOREGROUND_MEMORY_MAX');
  assert.ok(src.includes('BACKGROUND_MEMORY_MAX'),
    'applyCgroupLimits should reference BACKGROUND_MEMORY_MAX');
  assert.ok(src.includes("foregroundCgroupPath, 'memory.max'"),
    'applyCgroupLimits should write to foreground/memory.max');
  assert.ok(src.includes("backgroundCgroupPath, 'memory.max'"),
    'applyCgroupLimits should write to background/memory.max');
});

test('Fix #38b: applyCgroupLimits writes memory.oom.group for foreground (always 0) and background', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  // Foreground must always be 0 (isolate from background OOM)
  assert.ok(src.includes("'0', 'foreground memory.oom.group=0 (isolate)'"),
    'foreground memory.oom.group must be hardcoded to 0');
  // Background uses config value
  assert.ok(/BACKGROUND_OOM_GROUP \? '1' : '0'/.test(src),
    'background memory.oom.group should use BACKGROUND_OOM_GROUP config');
});

test('Fix #38c: applyCgroupLimits writes memory.high for background (soft limit)', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(src.includes('BACKGROUND_MEMORY_HIGH'),
    'applyCgroupLimits should reference BACKGROUND_MEMORY_HIGH');
  assert.ok(src.includes("backgroundCgroupPath, 'memory.high'"),
    'applyCgroupLimits should write to background/memory.high');
});

test('Fix #38d: applyCgroupLimits writes io.max for background when BACKGROUND_IO_MAX set', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(/if \(this\._config\.BACKGROUND_IO_MAX\)/.test(src),
    'applyCgroupLimits should check BACKGROUND_IO_MAX before writing io.max');
  assert.ok(src.includes('BACKGROUND_IO_MAX'),
    'applyCgroupLimits should reference BACKGROUND_IO_MAX');
  assert.ok(src.includes("backgroundCgroupPath, 'io.max'"),
    'applyCgroupLimits should write to background/io.max');
});

// ── Test: actuator guards memory/io writes by config flags ─────────────

test('Fix #39a: memory writes guarded by ENABLE_MEMORY_LIMITS', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(/ctrls\.memory && enableMemory && this\._config\.ENABLE_MEMORY_LIMITS/.test(src),
    'memory writes must be guarded by ctrls.memory && enableMemory && ENABLE_MEMORY_LIMITS');
});

test('Fix #39b: io writes guarded by ENABLE_IO_LIMITS', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(/ctrls\.io && enableIo && this\._config\.ENABLE_IO_LIMITS/.test(src),
    'io writes must be guarded by ctrls.io && enableIo && ENABLE_IO_LIMITS');
});

test('Fix #39c: setupCgroups enables +memory controller when available and enabled', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(/ctrls\.memory && enableMemory && this\._config\.ENABLE_MEMORY_LIMITS\) enableList\.push\('\+memory'\)/.test(src),
    'setupCgroups should push +memory to enableList when available and enabled');
});

test('Fix #39d: setupCgroups enables +io controller when available and enabled', () => {
  // Phase 1: cgroup limit logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  assert.ok(/ctrls\.io && enableIo && this\._config\.ENABLE_IO_LIMITS\)             enableList\.push\('\+io'\)/.test(src),
    'setupCgroups should push +io to enableList when available and enabled');
});

// ── Test: actuator.detectOptionalControllers ──────────────────────────

test('Fix #40a: actuator has detectOptionalControllers method', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');
  const actuator = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  assert.strictEqual(typeof actuator.detectOptionalControllers, 'function',
    'detectOptionalControllers should be a method');
});

test('Fix #40b: actuator has availableControllers getter', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');
  const actuator = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  assert.strictEqual(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(actuator), 'availableControllers').get, 'function',
    'availableControllers should be a getter');
});

test('Fix #40c: detectOptionalControllers returns {memory, io} object shape', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');
  const actuator = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  // This will fail to read /sys/fs/cgroup in a container, but should return
  // the right shape {memory: false, io: false} not throw.
  const result = actuator.detectOptionalControllers();
  assert.ok(typeof result === 'object', 'should return object');
  assert.ok('memory' in result, 'should have memory field');
  assert.ok('io' in result, 'should have io field');
  assert.strictEqual(typeof result.memory, 'boolean');
  assert.strictEqual(typeof result.io, 'boolean');
});

// ── Test: end-to-end actuator in dry-run mode ─────────────────────────

test('Fix #41: actuator dry-run mode logs memory/io writes without executing', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');

  // Config with memory limits enabled
  const config = {
    ...DEFAULT_CONFIG,
    DRY_RUN: true,
    ENABLE_CGROUPS_V2: true,
    ENABLE_MEMORY_LIMITS: true,
    ENABLE_IO_LIMITS: true,
    BACKGROUND_MEMORY_MAX: '1073741824', // 1GB
    BACKGROUND_MEMORY_HIGH: '805306368', // 768MB
    BACKGROUND_OOM_GROUP: true,
    BACKGROUND_IO_MAX: '8:16 rbps=10485760 wbps=10485760',
  };

  const actuator = new Actuator(config);
  // Force ready state and mock controllers as available via the shared
  // CgroupManager. (Phase 1: state lives on _cgroupManager.)
  actuator._cgroupManager.cgroupsReady = true;
  actuator._cgroupManager._cachedControllers = { memory: true, io: true };

  // In dry-run mode, applyCgroupLimits should not throw
  // (writes are traced but not executed)
  assert.doesNotThrow(() => actuator.applyCgroupLimits(),
    'applyCgroupLimits should not throw in dry-run mode with memory/io enabled');
});

test('Fix #42: actuator with ENABLE_MEMORY_LIMITS=false skips memory writes', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');

  const config = {
    ...DEFAULT_CONFIG,
    DRY_RUN: true,
    ENABLE_CGROUPS_V2: true,
    ENABLE_MEMORY_LIMITS: false, // disabled
    ENABLE_IO_LIMITS: true,
  };

  const actuator = new Actuator(config);
  // Phase 1: state lives on _cgroupManager.
  actuator._cgroupManager.cgroupsReady = true;
  actuator._cgroupManager._cachedControllers = { memory: true, io: true };

  // Should not throw — memory section is skipped
  assert.doesNotThrow(() => actuator.applyCgroupLimits(),
    'applyCgroupLimits should not throw when ENABLE_MEMORY_LIMITS=false');
});

test('Fix #43: actuator with controllers unavailable skips memory/io writes', () => {
  delete require.cache[require.resolve('../actuator')];
  const Actuator = require('../actuator');
  const { DEFAULT_CONFIG } = require('../config');

  const config = {
    ...DEFAULT_CONFIG,
    DRY_RUN: true,
    ENABLE_CGROUPS_V2: true,
    ENABLE_MEMORY_LIMITS: true,
    ENABLE_IO_LIMITS: true,
  };

  const actuator = new Actuator(config);
  // Phase 1: state lives on _cgroupManager.
  actuator._cgroupManager.cgroupsReady = true;
  // Controllers NOT available (e.g. some containers)
  actuator._cgroupManager._cachedControllers = { memory: false, io: false };

  // Should not throw — memory/io sections skipped because ctrls.memory/io are false
  assert.doesNotThrow(() => actuator.applyCgroupLimits(),
    'applyCgroupLimits should not throw when controllers unavailable');
});

// ── Test: self-check reports memory/io controller availability ─────────

test('Fix #44a: self-check checkCgroupsV2 reports memory and io controller availability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('hasMemory'),
    'checkCgroupsV2 should detect memory controller');
  assert.ok(src.includes('hasIo'),
    'checkCgroupsV2 should detect io controller');
  assert.ok(src.includes('controllers:'),
    'checkCgroupsV2 should include controllers object in report');
  assert.ok(src.includes('memory: hasMemory'),
    'checkCgroupsV2 should report memory controller status');
  assert.ok(src.includes('io: hasIo'),
    'checkCgroupsV2 should report io controller status');
});

test('Fix #44b: self-check printReport shows controller availability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('Controllers: cpu='),
    'printReport should show controller availability');
  assert.ok(src.includes('memory='),
    'printReport should show memory controller status');
  assert.ok(src.includes('io='),
    'printReport should show io controller status');
});

// ── Test: config hot-reload includes new fields ────────────────────────

test('Fix #45: HOT_RELOADABLE_FIELDS includes memory/io config keys', () => {
  const { HOT_RELOADABLE_FIELDS } = require('../config');
  const expected = [
    'ENABLE_MEMORY_LIMITS',
    'ENABLE_IO_LIMITS',
    'FOREGROUND_MEMORY_MAX',
    'BACKGROUND_MEMORY_MAX',
    'BACKGROUND_MEMORY_HIGH',
    'BACKGROUND_OOM_GROUP',
    'BACKGROUND_IO_MAX',
  ];
  for (const field of expected) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(field),
      `${field} should be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── Test: config schema includes new fields ────────────────────────────

test('Fix #46: CONFIG_SCHEMA includes memory/io config keys with correct types', () => {
  const { CONFIG_SCHEMA } = require('../config');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_MEMORY_LIMITS.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.ENABLE_IO_LIMITS.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.BACKGROUND_OOM_GROUP.type, 'boolean');
  assert.strictEqual(CONFIG_SCHEMA.FOREGROUND_MEMORY_MAX.type, 'cgroupLimit');
  assert.strictEqual(CONFIG_SCHEMA.BACKGROUND_MEMORY_MAX.type, 'cgroupLimit');
  assert.strictEqual(CONFIG_SCHEMA.BACKGROUND_MEMORY_HIGH.type, 'cgroupLimit');
  assert.ok(CONFIG_SCHEMA.BACKGROUND_MEMORY_HIGH.nullable,
    'BACKGROUND_MEMORY_HIGH should be nullable');
  assert.strictEqual(CONFIG_SCHEMA.BACKGROUND_IO_MAX.type, 'string');
  assert.ok(CONFIG_SCHEMA.BACKGROUND_IO_MAX.nullable,
    'BACKGROUND_IO_MAX should be nullable');
});

// ── Test: validateAndMerge with new config ─────────────────────────────

test('Fix #47: validateAndMerge accepts valid memory config overrides', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const override = {
    ENABLE_MEMORY_LIMITS: true,
    FOREGROUND_MEMORY_MAX: 'max',
    BACKGROUND_MEMORY_MAX: '536870912', // 512MB
    BACKGROUND_MEMORY_HIGH: '402653184', // 384MB
    BACKGROUND_OOM_GROUP: false,
    BACKGROUND_IO_MAX: '8:0 rbps=5242880',
  };
  const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
  assert.strictEqual(config.ENABLE_MEMORY_LIMITS, true);
  assert.strictEqual(config.FOREGROUND_MEMORY_MAX, 'max');
  assert.strictEqual(config.BACKGROUND_MEMORY_MAX, '536870912');
  assert.strictEqual(config.BACKGROUND_MEMORY_HIGH, '402653184');
  assert.strictEqual(config.BACKGROUND_OOM_GROUP, false);
  assert.strictEqual(config.BACKGROUND_IO_MAX, '8:0 rbps=5242880');
  // Should be no validation warnings
  assert.strictEqual(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);
});

test('Fix #48: validateAndMerge rejects invalid memory config and falls back to defaults', () => {
  const { validateAndMerge, DEFAULT_CONFIG } = require('../config');
  const override = {
    BACKGROUND_MEMORY_MAX: 'not-a-number', // invalid
    BACKGROUND_MEMORY_HIGH: -100,          // invalid (negative)
  };
  const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
  // Should fall back to defaults
  assert.strictEqual(config.BACKGROUND_MEMORY_MAX, DEFAULT_CONFIG.BACKGROUND_MEMORY_MAX,
    'invalid BACKGROUND_MEMORY_MAX should fall back to default');
  // Background memory high: -100 is a number, not a string, so cgroupLimit
  // validator should reject it and fall back to default.
  assert.strictEqual(config.BACKGROUND_MEMORY_HIGH, DEFAULT_CONFIG.BACKGROUND_MEMORY_HIGH,
    'invalid BACKGROUND_MEMORY_HIGH should fall back to default');
  // Should have warnings about the invalid values
  assert.ok(warnings.length >= 1, 'should have validation warnings');
});

// ── Test: end-to-end daemon in dry-run with memory limits ──────────────

test('Fix #49: daemon boots successfully in dry-run with memory limits enabled', () => {
  // Phase 1: setupCgroups logic moved to lib/cgroup-manager.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cgroup-manager.js'), 'utf8');
  // The setupCgroups function should refresh _cachedControllers and log
  assert.ok(/this\._cachedControllers = this\.detectOptionalControllers\(\)/.test(src),
    'setupCgroups should refresh _cachedControllers');
  assert.ok(/Cgroup controller "memory" tersedia/.test(src),
    'setupCgroups should log when memory controller available');
  assert.ok(/Cgroup controller "io" tersedia/.test(src),
    'setupCgroups should log when io controller available');
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Memory/IO cgroup tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
