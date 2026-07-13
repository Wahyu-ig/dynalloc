'use strict';

/**
 * test-profile-manager.js — Unit tests for the v0.5.0 Phase 3
 * Profile Manager & Adaptive Policy Profiles.
 *
 * Run with: node --test test/unit/test-profile-manager.js
 *
 * Covers:
 *   - Profile base class (validation, lifecycle, versioning)
 *   - ProfileRegistry (register/unregister, duplicate detection,
 *     circular inheritance, inheritance resolution, file loading)
 *   - ProfileManager (demand set, conflict resolution, event handling,
 *     idle timeout, activation/deactivation lifecycle)
 *   - Built-in profiles (9 profiles, correct priorities, inheritance)
 *   - Event-driven activation (workload/power/idle events)
 *   - Conflict resolution (gaming > development, battery-saver > performance, etc.)
 *   - Backward compatibility
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const Profile = require(path.join(__dirname, '..', '..', 'profiles', 'base-profile.js'));
const ProfileRegistry = require(path.join(__dirname, '..', '..', 'profiles', 'profile-registry.js'));
const ProfileManager = require(path.join(__dirname, '..', '..', 'profiles', 'profile-manager.js'));
const { createBuiltinProfiles, BUILTIN_DEFINITIONS } = require(path.join(__dirname, '..', '..', 'profiles', 'builtin-profiles.js'));
const profileIndex = require(path.join(__dirname, '..', '..', 'profiles'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));
const { EventBus } = require(path.join(__dirname, '..', '..', 'policy-engine', 'event-bus.js'));
const { StateStore } = require(path.join(__dirname, '..', '..', 'policy-engine', 'state-store.js'));

// ── Test helpers ──────────────────────────────────────────────────────

function makeConfig(overrides) {
  return { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
}

function makeFakeRcm() {
  const calls = [];
  return {
    calls,
    applyThermalProfile(profile) {
      calls.push({ method: 'applyThermalProfile', args: [profile] });
      return { success: true, error: null, profile, snapshot: {} };
    },
    applyPowerProfile(profile) {
      calls.push({ method: 'applyPowerProfile', args: [profile] });
      return { success: true, error: null, profile, snapshot: {} };
    },
    setPpdProfile(profile) {
      calls.push({ method: 'setPpdProfile', args: [profile] });
      return { success: true, error: null, profile };
    },
    setGovernor(cores, governor) {
      calls.push({ method: 'setGovernor', args: [cores, governor] });
      return { success: true, error: null };
    },
    getController(_name) { return null; },
  };
}

// ── Profile base class ────────────────────────────────────────────────

test('Profile requires valid id', () => {
  assert.throws(() => new Profile({ id: '', version: '1.0.0' }), /invalid id/);
  assert.throws(() => new Profile({ id: 'Invalid', version: '1.0.0' }), /invalid id/);
  assert.throws(() => new Profile({ id: '1foo', version: '1.0.0' }), /invalid id/);
  assert.throws(() => new Profile({ version: '1.0.0' }), /invalid id/);
});

test('Profile requires valid semver version', () => {
  assert.throws(() => new Profile({ id: 'test', version: '1.0' }), /invalid version/);
  assert.throws(() => new Profile({ id: 'test', version: 'v1.0.0' }), /invalid version/);
  assert.throws(() => new Profile({ id: 'test' }), /invalid version/);
});

test('Profile validates priority range', () => {
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', priority: -1 }), /priority/);
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', priority: 1001 }), /priority/);
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', priority: 1.5 }), /priority/);
});

test('Profile validates inherits is array of valid IDs', () => {
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', inherits: 'foo' }), /inherits/);
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', inherits: ['Invalid'] }), /inherits/);
  assert.ok(new Profile({ id: 't', version: '1.0.0', inherits: ['parent-id'] }));
});

test('Profile validates settings is object', () => {
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', settings: 'foo' }), /settings/);
  assert.throws(() => new Profile({ id: 't', version: '1.0.0', settings: [] }), /settings/);
  assert.ok(new Profile({ id: 't', version: '1.0.0', settings: { thermal: { profile: 'cool' } } }));
});

test('Profile accessors return correct values', () => {
  const p = new Profile({
    id: 'gaming', version: '1.2.0', description: 'Gaming',
    priority: 500, inherits: ['performance'],
    settings: { thermal: { profile: 'cool' } },
    metadata: { author: 'me' },
  });
  assert.strictEqual(p.id, 'gaming');
  assert.strictEqual(p.version, '1.2.0');
  assert.strictEqual(p.description, 'Gaming');
  assert.strictEqual(p.priority, 500);
  assert.deepStrictEqual(p.inherits, ['performance']);
  assert.deepStrictEqual(p.settings, { thermal: { profile: 'cool' } });
  assert.deepStrictEqual(p.metadata, { author: 'me' });
});

test('Profile lifecycle hooks default to no-op', () => {
  const p = new Profile({ id: 't', version: '1.0.0' });
  assert.strictEqual(p.onActivate({}), true);
  assert.strictEqual(p.onDeactivate({}), undefined);
});

test('Profile isActive starts false', () => {
  const p = new Profile({ id: 't', version: '1.0.0' });
  assert.strictEqual(p.isActive, false);
  assert.strictEqual(p.activeSince, null);
});

test('Profile toJSON returns plain object', () => {
  const p = new Profile({ id: 't', version: '1.0.0', priority: 100 });
  const json = p.toJSON();
  assert.strictEqual(typeof json, 'object');
  assert.strictEqual(json.id, 't');
  assert.strictEqual(json.isActive, false);
});

// ── ProfileRegistry ───────────────────────────────────────────────────

test('ProfileRegistry starts empty', () => {
  const r = new ProfileRegistry();
  assert.strictEqual(r.size, 0);
  assert.deepStrictEqual(r.ids, []);
});

test('ProfileRegistry.register accepts valid profile', () => {
  const r = new ProfileRegistry();
  const result = r.register({ id: 'test', version: '1.0.0', priority: 100 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(r.size, 1);
  assert.ok(r.get('test') instanceof Profile);
});

test('ProfileRegistry.register rejects invalid profile', () => {
  const r = new ProfileRegistry();
  const result = r.register({ id: '', version: '1.0.0' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error);
  assert.strictEqual(r.size, 0);
});

test('ProfileRegistry.register rejects duplicate id+version', () => {
  const r = new ProfileRegistry();
  r.register({ id: 'test', version: '1.0.0' });
  const result = r.register({ id: 'test', version: '1.0.0' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('duplicate'));
});

test('ProfileRegistry.register replaces different version of same id', () => {
  const r = new ProfileRegistry();
  r.register({ id: 'test', version: '1.0.0' });
  const result = r.register({ id: 'test', version: '2.0.0' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(r.get('test').version, '2.0.0');
});

test('ProfileRegistry.registerAll registers multiple profiles', () => {
  const r = new ProfileRegistry();
  const result = r.registerAll([
    { id: 'a', version: '1.0.0' },
    { id: 'b', version: '1.0.0' },
    { id: 'c', version: '1.0.0' },
  ]);
  assert.strictEqual(result.registered, 3);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(r.size, 3);
});

test('ProfileRegistry.registerAll collects errors without crashing', () => {
  const r = new ProfileRegistry();
  const result = r.registerAll([
    { id: 'a', version: '1.0.0' },
    { id: '', version: '1.0.0' },         // invalid
    { id: 'c', version: 'invalid' },      // invalid
    { id: 'd', version: '1.0.0' },
  ]);
  assert.strictEqual(result.registered, 2);
  assert.strictEqual(result.errors.length, 2);
});

test('ProfileRegistry resolves inheritance', () => {
  const r = new ProfileRegistry();
  r.registerAll([
    { id: 'parent', version: '1.0.0', settings: { thermal: { profile: 'balanced' }, power: { profile: 'balanced' } } },
    { id: 'child', version: '1.0.0', inherits: ['parent'], settings: { thermal: { profile: 'cool' } } },
  ]);
  const child = r.get('child');
  // Child should inherit parent's power setting + override thermal
  assert.strictEqual(child.settings.thermal.profile, 'cool');
  assert.strictEqual(child.settings.power.profile, 'balanced');
});

test('ProfileRegistry detects circular inheritance', () => {
  const r = new ProfileRegistry();
  r.registerAll([
    { id: 'a', version: '1.0.0', inherits: ['b'] },
    { id: 'b', version: '1.0.0', inherits: ['a'] },
  ]);
  // Should not throw — falls back to raw settings with a warning
  const a = r.get('a');
  assert.ok(a.settings);
});

test('ProfileRegistry handles missing parent gracefully', () => {
  const r = new ProfileRegistry();
  r.registerAll([
    { id: 'orphan', version: '1.0.0', inherits: ['nonexistent'], settings: { thermal: { profile: 'cool' } } },
  ]);
  const orphan = r.get('orphan');
  assert.strictEqual(orphan.settings.thermal.profile, 'cool');
});

test('ProfileRegistry.unregister removes profile', () => {
  const r = new ProfileRegistry();
  r.register({ id: 'test', version: '1.0.0' });
  assert.strictEqual(r.unregister('test'), true);
  assert.strictEqual(r.size, 0);
  assert.strictEqual(r.unregister('nonexistent'), false);
});

test('ProfileRegistry.loadFile loads JSON profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
  const filePath = path.join(tmpDir, 'profiles.json');
  fs.writeFileSync(filePath, JSON.stringify({
    profiles: [
      { id: 'custom1', version: '1.0.0', priority: 100 },
      { id: 'custom2', version: '1.0.0', priority: 200 },
    ],
  }));
  const r = new ProfileRegistry();
  const result = r.loadFile(filePath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.loaded, 2);
  assert.strictEqual(r.size, 2);
  r.stopWatch();
  fs.unlinkSync(filePath);
  fs.rmdirSync(tmpDir);
});

test('ProfileRegistry.loadFile rejects non-existent file', () => {
  const r = new ProfileRegistry();
  const result = r.loadFile('/nonexistent/path.json');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('not found'));
});

test('ProfileRegistry.loadFile rejects path traversal', () => {
  const r = new ProfileRegistry();
  const result = r.loadFile('../../../etc/passwd');
  assert.strictEqual(result.success, false);
});

test('ProfileRegistry.loadFile accepts array format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
  const filePath = path.join(tmpDir, 'profiles.json');
  fs.writeFileSync(filePath, JSON.stringify([
    { id: 'arr1', version: '1.0.0' },
  ]));
  const r = new ProfileRegistry();
  const result = r.loadFile(filePath);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.loaded, 1);
  r.stopWatch();
  fs.unlinkSync(filePath);
  fs.rmdirSync(tmpDir);
});

// ── Built-in profiles ─────────────────────────────────────────────────

test('createBuiltinProfiles returns 9 profiles', () => {
  const profiles = createBuiltinProfiles();
  assert.strictEqual(profiles.length, 9);
});

test('built-in profiles have unique IDs', () => {
  const profiles = createBuiltinProfiles();
  const ids = profiles.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('built-in profiles have valid versions', () => {
  for (const p of createBuiltinProfiles()) {
    assert.ok(/^\d+\.\d+\.\d+$/.test(p.version), `${p.id} has invalid version`);
  }
});

test('built-in profiles have correct priorities', () => {
  const profiles = createBuiltinProfiles();
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  assert.strictEqual(byId.gaming.priority, 500);
  assert.strictEqual(byId.batterySaver ? byId.batterySaver.priority : byId['battery-saver'].priority, 450);
  assert.strictEqual(byId.rendering.priority, 400);
  assert.strictEqual(byId.development.priority, 300);
  assert.strictEqual(byId.streaming.priority, 250);
  assert.strictEqual(byId.performance.priority, 200);
  assert.strictEqual(byId.powersave.priority, 150);
  assert.strictEqual(byId.balanced.priority, 100);
  assert.strictEqual(byId.idle.priority, 50);
});

test('gaming inherits performance', () => {
  const profiles = createBuiltinProfiles();
  const gaming = profiles.find((p) => p.id === 'gaming');
  assert.deepStrictEqual(gaming.inherits, ['performance']);
});

test('battery-saver inherits powersave', () => {
  const profiles = createBuiltinProfiles();
  const bs = profiles.find((p) => p.id === 'battery-saver');
  assert.deepStrictEqual(bs.inherits, ['powersave']);
});

test('built-in profiles register successfully in registry', () => {
  const r = new ProfileRegistry();
  const result = r.registerAll(createBuiltinProfiles());
  assert.strictEqual(result.registered, 9);
  assert.strictEqual(result.errors.length, 0);
});

// ── ProfileManager ────────────────────────────────────────────────────

test('ProfileManager requires config, bus, rcm', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  assert.throws(() => new ProfileManager({}), TypeError);
  assert.throws(() => new ProfileManager({ config }), TypeError);
  assert.throws(() => new ProfileManager({ config, bus }), TypeError);
  assert.ok(new ProfileManager({ config, bus, rcm }));
});

test('ProfileManager setup registers 9 built-in profiles', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  assert.strictEqual(mgr.registry.size, 9);
  mgr.destroy();
});

test('ProfileManager starts with balanced as default demand', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // No demand → should default to 'balanced'
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager.demand activates higher-priority profile', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // Demand gaming → should activate gaming (priority 500)
  mgr.demand('test', 'gaming');
  assert.strictEqual(mgr.activeProfileId, 'gaming');
  mgr.destroy();
});

test('ProfileManager conflict resolution: gaming > development', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  mgr.demand('dev-source', 'development');   // priority 300
  mgr.demand('game-source', 'gaming');       // priority 500
  assert.strictEqual(mgr.activeProfileId, 'gaming');
  // Withdraw gaming demand → development should win
  mgr.demand('game-source', null);
  assert.strictEqual(mgr.activeProfileId, 'development');
  mgr.destroy();
});

test('ProfileManager conflict resolution: battery-saver > performance', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  mgr.demand('perf-source', 'performance');     // priority 200
  mgr.demand('battery-source', 'battery-saver'); // priority 450
  assert.strictEqual(mgr.activeProfileId, 'battery-saver');
  mgr.destroy();
});

test('ProfileManager conflict resolution: idle only wins when demand set is empty', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // Demand idle → idle wins (demand set has only idle)
  mgr.demand('idle-source', 'idle');
  assert.strictEqual(mgr.activeProfileId, 'idle');
  // Demand performance → performance wins (priority 200 > 50)
  mgr.demand('perf-source', 'performance');
  assert.strictEqual(mgr.activeProfileId, 'performance');
  // Withdraw performance → idle wins again
  mgr.demand('perf-source', null);
  assert.strictEqual(mgr.activeProfileId, 'idle');
  // Withdraw idle → balanced (default)
  mgr.demand('idle-source', null);
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager handles workload event', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  bus.emit('onWorkloadDetected', { workload: 'GAME' });
  assert.strictEqual(mgr.activeProfileId, 'gaming');
  // A new workload event from the SAME source ('workload') overwrites
  // the previous demand. IDE → development (priority 300).
  bus.emit('onWorkloadDetected', { workload: 'IDE' });
  assert.strictEqual(mgr.activeProfileId, 'development');
  // Workload NONE withdraws the workload demand → balanced
  bus.emit('onWorkloadDetected', { workload: 'NONE' });
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager handles power state event', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  bus.emit('onPowerStateChanged', { to: 'BATTERY_LOW' });
  assert.strictEqual(mgr.activeProfileId, 'battery-saver');
  bus.emit('onPowerStateChanged', { to: 'AC' });
  // AC withdraws power demand → balanced
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager idle event starts timer', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig({ PROFILE_IDLE_TIMEOUT_MS: 100 });  // 100ms for test
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // Emit idle → timer starts but idle profile not yet active
  bus.emit('onIdleStateChanged', { to: 'IDLE' });
  assert.strictEqual(mgr.activeProfileId, 'balanced');  // not yet
  // Wait for timer
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(mgr.activeProfileId, 'idle');
      // Emit active → cancels timer + withdraws idle demand
      bus.emit('onIdleStateChanged', { to: 'ACTIVE' });
      assert.strictEqual(mgr.activeProfileId, 'balanced');
      mgr.destroy();
      resolve();
    }, 200);
  });
});

test('ProfileManager applies settings via RCM on activation', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  mgr.demand('test', 'gaming');
  // gaming inherits performance → power:performance + thermal:cool (override)
  const thermalCalls = rcm.calls.filter((c) => c.method === 'applyThermalProfile');
  const powerCalls = rcm.calls.filter((c) => c.method === 'applyPowerProfile');
  assert.ok(thermalCalls.length >= 1);
  assert.ok(powerCalls.length >= 1);
  // The last thermal call should be 'cool' (gaming's override)
  const lastThermal = thermalCalls[thermalCalls.length - 1];
  assert.strictEqual(lastThermal.args[0], 'cool');
  mgr.destroy();
});

test('ProfileManager.demand rejects unknown profile', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  assert.strictEqual(mgr.demand('test', 'nonexistent'), false);
  mgr.destroy();
});

test('ProfileManager.demand null withdraws demand', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  mgr.demand('test', 'gaming');
  assert.strictEqual(mgr.activeProfileId, 'gaming');
  mgr.demand('test', null);
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager getStatus returns snapshot', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // start() activates 'balanced' (switch 1), then demand activates gaming (switch 2)
  mgr.demand('test', 'gaming');
  const status = mgr.getStatus();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.profileCount, 9);
  assert.strictEqual(status.activeProfileId, 'gaming');
  assert.ok(status.activeProfile);
  assert.strictEqual(status.demandSet.length, 1);
  assert.strictEqual(status.switchCount, 2);  // balanced→gaming = 2 switches
  assert.ok(Array.isArray(status.profiles));
  assert.strictEqual(status.profiles.length, 9);
  mgr.destroy();
});

test('ProfileManager emits onProfileChanged event', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  let received = null;
  bus.on('onProfileChanged', (p) => { received = p; });
  mgr.demand('test', 'gaming');
  assert.ok(received);
  assert.strictEqual(received.from, 'balanced');
  assert.strictEqual(received.to, 'gaming');
  mgr.destroy();
});

test('ProfileManager updates stateStore on activation', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const stateStore = new StateStore();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm, stateStore });
  mgr.setup();
  mgr.start();
  mgr.demand('test', 'gaming');
  assert.strictEqual(stateStore.get('profile.active'), 'gaming');
  assert.strictEqual(stateStore.get('profile.previous'), 'balanced');
  mgr.destroy();
});

test('ProfileManager destroy is idempotent', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  mgr.destroy();
  mgr.destroy();  // should not throw
});

test('ProfileManager setConfig updates config reference', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig({ PROFILE_IDLE_TIMEOUT_MS: 300000 });
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  const newConfig = makeConfig({ PROFILE_IDLE_TIMEOUT_MS: 60000 });
  mgr.setConfig(newConfig);
  // Internal config reference should be updated
  assert.strictEqual(mgr._config.PROFILE_IDLE_TIMEOUT_MS, 60000);
  mgr.destroy();
});

// ── Public API ────────────────────────────────────────────────────────

test('profiles/index.js exports all expected names', () => {
  assert.strictEqual(typeof profileIndex.Profile, 'function');
  assert.strictEqual(typeof profileIndex.ProfileRegistry, 'function');
  assert.strictEqual(typeof profileIndex.ProfileManager, 'function');
  assert.strictEqual(typeof profileIndex.createBuiltinProfiles, 'function');
  assert.ok(Array.isArray(profileIndex.BUILTIN_DEFINITIONS));
});

// ── Edge cases ────────────────────────────────────────────────────────

test('ProfileManager handles events received before start', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  // Emit event before start() — should be ignored
  bus.emit('onWorkloadDetected', { workload: 'GAME' });
  assert.strictEqual(mgr.activeProfileId, null);
  mgr.start();
  // After start, no demand yet → balanced
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager handles unknown workload classification', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  bus.emit('onWorkloadDetected', { workload: 'UNKNOWN_CLASS' });
  // Unknown workload → maps to null → no demand → balanced
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager handles malformed event payload', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // Malformed payloads should not crash
  bus.emit('onWorkloadDetected', null);
  bus.emit('onWorkloadDetected', {});
  bus.emit('onWorkloadDetected', { workload: 123 });
  bus.emit('onPowerStateChanged', null);
  bus.emit('onIdleStateChanged', null);
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileManager inheritance chain resolves correctly', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  // gaming inherits performance; gaming overrides thermal to 'cool'
  mgr.demand('test', 'gaming');
  // Verify the RCM received 'cool' (gaming's override) and 'performance' (inherited power)
  const thermalCalls = rcm.calls.filter((c) => c.method === 'applyThermalProfile');
  const powerCalls = rcm.calls.filter((c) => c.method === 'applyPowerProfile');
  const lastThermal = thermalCalls[thermalCalls.length - 1];
  const lastPower = powerCalls[powerCalls.length - 1];
  assert.strictEqual(lastThermal.args[0], 'cool');
  assert.strictEqual(lastPower.args[0], 'performance');
  mgr.destroy();
});

test('ProfileManager tie-breaking by registration order', () => {
  const bus = new EventBus();
  const rcm = makeFakeRcm();
  const config = makeConfig();
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  // Register two custom profiles with same priority
  mgr.registry.registerAll([
    { id: 'custom-a', version: '1.0.0', priority: 500, settings: { thermal: { profile: 'cool' } } },
    { id: 'custom-b', version: '1.0.0', priority: 500, settings: { thermal: { profile: 'silent' } } },
  ]);
  mgr.start();
  // Demand both at the same priority — first-registered wins
  mgr.demand('source-a', 'custom-a');
  mgr.demand('source-b', 'custom-b');
  assert.strictEqual(mgr.activeProfileId, 'custom-a');
  mgr.destroy();
});
