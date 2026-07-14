'use strict';

/**
 * verify-actuator-api.js — Public API freeze test for actuator.js.
 *
 * Purpose:
 *   Lock the public surface of the `Actuator` class so the Phase 1
 *   ResourceController refactor cannot accidentally remove or rename a
 *   method/property that the rest of the codebase depends on.
 *
 * Contract being frozen (as of v0.2.2, pre-Phase-1):
 *   - `require('./actuator')` returns the `Actuator` CLASS (not an instance).
 *   - Callers instantiate it with `new Actuator(config)` and then use the
 *     resulting instance.
 *   - The instance must expose the methods/properties enumerated below.
 *
 * Run with: node scripts/verify-actuator-api.js
 *
 * If this script fails after a Phase 1 refactor step, STOP — the refactor
 * broke backward compatibility. Either restore the missing API or update
 * this script (only if the change is explicitly approved per the project's
 * "Strict Preserve" compatibility rule).
 */

const assert = require('assert');
const path = require('path');

const Actuator = require(path.join(__dirname, '..', 'actuator.js'));

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

console.log('Actuator Public API Freeze Test (v0.2.2 baseline)');
console.log('='.repeat(60));

// ── Module export shape ──────────────────────────────────────────────────

test('module exports a class (function with .prototype)', () => {
  assert.strictEqual(typeof Actuator, 'function',
    `require('./actuator') must return a class/function, got ${typeof Actuator}`);
  assert.ok(Actuator.prototype,
    'exported function must have a .prototype (i.e. be a class)');
});

test('class is constructable with `new Actuator(config)`', () => {
  const inst = new Actuator({ DRY_RUN: true });
  assert.ok(inst && typeof inst === 'object',
    'new Actuator(config) must return an object');
});

// ── Required instance methods ────────────────────────────────────────────
//
// These are the methods that daemon.js, scheduler.js, rollback.js,
// policy-engine/action-executor.js, the integration tests, and the
// verify-* scripts all depend on. None may be removed or renamed.

const REQUIRED_INSTANCE_METHODS = [
  // Config / lifecycle
  'setConfig',                    // update config reference (hot-reload)

  // Basic process control
  'pinToCores',                   // taskset -pc
  'setNiceness',                  // renice -n
  'setIoPriority',                // ionice -c -n
  'setOomScoreAdj',               // /proc/<pid>/oom_score_adj
  'notify',                       // desktop notification (notify-send)

  // Cgroup v2 lifecycle
  'resolveOwnCgroupRelativePath', // read /proc/self/cgroup
  'detectCgroupsV2',              // probe cgroup.controllers for "cpu"
  'detectOptionalControllers',   // probe for memory/io controllers
  'setupCgroups',                 // create cgroup subtree, enable controllers
  'applyCgroupLimits',            // write cpu.weight/cpu.max/memory.*/io.max
  'assignToCgroup',               // write PID to cgroup.procs

  // High-level actions
  'restoreProcess',               // restore a PID to neutral state
  'applySchedulerClass',          // apply schedClass settings to a PID

  // Modification tracking (used by RollbackManager)
  '_logModification',
  'getModificationLog',
  'clearModificationLog',
];

const inst = new Actuator({ DRY_RUN: true });

for (const m of REQUIRED_INSTANCE_METHODS) {
  test(`instance.${m}() is a function`, () => {
    assert.strictEqual(typeof inst[m], 'function',
      `new Actuator(config).${m} must be a function (got ${typeof inst[m]})`);
  });
}

// ── Required instance getters / properties ──────────────────────────────

const REQUIRED_INSTANCE_GETTERS = [
  'config',                        // getter — returns this._config
  'isDryRun',                      // getter — returns boolean from config.DRY_RUN
  'cgroupBasePath',                // getter — resolves base cgroup path lazily
  'foregroundCgroupPath',          // getter — path.join(base, parentSlice, 'foreground.slice')
  'backgroundCgroupPath',          // getter — path.join(base, parentSlice, 'background.slice')
  'parentCgroupPath',              // getter — path.join(base, parentSlice)
  'availableControllers',          // getter — cached {memory, io} map
];

for (const g of REQUIRED_INSTANCE_GETTERS) {
  test(`instance.${g} getter exists`, () => {
    // We can't use Object.getOwnPropertyDescriptor directly because getters
    // live on the prototype. Just verify the property resolves to a non-undefined
    // value when accessed (getters run).
    const desc = Object.getOwnPropertyDescriptor(Actuator.prototype, g)
              || Object.getOwnPropertyDescriptor(inst, g);
    assert.ok(desc !== undefined || inst[g] !== undefined,
      `instance.${g} must be defined (as a getter or property)`);
  });
}

// ── Required instance data properties ───────────────────────────────────

test('instance has cgroupsReady boolean field', () => {
  assert.strictEqual(typeof inst.cgroupsReady, 'boolean',
    'cgroupsReady must be a boolean (default false)');
  assert.strictEqual(inst.cgroupsReady, false,
    'cgroupsReady must default to false before setupCgroups()');
});

// ── Behavioral smoke tests (dry-run safe) ───────────────────────────────

test('isDryRun reflects config.DRY_RUN', () => {
  const a = new Actuator({ DRY_RUN: true });
  const b = new Actuator({ DRY_RUN: false });
  assert.strictEqual(a.isDryRun, true, 'DRY_RUN=true → isDryRun must be true');
  assert.strictEqual(b.isDryRun, false, 'DRY_RUN=false → isDryRun must be false');
});

test('getModificationLog() returns an array (empty initially)', () => {
  const a = new Actuator({ DRY_RUN: true });
  const log = a.getModificationLog();
  assert.ok(Array.isArray(log), 'getModificationLog() must return an array');
  assert.strictEqual(log.length, 0, 'modification log must start empty');
});

test('pinToCores rejects invalid PID', () => {
  const a = new Actuator({ DRY_RUN: true });
  assert.strictEqual(a.pinToCores(-1, [0]), false,
    'pinToCores must reject negative PID');
  assert.strictEqual(a.pinToCores(NaN, [0]), false,
    'pinToCores must reject NaN PID');
  assert.strictEqual(a.pinToCores(123, []), false,
    'pinToCores must reject empty cores array');
});

test('setNiceness rejects out-of-range nice', () => {
  const a = new Actuator({ DRY_RUN: true });
  assert.strictEqual(a.setNiceness(123, -21), false,
    'setNiceness must reject nice < -20');
  assert.strictEqual(a.setNiceness(123, 20), false,
    'setNiceness must reject nice > 19');
});

test('setIoPriority rejects invalid class/level', () => {
  const a = new Actuator({ DRY_RUN: true });
  assert.strictEqual(a.setIoPriority(123, 0, 4), false,
    'setIoPriority must reject cls=0 (must be 1,2,3)');
  assert.strictEqual(a.setIoPriority(123, 4, 4), false,
    'setIoPriority must reject cls=4 (must be 1,2,3)');
  assert.strictEqual(a.setIoPriority(123, 2, 8), false,
    'setIoPriority must reject level > 7');
});

test('setOomScoreAdj rejects out-of-range value', () => {
  const a = new Actuator({ DRY_RUN: true });
  assert.strictEqual(a.setOomScoreAdj(123, -1001), false,
    'setOomScoreAdj must reject value < -1000');
  assert.strictEqual(a.setOomScoreAdj(123, 1001), false,
    'setOomScoreAdj must reject value > 1000');
});

test('restoreProcess does not throw for dead PID', () => {
  const a = new Actuator({ DRY_RUN: true });
  // PID 999999 is vanishingly unlikely to exist
  assert.doesNotThrow(() => a.restoreProcess(999999, [0]),
    'restoreProcess must not throw for a dead PID');
});

test('applySchedulerClass does not throw with valid args', () => {
  const a = new Actuator({ DRY_RUN: true });
  assert.doesNotThrow(() => a.applySchedulerClass(123, 'BACKGROUND',
    { nice: 10, ioClass: 2, ioLevel: 4 }, [0, 1]),
    'applySchedulerClass must not throw with valid args');
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Actuator API freeze: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: actuator.js public API contract was broken.');
  console.error('See docs/adr/ADR-0001-resource-controller-abstraction.md');
  console.error('for the Phase 1 backward-compatibility contract.');
  process.exit(1);
}

process.exit(0);
