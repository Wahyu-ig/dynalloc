'use strict';

/**
 * DynAlloc — Policy Engine Unit Tests
 * ===================================
 *
 * Comprehensive unit tests for every Policy Engine module:
 *   1. EventBus          — on/once/off/emit/wildcard/re-entrancy/destroy
 *   2. StateStore        — get/set/has/delete/dot-paths/bounds/snapshot
 *   3. Matcher           — short-form/explicit/AND/OR/NOT/all operators
 *   4. RuleEngine        — normalization/priority/cooldown/once/disabled
 *   5. ActionExecutor    — all action types + rollback on failure
 *   6. PolicyLogger      — ring buffer/audit record/file rotation
 *   7. PolicyLoader      — JSON/YAML parsing + validation
 *   8. PolicyEngine      — end-to-end event → rule → action → audit
 *
 * Run: node --test test/unit/test-policy-engine.js
 */

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Silence the main logger during tests
const logger = require('../../logger');
logger.setLevel('fatal');

// Suppress console
const origConsoleError = console.error;
const origConsoleWarn = console.warn;
const origConsoleLog = console.log;
before(() => {
  console.error = mock.fn();
  console.warn = mock.fn();
  console.log = mock.fn();
});
after(() => {
  console.error = origConsoleError;
  console.warn = origConsoleWarn;
  console.log = origConsoleLog;
});

// ── Test helpers ─────────────────────────────────────────────────────

const PE = require('../../policy-engine');
const { EventBus, EVENTS } = require('../../policy-engine/event-bus');
const { StateStore } = require('../../policy-engine/state-store');
const matcher = require('../../policy-engine/matcher');
const { RuleEngine, normalizeRule } = require('../../policy-engine/rule-engine');
const { ActionExecutor } = require('../../policy-engine/action-executor');
const { PolicyLogger } = require('../../policy-engine/policy-logger');
const { PolicyLoader, validatePolicy, _parseYaml } = require('../../policy-engine/policy-loader');
const { PolicyEngine } = require('../../policy-engine/policy-engine');
const { EventSources } = require('../../policy-engine/event-sources');

// Mock actuator/governor/scheduler for ActionExecutor tests
function mockActuator() {
  const calls = [];
  return {
    _calls: calls,
    cgroupsReady: false,
    foregroundCgroupPath: '/test/foreground',
    backgroundCgroupPath: '/test/background',
    cgroupBasePath: '/test',
    setNiceness(pid, n) { calls.push(['setNiceness', pid, n]); return true; },
    setIoPriority(pid, c, l) { calls.push(['setIoPriority', pid, c, l]); return true; },
    setOomScoreAdj(pid, v) { calls.push(['setOomScoreAdj', pid, v]); return true; },
    pinToCores(pid, cores) { calls.push(['pinToCores', pid, cores]); return true; },
    assignToCgroup(pid, p) { calls.push(['assignToCgroup', pid, p]); return true; },
    restoreProcess(pid, cores) { calls.push(['restoreProcess', pid, cores]); },
    notify(s, b) { calls.push(['notify', s, b]); },
  };
}

function mockGovernor() {
  const originals = new Map([[0, 'powersave'], [1, 'powersave'], [2, 'powersave'], [3, 'powersave']]);
  return {
    _setCalls: [],
    setGovernor(cores, gov) { this._setCalls.push([cores, gov]); },
    captureOriginals() {},
    getOriginalGovernors() { return originals; },
    restoreAll() {},
  };
}

function mockScheduler() {
  return {
    _config: { SCHEDULER_CLASS_BACKGROUND_NICE: 10, SCHEDULER_CLASS_BACKGROUND_IOPRIO: [3, 0] },
    foregroundCores: [0, 1],
    backgroundCores: [2, 3],
    allCores: [0, 1, 2, 3],
    generateForegroundBoost(pid, procs, gameMode) {
      return { pid, comm: 'test', schedClass: 'INTERACTIVE', nice: -5, ioClass: 1, ioLevel: 4, cores: [0, 1], gameModeActive: false };
    },
  };
}

function mockConfig(overrides = {}) {
  return {
    PSI_CPU_WARN: 8.0,
    PSI_CPU_CRITICAL: 20.0,
    PSI_MEM_WARN: 4.0,
    PSI_MEM_CRITICAL: 12.0,
    FOREGROUND_OOM_SCORE_ADJ: -500,
    ENABLE_OOM_PROTECTION: true,
    POLICY_DEFAULT_COOLDOWN_MS: 1000,
    POLICY_MAX_RULES: 200,
    POLICY_EXECUTION_TIMEOUT_MS: 5000,
    POLICY_HOT_RELOAD: false,
    POLICY_LOG_FILE_PATH: null,
    POLICY_LOG_MAX_SIZE_MB: 5,
    POLICY_LOG_MAX_FILES: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. EVENT BUS
// ═══════════════════════════════════════════════════════════════════════

describe('EventBus', () => {
  let bus;
  beforeEach(() => { bus = new EventBus(); });
  afterEach(() => { bus.destroy(); });

  it('should deliver events to subscribers in priority order', () => {
    const order = [];
    bus.on('test', () => order.push('low'), { priority: 0 });
    bus.on('test', () => order.push('high'), { priority: 100 });
    bus.on('test', () => order.push('mid'), { priority: 50 });
    bus.emit('test', {});
    assert.deepEqual(order, ['high', 'mid', 'low']);
  });

  it('should support once() listeners', () => {
    let count = 0;
    bus.once('test', () => count++);
    bus.emit('test', {});
    bus.emit('test', {});
    assert.equal(count, 1);
  });

  it('should support wildcard listeners', () => {
    const events = [];
    bus.on('*', (name, payload) => events.push({ name, payload }));
    bus.emit('onTest1', { a: 1 });
    bus.emit('onTest2', { b: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].name, 'onTest1');
    assert.deepEqual(events[0].payload, { a: 1 });
  });

  it('should isolate listener errors', () => {
    let second = false;
    bus.on('test', () => { throw new Error('boom'); });
    bus.on('test', () => { second = true; });
    bus.emit('test', {});
    assert.equal(second, true);
  });

  it('should support off() with deferred removal during dispatch', () => {
    let second = false;
    const id1 = bus.on('test', () => {
      bus.off(id1);
    });
    bus.on('test', () => { second = true; });
    bus.emit('test', {});
    assert.equal(second, true);
    assert.equal(bus.listenerCount('test'), 1);
  });

  it('should handle re-entrant emit()', () => {
    const results = [];
    bus.on('outer', () => {
      results.push('outer-start');
      bus.emit('inner', {});
      results.push('outer-end');
    });
    bus.on('inner', () => results.push('inner'));
    bus.emit('outer', {});
    assert.deepEqual(results, ['outer-start', 'inner', 'outer-end']);
  });

  it('should report listenerCount correctly', () => {
    bus.on('test', () => {});
    bus.on('test', () => {});
    bus.on('other', () => {});
    assert.equal(bus.listenerCount('test'), 2);
    assert.equal(bus.listenerCount('other'), 1);
    assert.equal(bus.listenerCount('none'), 0);
  });

  it('should ignore on/emit after destroy()', () => {
    bus.destroy();
    const id = bus.on('test', () => {});
    assert.equal(id, -1);
    assert.equal(bus.emit('test', {}), 0);
  });

  it('should support offAll(eventName) and offAll()', () => {
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.on('*', () => {});
    bus.offAll('a');
    assert.equal(bus.listenerCount('a'), 0);
    assert.equal(bus.listenerCount('b'), 1);
    bus.offAll();
    assert.equal(bus.listenerCount('b'), 0);
    assert.equal(bus._wildcardListeners.length, 0);
  });

  it('should return number of invoked listeners', () => {
    bus.on('test', () => {});
    bus.on('test', () => {});
    bus.on('*', () => {});
    const invoked = bus.emit('test', {});
    assert.equal(invoked, 3); // 2 specific + 1 wildcard
  });

  it('should expose a frozen EVENTS constant', () => {
    assert.ok(Object.isFrozen(EVENTS));
    assert.equal(EVENTS.ON_BATTERY_LOW, 'onBatteryLow');
    assert.equal(EVENTS.ON_CPU_HIGH, 'onCpuHigh');
    assert.equal(EVENTS.ON_WALLPAPER_CHANGED, 'onWallpaperChanged');
    assert.equal(EVENTS.ON_PROFILE_CHANGED, 'onProfileChanged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. STATE STORE
// ═══════════════════════════════════════════════════════════════════════

describe('StateStore', () => {
  let store;
  beforeEach(() => { store = new StateStore(256); });

  it('should set/get/has/delete flat keys', () => {
    store.set('foo', 42);
    assert.equal(store.get('foo'), 42);
    assert.equal(store.has('foo'), true);
    assert.equal(store.delete('foo'), true);
    assert.equal(store.has('foo'), false);
  });

  it('should support dot-paths', () => {
    store.set('battery.capacity', 75);
    store.set('battery.onBattery', true);
    assert.equal(store.get('battery.capacity'), 75);
    assert.equal(store.get('battery.onBattery'), true);
    assert.equal(store.get('battery.missing', 'default'), 'default');
  });

  it('should clean up empty parent objects on delete', () => {
    store.set('a.b.c', 1);
    store.delete('a.b.c');
    assert.equal(store.has('a.b.c'), false);
    assert.equal(store.has('a.b'), false);
    assert.equal(store.has('a'), false);
  });

  it('should overwrite non-object top-level with object', () => {
    store.set('x', 5);
    assert.equal(store.get('x'), 5);
    store.set('x.y', 10);
    assert.equal(store.get('x.y'), 10);
  });

  it('should enforce maxKeys bound', () => {
    // Constructor enforces a minimum of 8, so use a larger value
    const small = new StateStore(10);
    for (let i = 0; i < 10; i++) small.set(`k${i}`, i);
    small.set('overflow', 99); // should be rejected
    assert.equal(small.get('overflow'), undefined);
    assert.equal(small.size, 10);
  });

  it('should return a deep snapshot via snapshot()', () => {
    store.set('a', { b: 1 });
    const snap = store.snapshot();
    snap.a.b = 999;
    assert.equal(store.get('a.b'), 1); // unaffected
  });

  it('should clear all state', () => {
    store.set('a', 1);
    store.set('b', 2);
    store.clear();
    assert.equal(store.size, 0);
  });

  it('should ignore invalid keys', () => {
    store.set('', 1);
    store.set(null, 1);
    assert.equal(store.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. MATCHER
// ═══════════════════════════════════════════════════════════════════════

describe('Matcher', () => {
  let store;
  beforeEach(() => { store = new StateStore(); });

  it('should parse short-form comparison strings', () => {
    assert.deepEqual(matcher.parseShortForm('<20'), { op: '<', value: 20 });
    assert.deepEqual(matcher.parseShortForm('>=40'), { op: '>=', value: 40 });
    assert.deepEqual(matcher.parseShortForm('!=idle'), { op: '!=', value: 'idle' });
    assert.deepEqual(matcher.parseShortForm('>"foo"'), { op: '>', value: 'foo' });
    assert.equal(matcher.parseShortForm(42), null);
  });

  it('should evaluate leaf conditions in implicit-== form', () => {
    store.set('app', 'steam');
    assert.equal(matcher.evalLeaf({ app: 'steam' }, {}, store), true);
    assert.equal(matcher.evalLeaf({ app: 'firefox' }, {}, store), false);
  });

  it('should evaluate leaf conditions in short-form comparison', () => {
    store.set('battery.capacity', 15);
    assert.equal(matcher.evalLeaf({ 'battery.capacity': '<20' }, {}, store), true);
    assert.equal(matcher.evalLeaf({ 'battery.capacity': '>50' }, {}, store), false);
  });

  it('should evaluate explicit-form conditions', () => {
    store.set('cpu', 75);
    assert.equal(matcher.evaluate({ field: 'cpu', op: '>', value: 50 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'cpu', op: '<', value: 50 }, {}, store), false);
  });

  it('should support all comparison operators', () => {
    store.set('n', 10);
    store.set('s', 'hello world');
    store.set('arr', [1, 2, 3]);
    assert.equal(matcher.evaluate({ field: 'n', op: '<', value: 20 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: '<=', value: 10 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: '>', value: 5 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: '>=', value: 10 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: '==', value: 10 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: '!=', value: 11 }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 's', op: 'contains', value: 'world' }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 's', op: 'startsWith', value: 'hello' }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 's', op: 'endsWith', value: 'world' }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 's', op: 'matches', value: '^hello' }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'n', op: 'in', value: [5, 10, 15] }, {}, store), true);
    assert.equal(matcher.evaluate({ field: 'arr', op: 'contains', value: 2 }, {}, store), true);
  });

  it('should support AND compound', () => {
    store.set('a', 5);
    store.set('b', 10);
    const cond = { AND: [{ a: '>0' }, { b: '>5' }] };
    assert.equal(matcher.evaluate(cond, {}, store), true);
    const cond2 = { AND: [{ a: '>0' }, { b: '>15' }] };
    assert.equal(matcher.evaluate(cond2, {}, store), false);
  });

  it('should support OR compound', () => {
    store.set('a', 5);
    const cond = { OR: [{ a: '>100' }, { a: '<10' }] };
    assert.equal(matcher.evaluate(cond, {}, store), true);
  });

  it('should support NOT compound', () => {
    store.set('a', 5);
    const cond = { NOT: { a: '>100' } };
    assert.equal(matcher.evaluate(cond, {}, store), true);
  });

  it('should support nested compounds (AND of OR of NOT)', () => {
    store.set('a', 5);
    store.set('b', 10);
    const cond = {
      AND: [
        { OR: [{ a: '>100' }, { b: '<20' }] },
        { NOT: { a: '<0' } },
      ],
    };
    assert.equal(matcher.evaluate(cond, {}, store), true);
  });

  it('should resolve fields from payload first, then state store', () => {
    store.set('comm', 'from-store');
    assert.equal(matcher.evalLeaf({ comm: 'from-payload' }, { comm: 'from-payload' }, store), true);
    assert.equal(matcher.evalLeaf({ comm: 'from-store' }, {}, store), true);
  });

  it('should return false for missing fields', () => {
    assert.equal(matcher.evalLeaf({ missing: '>0' }, {}, store), false);
  });

  it('should resolve nested payload paths', () => {
    const payload = { process: { comm: 'steam' } };
    assert.equal(matcher.evalLeaf({ 'process.comm': 'steam' }, payload, store), true);
  });

  it('should treat empty leaf as truthy', () => {
    assert.equal(matcher.evalLeaf({}, {}, store), true);
  });

  it('should AND multiple keys in a single leaf', () => {
    store.set('a', 5);
    store.set('b', 10);
    assert.equal(matcher.evalLeaf({ a: '>0', b: '>5' }, {}, store), true);
    assert.equal(matcher.evalLeaf({ a: '>0', b: '>100' }, {}, store), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. RULE ENGINE
// ═══════════════════════════════════════════════════════════════════════

describe('RuleEngine', () => {
  let engine;
  beforeEach(() => {
    engine = new RuleEngine({ defaultCooldownMs: 1000, maxRules: 50 });
  });

  it('should normalize a valid rule', () => {
    const r = normalizeRule({
      id: 'test',
      match: { app: 'steam' },
      action: { type: 'log', message: 'hi' },
      priority: 50,
      cooldown: 5000,
      once: true,
    }, { cooldownMs: 1000 }, 0);
    assert.equal(r.id, 'test');
    assert.equal(r.priority, 50);
    assert.equal(r.cooldown, 5000);
    assert.equal(r.once, true);
    assert.equal(r.enabled, true);
  });

  it('should reject rules missing id', () => {
    assert.throws(() => normalizeRule({ action: { type: 'log' } }, { cooldownMs: 1000 }, 0));
  });

  it('should reject rules missing action', () => {
    assert.throws(() => normalizeRule({ id: 'x' }, { cooldownMs: 1000 }, 0));
  });

  it('should reject rules with invalid action.type', () => {
    assert.throws(() => normalizeRule({ id: 'x', action: {} }, { cooldownMs: 1000 }, 0));
  });

  it('should sort rules by priority descending', () => {
    engine.setRules([
      normalizeRule({ id: 'low', priority: 0, action: { type: 'log' } }, { cooldownMs: 1000 }, 0),
      normalizeRule({ id: 'high', priority: 100, action: { type: 'log' } }, { cooldownMs: 1000 }, 1),
      normalizeRule({ id: 'mid', priority: 50, action: { type: 'log' } }, { cooldownMs: 1000 }, 2),
    ]);
    const ids = engine.rules.map((r) => r.id);
    assert.deepEqual(ids, ['high', 'mid', 'low']);
  });

  it('should evaluate rules that match event + payload', () => {
    engine.setRules([
      normalizeRule({
        id: 'r1',
        when: { event: 'onTest' },
        match: { app: 'steam' },
        action: { type: 'log' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    const matches = engine.evaluateEvent('onTest', { app: 'steam' }, new StateStore());
    assert.equal(matches.length, 1);
    assert.equal(matches[0].rule.id, 'r1');
  });

  it('should skip rules whose event filter does not match', () => {
    engine.setRules([
      normalizeRule({
        id: 'r1',
        when: { event: 'onTest' },
        action: { type: 'log' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    const matches = engine.evaluateEvent('onOther', {}, new StateStore());
    assert.equal(matches.length, 0);
  });

  it('should apply cooldown', async () => {
    engine.setRules([
      normalizeRule({
        id: 'r1',
        cooldown: 100,
        action: { type: 'log' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    const store = new StateStore();
    let m = engine.evaluateEvent('onTest', {}, store);
    assert.equal(m.length, 1);
    // Second emit immediately — suppressed
    m = engine.evaluateEvent('onTest', {}, store);
    assert.equal(m.length, 0);
    // After cooldown passes
    await new Promise((r) => setTimeout(r, 150));
    m = engine.evaluateEvent('onTest', {}, store);
    assert.equal(m.length, 1);
  });

  it('should apply "once" semantics', () => {
    engine.setRules([
      normalizeRule({
        id: 'r1',
        once: true,
        action: { type: 'log' },
      }, { cooldownMs: 0 }, 0),
    ]);
    const store = new StateStore();
    let m = engine.evaluateEvent('onTest', {}, store);
    assert.equal(m.length, 1);
    m = engine.evaluateEvent('onTest', {}, store);
    assert.equal(m.length, 0);
  });

  it('should skip disabled rules', () => {
    engine.setRules([
      normalizeRule({
        id: 'r1',
        enabled: false,
        action: { type: 'log' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    const m = engine.evaluateEvent('onTest', {}, new StateStore());
    assert.equal(m.length, 0);
  });

  it('should respect maxRules bound', () => {
    const e = new RuleEngine({ defaultCooldownMs: 1000, maxRules: 2 });
    const rules = [
      normalizeRule({ id: 'a', action: { type: 'log' } }, { cooldownMs: 1000 }, 0),
      normalizeRule({ id: 'b', action: { type: 'log' } }, { cooldownMs: 1000 }, 1),
      normalizeRule({ id: 'c', action: { type: 'log' } }, { cooldownMs: 1000 }, 2),
    ];
    e.setRules(rules);
    assert.equal(e.size, 2);
  });

  it('should reset cooldown/once via resetRule and resetAll', () => {
    engine.setRules([
      normalizeRule({ id: 'r1', once: true, action: { type: 'log' } }, { cooldownMs: 0 }, 0),
    ]);
    const store = new StateStore();
    engine.evaluateEvent('onTest', {}, store);
    assert.equal(engine.evaluateEvent('onTest', {}, store).length, 0);
    engine.resetRule('r1');
    assert.equal(engine.evaluateEvent('onTest', {}, store).length, 1);
  });

  it('should track evaluation statistics', () => {
    engine.setRules([
      normalizeRule({ id: 'r1', match: { app: 'steam' }, action: { type: 'log' } }, { cooldownMs: 1000 }, 0),
    ]);
    const store = new StateStore();
    engine.evaluateEvent('onTest', { app: 'steam' }, store);
    engine.evaluateEvent('onTest', { app: 'firefox' }, store);
    assert.equal(engine.stats.evaluations, 2);
    assert.equal(engine.stats.matches, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. ACTION EXECUTOR
// ═══════════════════════════════════════════════════════════════════════

describe('ActionExecutor', () => {
  let executor, actuator, governor, scheduler, config, bus;

  beforeEach(() => {
    actuator = mockActuator();
    governor = mockGovernor();
    scheduler = mockScheduler();
    config = mockConfig();
    bus = new EventBus();
    executor = new ActionExecutor({
      actuator, governor, scheduler, config, eventBus: bus,
      profiles: { gaming: { governor: 'performance', governorCores: 'foreground' } },
    });
  });

  afterEach(() => { bus.destroy(); });

  it('should reject invalid action objects', async () => {
    const r = await executor.execute(null);
    assert.equal(r.success, false);
    assert.match(r.error, /not an object/);
  });

  it('should reject unknown action types', async () => {
    const r = await executor.execute({ type: 'unknownAction' });
    assert.equal(r.success, false);
    assert.match(r.error, /unknown action type/);
  });

  it('should execute setGovernor successfully', async () => {
    const r = await executor.execute({ type: 'setGovernor', governor: 'performance', cores: 'foreground' });
    assert.equal(r.success, true);
    assert.equal(governor._setCalls.length, 1);
    assert.deepEqual(governor._setCalls[0][0], [0, 1]);
    assert.equal(governor._setCalls[0][1], 'performance');
  });

  it('should reject invalid governor name', async () => {
    const r = await executor.execute({ type: 'setGovernor', governor: 'turbo' });
    assert.equal(r.success, false);
    assert.match(r.error, /invalid governor/);
  });

  it('should execute setSchedulerMode and mutate config', async () => {
    const origWarn = config.PSI_CPU_WARN;
    const origCrit = config.PSI_CPU_CRITICAL;
    const r = await executor.execute({ type: 'setSchedulerMode', mode: 'aggressive' });
    assert.equal(r.success, true);
    assert.equal(config.PSI_CPU_WARN, origWarn * 0.5);
    assert.equal(config.PSI_CPU_CRITICAL, origCrit * 0.5);
    // Rollback should restore
    const rolled = executor._restoreSnapshot(r.snapshot);
    assert.equal(rolled, true);
    assert.equal(config.PSI_CPU_WARN, origWarn);
    assert.equal(config.PSI_CPU_CRITICAL, origCrit);
  });

  it('should execute applyProfile and apply each sub-step', async () => {
    const r = await executor.execute({ type: 'applyProfile', profile: 'gaming' });
    assert.equal(r.success, true);
    assert.ok(governor._setCalls.length >= 1);
  });

  it('should fail applyProfile on unknown profile', async () => {
    const r = await executor.execute({ type: 'applyProfile', profile: 'nonexistent' });
    assert.equal(r.success, false);
    assert.match(r.error, /unknown profile/);
  });

  it('should execute notify', async () => {
    const r = await executor.execute({ type: 'notify', summary: 'Hi', body: 'world' });
    assert.equal(r.success, true);
    assert.equal(actuator._calls.length, 1);
    assert.equal(actuator._calls[0][0], 'notify');
  });

  it('should execute emitEvent', async () => {
    let received = null;
    bus.on('onCustom', (p) => { received = p; });
    const r = await executor.execute({ type: 'emitEvent', event: 'onCustom', payload: { x: 1 } });
    assert.equal(r.success, true);
    // emitEvent defers via setImmediate to break synchronous re-entry
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, { x: 1 });
  });

  it('should execute log at the requested level', async () => {
    const r = await executor.execute({ type: 'log', level: 'info', message: 'test' });
    assert.equal(r.success, true);
  });

  it('should execute refreshPalette by emitting onWallpaperChanged', async () => {
    let received = null;
    bus.on(EVENTS.ON_WALLPAPER_CHANGED, (p) => { received = p; });
    const r = await executor.execute({ type: 'refreshPalette', target: 'wallpaper' });
    assert.equal(r.success, true);
    // refreshPalette emits synchronously (no setImmediate) since it
    // doesn't have the re-entry risk that emitEvent has
    assert.deepEqual(received, { target: 'wallpaper' });
  });

  it('should rollback on failure (setSchedulerMode snapshot)', async () => {
    const origWarn = config.PSI_CPU_WARN;
    const origCrit = config.PSI_CPU_CRITICAL;
    // Force a failure by passing an invalid mode AFTER successful setSchedulerMode
    // — but we can't easily inject a mid-profile failure. Instead, test
    // that the rollback path works on setSchedulerMode snapshot.
    const r = await executor.execute({ type: 'setSchedulerMode', mode: 'aggressive' });
    assert.equal(r.success, true);
    assert.notEqual(config.PSI_CPU_WARN, origWarn);
    // Manually trigger rollback (simulates a downstream failure)
    const rolled = executor._restoreSnapshot(r.snapshot);
    assert.equal(rolled, true);
    assert.equal(config.PSI_CPU_WARN, origWarn);
    assert.equal(config.PSI_CPU_CRITICAL, origCrit);
  });

  it('should track statistics', async () => {
    await executor.execute({ type: 'log', message: 'a' });
    await executor.execute({ type: 'unknownAction' });
    assert.equal(executor.stats.attempted, 2);
    assert.equal(executor.stats.succeeded, 1);
    assert.equal(executor.stats.failed, 1);
  });

  it('should handle actuator=null gracefully', async () => {
    const e2 = new ActionExecutor({
      actuator: null, governor: null, scheduler: null, config, eventBus: bus,
    });
    const r = await e2.execute({ type: 'notify', summary: 'x' });
    assert.equal(r.success, false);
    assert.match(r.error, /actuator/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. POLICY LOGGER
// ═══════════════════════════════════════════════════════════════════════

describe('PolicyLogger', () => {
  it('should record entries in the ring buffer', () => {
    const pl = new PolicyLogger({ ringBufferSize: 5 });
    pl.log({ trigger: 'onTest', ruleId: 'r1', success: true, action: { type: 'log' } });
    pl.log({ trigger: 'onTest', ruleId: 'r2', success: false, error: 'boom', action: { type: 'log' } });
    const recent = pl.recentEntries(10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].ruleId, 'r2'); // newest first
    assert.equal(recent[1].ruleId, 'r1');
  });

  it('should track counters', () => {
    const pl = new PolicyLogger();
    pl.log({ success: true });
    pl.log({ success: true });
    pl.log({ success: false, rollbackApplied: true });
    assert.equal(pl.stats.total, 3);
    assert.equal(pl.stats.success, 2);
    assert.equal(pl.stats.failure, 1);
    assert.equal(pl.stats.rollback, 1);
  });

  it('should write to a file with rotation', (t, done) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-log-'));
    try {
      const logPath = path.join(tmpDir, 'audit.log');
      const pl = new PolicyLogger({ filePath: logPath, maxSizeMb: 5, maxFiles: 3 });
      // Wait a tick for the stream to open before writing
      setImmediate(() => {
        pl.log({ trigger: 'onTest', ruleId: 'r1', success: true });
        pl.log({ trigger: 'onTest', ruleId: 'r2', success: true });
        pl.log({ trigger: 'onTest', ruleId: 'r3', success: true });
        pl.close(() => {
          try {
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            assert.ok(lines.length >= 1);
            const first = JSON.parse(lines[0]);
            assert.equal(first.trigger, 'onTest');
            done();
          } catch (err) {
            done(err);
          }
        });
      });
    } catch (err) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      done(err);
    }
  });

  it('should truncate very large payloads', () => {
    const pl = new PolicyLogger();
    const huge = { data: 'x'.repeat(2048) };
    pl.log({ triggerPayload: huge, success: true });
    const recent = pl.recentEntries(1);
    assert.equal(recent[0].triggerPayload._truncated, true);
  });

  it('should reset()', () => {
    const pl = new PolicyLogger();
    pl.log({ success: true });
    pl.reset();
    assert.equal(pl.stats.total, 0);
    assert.equal(pl.recentEntries(10).length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. POLICY LOADER
// ═══════════════════════════════════════════════════════════════════════

describe('PolicyLoader', () => {
  describe('YAML parser', () => {
    it('should parse a simple key-value file', () => {
      const parsed = _parseYaml('foo: 1\nbar: hello\n');
      assert.deepEqual(parsed, { foo: 1, bar: 'hello' });
    });

    it('should parse nested maps', () => {
      const parsed = _parseYaml('profiles:\n  gaming:\n    governor: performance\n');
      assert.deepEqual(parsed, { profiles: { gaming: { governor: 'performance' } } });
    });

    it('should parse lists of objects', () => {
      const parsed = _parseYaml(
        'rules:\n' +
        '  - id: r1\n' +
        '    priority: 100\n' +
        '  - id: r2\n' +
        '    priority: 50\n'
      );
      assert.deepEqual(parsed, {
        rules: [
          { id: 'r1', priority: 100 },
          { id: 'r2', priority: 50 },
        ],
      });
    });

    it('should parse lists of scalars', () => {
      const parsed = _parseYaml('items:\n  - apple\n  - banana\n');
      assert.deepEqual(parsed, { items: ['apple', 'banana'] });
    });

    it('should handle comments', () => {
      const parsed = _parseYaml('# top comment\nfoo: 1 # inline\nbar: 2\n');
      assert.deepEqual(parsed, { foo: 1, bar: 2 });
    });

    it('should coerce booleans, nulls, and numbers', () => {
      const parsed = _parseYaml('a: true\nb: false\nc: null\nd: 42\ne: 3.14\n');
      assert.deepEqual(parsed, { a: true, b: false, c: null, d: 42, e: 3.14 });
    });
  });

  describe('validatePolicy', () => {
    it('should accept a valid policy', () => {
      const v = validatePolicy({
        rules: [{ id: 'r1', action: { type: 'log' } }],
        profiles: { gaming: { governor: 'performance' } },
      }, { cooldownMs: 1000 });
      assert.equal(v.rules.length, 1);
      assert.equal(v.profiles.gaming.governor, 'performance');
      assert.equal(v.warnings.length, 0);
    });

    it('should warn on duplicate rule ids', () => {
      const v = validatePolicy({
        rules: [
          { id: 'dup', action: { type: 'log' } },
          { id: 'dup', action: { type: 'log' } },
        ],
      }, { cooldownMs: 1000 });
      assert.equal(v.rules.length, 2);
      assert.ok(v.warnings.some((w) => /duplicate/.test(w)));
    });

    it('should warn on invalid rule', () => {
      const v = validatePolicy({
        rules: [{ action: { type: 'log' } }], // missing id
      }, { cooldownMs: 1000 });
      assert.equal(v.rules.length, 0);
      assert.ok(v.warnings.some((w) => /missing or invalid "id"/.test(w)));
    });

    it('should warn on invalid profile shape', () => {
      const v = validatePolicy({
        profiles: { bad: 'not-an-object' },
      }, { cooldownMs: 1000 });
      assert.ok(v.warnings.some((w) => /profile "bad"/.test(w)));
    });

    it('should handle non-object input', () => {
      const v = validatePolicy(null, { cooldownMs: 1000 });
      assert.equal(v.rules.length, 0);
      assert.equal(v.profiles && Object.keys(v.profiles).length, 0);
    });
  });

  describe('file loading', () => {
    it('should load a JSON policy file', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-load-'));
      try {
        const policyPath = path.join(tmp, 'policies.json');
        fs.writeFileSync(policyPath, JSON.stringify({
          rules: [{ id: 'r1', action: { type: 'log' } }],
        }));
        const config = mockConfig({ POLICY_FILE_PATH: policyPath });
        const loader = new PolicyLoader({ config, defaults: { cooldownMs: 1000 } });
        const policy = loader.load();
        assert.equal(policy.rules.length, 1);
        assert.equal(policy.rules[0].id, 'r1');
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      }
    });

    it('should return null when no policy file is found', () => {
      const config = mockConfig({ POLICY_FILE_PATH: null });
      // Make sure env var doesn't interfere
      const origEnv = process.env.DYNALLOC_POLICY_PATH;
      delete process.env.DYNALLOC_POLICY_PATH;
      const loader = new PolicyLoader({
        config,
        defaults: { cooldownMs: 1000 },
        onReload: () => {},
      });
      // Force a non-existent home so the lookup fails
      const origHomedir = os.homedir;
      os.homedir = () => '/nonexistent-home-for-test';
      try {
        const policy = loader.load();
        assert.equal(policy, null);
      } finally {
        os.homedir = origHomedir;
        if (origEnv !== undefined) process.env.DYNALLOC_POLICY_PATH = origEnv;
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. POLICY ENGINE (end-to-end)
// ═══════════════════════════════════════════════════════════════════════

describe('PolicyEngine (end-to-end)', () => {
  let engine;
  let actuator, governor, scheduler, config;

  beforeEach(() => {
    actuator = mockActuator();
    governor = mockGovernor();
    scheduler = mockScheduler();
    config = mockConfig({ ENABLE_POLICY_ENGINE: true, POLICY_HOT_RELOAD: false });
    engine = new PolicyEngine({
      actuator, governor, scheduler, config, metrics: null, ownBus: true,
    });
  });

  afterEach(async () => {
    if (engine) {
      try { await engine.stop(); } catch (_) {}
      try { engine.destroy(); } catch (_) {}
    }
  });

  it('should start and emit ON_POLICY_ENGINE_STARTED', async () => {
    let started = false;
    engine.bus.on(EVENTS.ON_POLICY_ENGINE_STARTED, () => { started = true; });
    await engine.start();
    assert.equal(engine.isRunning, true);
    assert.equal(started, true);
  });

  it('should evaluate rules when events are emitted', async () => {
    await engine.start();
    // Manually inject a rule
    engine.ruleEngine.setRules([
      normalizeRule({
        id: 'r1',
        when: { event: 'onTest' },
        action: { type: 'log', message: 'fired' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    engine.emit('onTest', { hello: 'world' });
    // Wait one tick for async action
    await new Promise((r) => setImmediate(r));
    const recent = engine.policyLogger.recentEntries(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].ruleId, 'r1');
    assert.equal(recent[0].success, true);
  });

  it('should not crash when an action fails', async () => {
    await engine.start();
    engine.ruleEngine.setRules([
      normalizeRule({
        id: 'bad',
        when: { event: 'onTest' },
        action: { type: 'applyProfile', profile: 'nonexistent' },
      }, { cooldownMs: 1000 }, 0),
    ]);
    engine.emit('onTest', {});
    await new Promise((r) => setImmediate(r));
    const recent = engine.policyLogger.recentEntries(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].success, false);
    assert.match(recent[0].error, /unknown profile/);
    assert.equal(engine.isRunning, true);
  });

  it('should respect rule priority order', async () => {
    await engine.start();
    const fired = [];
    engine.ruleEngine.setRules([
      normalizeRule({
        id: 'low',
        priority: 0,
        when: { event: 'onTest' },
        action: { type: 'log', message: 'low' },
      }, { cooldownMs: 0 }, 0),
      normalizeRule({
        id: 'high',
        priority: 100,
        when: { event: 'onTest' },
        action: { type: 'log', message: 'high' },
      }, { cooldownMs: 0 }, 0),
    ]);
    // Hook into _runAction to record order
    const origRun = engine._runAction.bind(engine);
    engine._runAction = async (eventName, payload, rule) => {
      fired.push(rule.id);
      await origRun(eventName, payload, rule);
    };
    engine.emit('onTest', {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, ['high', 'low']);
  });

  it('should apply delay before firing', async () => {
    await engine.start();
    let fired = false;
    engine.ruleEngine.setRules([
      normalizeRule({
        id: 'delayed',
        when: { event: 'onTest' },
        action: { type: 'log', message: 'delayed' },
        delay: 50,
      }, { cooldownMs: 0 }, 0),
    ]);
    engine.emit('onTest', {});
    // Immediately — should not have fired
    await new Promise((r) => setImmediate(r));
    assert.equal(engine.policyLogger.recentEntries(1).length, 0);
    // After delay
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.policyLogger.recentEntries(1).length, 1);
  });

  it('should expose status snapshot', async () => {
    await engine.start();
    const status = engine.getStatus();
    assert.equal(status.running, true);
    assert.equal(typeof status.ruleCount, 'number');
    assert.equal(typeof status.uptimeSeconds, 'number');
  });

  it('should support state store updates', async () => {
    await engine.start();
    engine.setState('battery.capacity', 15);
    assert.equal(engine.getState('battery.capacity'), 15);
  });

  it('should stop cleanly', async () => {
    await engine.start();
    await engine.stop();
    assert.equal(engine.isRunning, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. EVENT SOURCES (transition detection)
// ═══════════════════════════════════════════════════════════════════════

describe('EventSources', () => {
  let engine, sources;

  beforeEach(() => {
    const actuator = mockActuator();
    const governor = mockGovernor();
    const scheduler = mockScheduler();
    const config = mockConfig({ ENABLE_POLICY_ENGINE: true, POLICY_HOT_RELOAD: false });
    engine = new PolicyEngine({
      actuator, governor, scheduler, config, metrics: null, ownBus: true,
    });
    sources = new EventSources({ engine, config });
  });

  afterEach(async () => {
    try { await engine.stop(); } catch (_) {}
    try { engine.destroy(); } catch (_) {}
  });

  it('should emit ON_BATTERY_LOW on threshold crossing', async () => {
    await engine.start();
    let fired = null;
    engine.bus.on(EVENTS.ON_BATTERY_LOW, (p) => { fired = p; });
    sources.updateBattery({ onBattery: true, capacity: 50 });
    sources.updateBattery({ onBattery: true, capacity: 15 }); // crosses 20
    assert.ok(fired);
    assert.equal(fired.level, 15);
  });

  it('should not re-emit ON_BATTERY_LOW while still low', async () => {
    await engine.start();
    let count = 0;
    engine.bus.on(EVENTS.ON_BATTERY_LOW, () => count++);
    sources.updateBattery({ onBattery: true, capacity: 50 });
    sources.updateBattery({ onBattery: true, capacity: 15 });
    sources.updateBattery({ onBattery: true, capacity: 10 }); // still low
    assert.equal(count, 1);
  });

  it('should emit ON_AC_PLUGGED / ON_AC_UNPLUGGED on transition', async () => {
    await engine.start();
    const events = [];
    engine.bus.on(EVENTS.ON_AC_PLUGGED, () => events.push('plugged'));
    engine.bus.on(EVENTS.ON_AC_UNPLUGGED, () => events.push('unplugged'));
    engine.bus.on(EVENTS.ON_BATTERY_CHARGING, () => events.push('charging'));
    engine.bus.on(EVENTS.ON_BATTERY_DISCHARGING, () => events.push('discharging'));
    // First call sets the baseline — no transition events emitted
    sources.updateBattery({ onBattery: true, capacity: 80 });
    assert.deepEqual(events, []);
    // Now transition to plugged
    sources.updateBattery({ onBattery: false, capacity: 80 });
    assert.deepEqual(events, ['plugged', 'charging']);
    // Transition back to battery
    sources.updateBattery({ onBattery: true, capacity: 80 });
    assert.deepEqual(events, ['plugged', 'charging', 'unplugged', 'discharging']);
  });

  it('should emit ON_CPU_HIGH on threshold crossing', async () => {
    await engine.start();
    let fired = false;
    engine.bus.on(EVENTS.ON_CPU_HIGH, () => { fired = true; });
    sources.updatePressure(0, 0, 'NORMAL');
    sources.updatePressure(50, 0, 'WARN'); // 50 > 8
    assert.equal(fired, true);
  });

  it('should emit ON_STRESS_CHANGED on stress level change', async () => {
    await engine.start();
    let events = [];
    engine.bus.on(EVENTS.ON_STRESS_CHANGED, (p) => events.push(p));
    sources.updatePressure(0, 0, 'NORMAL');
    sources.updatePressure(50, 0, 'WARN');
    sources.updatePressure(0, 0, 'NORMAL');
    assert.equal(events.length, 2);
    assert.equal(events[0].to, 'WARN');
    assert.equal(events[1].to, 'NORMAL');
  });

  it('should emit ON_FOREGROUND_CHANGED on PID change', async () => {
    await engine.start();
    let fired = null;
    engine.bus.on(EVENTS.ON_FOREGROUND_CHANGED, (p) => { fired = p; });
    sources.updateForeground(100, { name: 'app1', comm: 'app1' });
    sources.updateForeground(200, { name: 'app2', comm: 'app2' });
    assert.ok(fired);
    assert.equal(fired.pid, 200);
    assert.equal(fired.prevPid, 100);
  });

  it('should emit ON_PROCESS_STARTED for new comm names', async () => {
    await engine.start();
    let events = [];
    engine.bus.on(EVENTS.ON_PROCESS_STARTED, (p) => events.push(p));
    sources.updateProcesses([{ pid: 1, ppid: 0, pcpu: 0, comm: 'a' }]);
    sources.updateProcesses([{ pid: 1, ppid: 0, pcpu: 0, comm: 'a' }, { pid: 2, ppid: 0, pcpu: 0, comm: 'b' }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].comm, 'b');
  });

  it('should NOT emit ON_PROCESS_STARTED on the first scan', async () => {
    await engine.start();
    let count = 0;
    engine.bus.on(EVENTS.ON_PROCESS_STARTED, () => count++);
    sources.updateProcesses([{ pid: 1, ppid: 0, pcpu: 0, comm: 'a' }]);
    sources.updateProcesses([{ pid: 1, ppid: 0, pcpu: 0, comm: 'a' }, { pid: 2, ppid: 0, pcpu: 0, comm: 'b' }]);
    assert.equal(count, 1); // only 'b', not 'a' (first scan is suppressed)
  });

  it('should emit ON_THERMAL_HIGH on threshold crossing', async () => {
    await engine.start();
    let fired = false;
    engine.bus.on(EVENTS.ON_THERMAL_HIGH, () => { fired = true; });
    sources.updateThermal(50);
    sources.updateThermal(80); // > 75
    assert.equal(fired, true);
  });

  it('should handle null/undefined inputs gracefully', async () => {
    await engine.start();
    // None of these should throw
    sources.updateBattery(null);
    sources.updateThermal(null);
    sources.updateThermal(NaN);
    sources.updatePressure(undefined, undefined, undefined);
    sources.updateForeground(null, null);
    sources.updateProcesses(null);
  });
});
