'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sdk = require(path.join(__dirname, '..', '..', 'sdk'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));
const { EventBus } = require(path.join(__dirname, '..', '..', 'policy-engine', 'event-bus.js'));

function makeConfig(o) { return { ...DEFAULT_CONFIG, DRY_RUN: true, ...o }; }
function makeProviders() {
  return {
    getConfig: () => ({}),
    getState: () => ({ stressLevel: 'NORMAL' }),
    getMetrics: () => ({}),
    getDiagnostics: () => ({}),
    getHealth: () => ({ healthy: true }),
    getBus: () => new EventBus(),
    registerDetector: () => true,
    registerProfile: () => ({ success: true }),
    registerController: () => true,
    registerRule: () => true,
    registerCliCommand: () => true,
  };
}

// ── Permissions ───────────────────────────────────────────────────────

test('ALL_PERMISSIONS has 13 entries', () => {
  assert.ok(sdk.ALL_PERMISSIONS.length >= 13);
});

test('validatePermissions accepts valid perms', () => {
  const r = sdk.validatePermissions(['read:config', 'write:events']);
  assert.strictEqual(r.valid, true);
});

test('validatePermissions rejects invalid perms', () => {
  const r = sdk.validatePermissions(['read:config', 'invalid:perm']);
  assert.strictEqual(r.valid, false);
  assert.ok(r.invalid.includes('invalid:perm'));
});

test('hasPermission respects system:full', () => {
  const granted = new Set(['system:full']);
  assert.ok(sdk.hasPermission(granted, 'read:config'));
  assert.ok(sdk.hasPermission(granted, 'write:profiles'));
});

test('hasPermission rejects ungranted', () => {
  const granted = new Set(['read:config']);
  assert.ok(sdk.hasPermission(granted, 'read:config'));
  assert.ok(!sdk.hasPermission(granted, 'write:profiles'));
});

test('resolvePermissions merges manifest + overrides', () => {
  const set = sdk.resolvePermissions(['read:config'], { grant: ['write:events'], deny: ['read:config'] });
  assert.ok(set.has('write:events'));
  assert.ok(!set.has('read:config'));
});

// ── Manifest ──────────────────────────────────────────────────────────

test('validateManifest accepts valid manifest', () => {
  const r = sdk.validateManifest({
    id: 'com.example.test', name: 'Test', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0',
    permissions: ['read:config'], entryPoint: './index.js',
  });
  assert.strictEqual(r.valid, true);
});

test('validateManifest rejects missing fields', () => {
  const r = sdk.validateManifest({ id: 'test' });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length >= 4);
});

test('validateManifest rejects invalid id', () => {
  const r = sdk.validateManifest({
    id: 'Invalid ID!', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  assert.strictEqual(r.valid, false);
});

test('validateManifest rejects invalid version', () => {
  const r = sdk.validateManifest({
    id: 'com.test', name: 'T', version: '1.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  assert.strictEqual(r.valid, false);
});

test('validateManifest rejects invalid apiVersion', () => {
  const r = sdk.validateManifest({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: 'v1', entryPoint: './i.js',
  });
  assert.strictEqual(r.valid, false);
});

// ── Version ───────────────────────────────────────────────────────────

test('checkApiCompatibility accepts compatible versions', () => {
  const r = sdk.checkApiCompatibility('1.0', '1.2');
  assert.strictEqual(r.compatible, true);
});

test('checkApiCompatibility rejects major mismatch', () => {
  const r = sdk.checkApiCompatibility('2.0', '1.2');
  assert.strictEqual(r.compatible, false);
});

test('checkApiCompatibility rejects plugin minor > daemon minor', () => {
  const r = sdk.checkApiCompatibility('1.5', '1.2');
  assert.strictEqual(r.compatible, false);
});

test('checkDaemonCompatibility accepts within range', () => {
  const r = sdk.checkDaemonCompatibility('0.5.0', '0.5.0', '1.0.0');
  assert.strictEqual(r.compatible, true);
});

test('checkDaemonCompatibility rejects below minimum', () => {
  const r = sdk.checkDaemonCompatibility('0.4.0', '0.5.0');
  assert.strictEqual(r.compatible, false);
});

test('compareSemver works correctly', () => {
  assert.strictEqual(sdk.compareSemver('1.0.0', '1.0.0'), 0);
  assert.strictEqual(sdk.compareSemver('1.0.0', '2.0.0'), -1);
  assert.strictEqual(sdk.compareSemver('2.0.0', '1.0.0'), 1);
});

// ── PluginContext ─────────────────────────────────────────────────────

test('PluginContext requires manifest', () => {
  assert.throws(() => new sdk.PluginContext({}), TypeError);
});

test('PluginContext enforces read:config permission', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(),
    providers: { getConfig: () => ({ key: 'val' }) },
  });
  assert.throws(() => ctx.config, /lacks permission/);
});

test('PluginContext allows read:config when granted', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(['read:config']),
    providers: { getConfig: () => ({ key: 'val' }) },
  });
  assert.deepStrictEqual(ctx.config, { key: 'val' });
});

test('PluginContext log proxy works with log:write', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(['log:write']),
  });
  assert.doesNotThrow(() => ctx.log.info('test'));
});

test('PluginContext log proxy is silent without log:write', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(),
  });
  assert.doesNotThrow(() => ctx.log.info('test'));
});

test('PluginContext bus emit requires write:events', () => {
  const bus = new EventBus();
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(),
    providers: { getBus: () => bus },
  });
  assert.throws(() => ctx.bus.emit('test', {}), /lacks permission/);
});

test('PluginContext bus on (subscribe) works without write:events', () => {
  const bus = new EventBus();
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(),
    providers: { getBus: () => bus },
  });
  const id = ctx.bus.on('test', () => {});
  assert.ok(id > 0);
});

test('PluginContext registerDetector requires write:detectors', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(),
    providers: { registerDetector: () => true },
  });
  assert.throws(() => ctx.registerDetector({}), /lacks permission/);
});

test('PluginContext disable makes all calls throw', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'test', version: '1.0.0' },
    permissions: new Set(['read:config']),
    providers: { getConfig: () => ({}) },
  });
  ctx.disable();
  assert.throws(() => ctx.config, /disabled/);
});

test('PluginContext accessors return correct values', () => {
  const ctx = new sdk.PluginContext({
    manifest: { id: 'com.test', version: '2.0.0' },
    permissions: new Set(),
    apiVersion: '1.0',
    daemonVersion: '0.5.0',
  });
  assert.strictEqual(ctx.apiVersion, '1.0');
  assert.strictEqual(ctx.daemonVersion, '0.5.0');
  assert.strictEqual(ctx.pluginId, 'com.test');
  assert.strictEqual(ctx.pluginVersion, '2.0.0');
});

// ── PluginLifecycleManager ────────────────────────────────────────────

test('PluginLifecycleManager requires config', () => {
  assert.throws(() => new sdk.PluginLifecycleManager({}), TypeError);
});

test('PluginLifecycleManager loads valid plugin', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(),
    apiVersion: '1.0',
    daemonVersion: '0.5.0',
    providers: makeProviders(),
  });
  const result = mgr.loadPlugin({
    id: 'com.test.plugin', name: 'Test', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0',
    permissions: ['read:config'], entryPoint: './index.js',
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.id, 'com.test.plugin');
  assert.strictEqual(mgr.size, 1);
});

test('PluginLifecycleManager rejects invalid manifest', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const result = mgr.loadPlugin({ id: 'bad' });
  assert.strictEqual(result.success, false);
});

test('PluginLifecycleManager rejects API version mismatch', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const result = mgr.loadPlugin({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '2.0', entryPoint: './i.js',
  });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('major version mismatch'));
});

test('PluginLifecycleManager rejects daemon version below minimum', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.4.0', providers: {},
  });
  const result = mgr.loadPlugin({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('daemon version'));
});

test('PluginLifecycleManager rejects duplicate plugin', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const def = {
    id: 'com.dup', name: 'Dup', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  };
  mgr.loadPlugin(def);
  const result = mgr.loadPlugin(def);
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('already loaded'));
});

test('PluginLifecycleManager rejects unresolved dependency', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const result = mgr.loadPlugin({
    id: 'com.dep', name: 'Dep', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
    dependencies: ['com.missing'],
  });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('unresolved dependency'));
});

test('PluginLifecycleManager loads dependency first', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  mgr.loadPlugin({
    id: 'com.base', name: 'Base', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  const result = mgr.loadPlugin({
    id: 'com.child', name: 'Child', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
    dependencies: ['com.base'],
  });
  assert.strictEqual(result.success, true);
});

test('PluginLifecycleManager unloadPlugin removes plugin', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  mgr.loadPlugin({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  assert.strictEqual(mgr.unloadPlugin('com.test'), true);
  assert.strictEqual(mgr.size, 0);
});

test('PluginLifecycleManager disablePlugin disables context', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: makeProviders(),
  });
  mgr.loadPlugin({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0',
    permissions: ['read:config'], entryPoint: './i.js',
  });
  mgr.disablePlugin('com.test', 'test reason');
  const ctx = mgr.getContext('com.test');
  assert.strictEqual(ctx.isDisabled, true);
  assert.strictEqual(mgr.disabledCount, 1);
});

test('PluginLifecycleManager getStatus returns snapshot', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  mgr.loadPlugin({
    id: 'com.test', name: 'T', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  const status = mgr.getStatus();
  assert.strictEqual(status.apiVersion, '1.0');
  assert.strictEqual(status.pluginCount, 1);
  assert.ok(status.plugins.length >= 1);
  assert.strictEqual(status.plugins[0].id, 'com.test');
});

test('PluginLifecycleManager destroy unloads all', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  mgr.loadPlugin({ id: 'com.a', name: 'A', version: '1.0.0', minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js' });
  mgr.loadPlugin({ id: 'com.b', name: 'B', version: '1.0.0', minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js' });
  mgr.destroy();
  assert.strictEqual(mgr.size, 0);
});

test('PluginLifecycleManager loadFromDirectory rejects missing manifest', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const result = mgr.loadFromDirectory('/nonexistent');
  assert.strictEqual(result.success, false);
});

test('PluginLifecycleManager loadFromDirectory rejects path traversal', () => {
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const result = mgr.loadFromDirectory('../../../etc');
  assert.strictEqual(result.success, false);
});

test('PluginLifecycleManager loadFromDirectory loads from temp dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-test-'));
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
    id: 'com.test.dir', name: 'Dir Test', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './index.js',
  }));
  fs.writeFileSync(path.join(tmpDir, 'index.js'), `
    module.exports = { activate() {}, deactivate() {} };
  `);
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: makeProviders(),
  });
  const result = mgr.loadFromDirectory(tmpDir);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.id, 'com.test.dir');
  mgr.destroy();
  fs.unlinkSync(path.join(tmpDir, 'manifest.json'));
  fs.unlinkSync(path.join(tmpDir, 'index.js'));
  fs.rmdirSync(tmpDir);
});

// ── Error isolation ───────────────────────────────────────────────────

test('PluginLifecycleManager isolates activation errors', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-err-'));
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
    id: 'com.crash', name: 'Crash', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './index.js',
  }));
  fs.writeFileSync(path.join(tmpDir, 'index.js'), `
    module.exports = { activate() { throw new Error('boom!'); } };
  `);
  const mgr = new sdk.PluginLifecycleManager({
    config: makeConfig(), apiVersion: '1.0', daemonVersion: '0.5.0', providers: makeProviders(),
  });
  const result = mgr.loadFromDirectory(tmpDir);
  // Load succeeds (manifest valid), but activation fails → plugin disabled
  assert.strictEqual(result.success, true);
  const ctx = mgr.getContext('com.crash');
  assert.strictEqual(ctx.isDisabled, true);
  assert.strictEqual(mgr.disabledCount, 1);
  // Manager is still usable
  assert.strictEqual(mgr.size, 1);
  mgr.destroy();
  fs.unlinkSync(path.join(tmpDir, 'manifest.json'));
  fs.unlinkSync(path.join(tmpDir, 'index.js'));
  fs.rmdirSync(tmpDir);
});

// ── Public API ────────────────────────────────────────────────────────

test('sdk/index.js exports all expected names', () => {
  assert.strictEqual(typeof sdk.PluginLifecycleManager, 'function');
  assert.strictEqual(typeof sdk.PluginContext, 'function');
  assert.strictEqual(typeof sdk.validateManifest, 'function');
  assert.strictEqual(typeof sdk.ALL_PERMISSIONS, 'object');
  assert.strictEqual(typeof sdk.checkApiCompatibility, 'function');
  assert.strictEqual(sdk.API_VERSION, '1.0');
});

// ── No syscalls ───────────────────────────────────────────────────────

test('sdk modules never call exec/execFile/spawn', () => {
  const dir = path.join(__dirname, '..', '..', 'sdk');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src), `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

test('sdk modules use no setInterval', () => {
  const dir = path.join(__dirname, '..', '..', 'sdk');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/setInterval\(/.test(src), `${f}: must NOT use setInterval`);
  }
});
