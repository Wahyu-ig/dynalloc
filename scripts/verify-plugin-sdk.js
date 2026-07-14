'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  \u2714 ${name}`); pass++; }
  catch (err) { console.log(`  \u2718 ${name}: ${err.message}`); fail++; }
}

console.log('Plugin SDK Safety & Architecture Validation');
console.log('='.repeat(60));

const SDK_DIR = path.join(__dirname, '..', 'sdk');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// 1. Module structure
test('sdk/plugin-permissions.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-permissions.js'))); });
test('sdk/plugin-manifest.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-manifest.js'))); });
test('sdk/plugin-version.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-version.js'))); });
test('sdk/plugin-context.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-context.js'))); });
test('sdk/plugin-lifecycle-manager.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-lifecycle-manager.js'))); });
test('sdk/index.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'index.js'))); });
test('sdk/plugin-template.js exists', () => { assert.ok(fs.existsSync(path.join(SDK_DIR, 'plugin-template.js'))); });
test('sdk/index.js exports documented API', () => {
  const idx = require(SDK_DIR);
  for (const n of ['PluginLifecycleManager','PluginContext','validateManifest','ALL_PERMISSIONS','checkApiCompatibility','API_VERSION']) {
    assert.ok(idx[n] !== undefined, `must export ${n}`);
  }
});

// 2. No syscalls
test('sdk modules never call exec/execFile/spawn', () => {
  const files = fs.readdirSync(SDK_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(SDK_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src), `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

// 3. No polling
test('sdk modules use no setInterval', () => {
  const files = fs.readdirSync(SDK_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(SDK_DIR, f), 'utf8');
    assert.ok(!/setInterval\(/.test(src), `${f}: must NOT use setInterval`);
  }
});

// 4. Backward compatibility
test('config.js has ENABLE_PLUGIN_SDK defaulting to false', () => {
  assert.ok(/ENABLE_PLUGIN_SDK:\s*false/.test(CONFIG_SRC));
});
test('config.js has PLUGIN_SDK_API_VERSION', () => {
  assert.ok(/PLUGIN_SDK_API_VERSION:\s*['"]1\.0['"]/.test(CONFIG_SRC));
});
test('config.js has schema entries', () => {
  for (const k of ['ENABLE_PLUGIN_SDK','PLUGIN_SDK_API_VERSION','PLUGIN_SDK_STRICT_PERMISSIONS','PLUGIN_SDK_DIR']) {
    assert.ok(CONFIG_SRC.includes(`${k}:`), `schema must have ${k}`);
  }
});
test('all keys in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const k of ['ENABLE_PLUGIN_SDK','PLUGIN_SDK_API_VERSION','PLUGIN_SDK_STRICT_PERMISSIONS','PLUGIN_SDK_DIR']) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(k), `${k} must be hot-reloadable`);
  }
});

// 5. Daemon integration
test('daemon.js gates SDK behind ENABLE_PLUGIN_SDK', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_PLUGIN_SDK\)/.test(DAEMON_SRC));
});
test('daemon.js requires ./sdk lazily', () => {
  assert.ok(/require\(['"]\.\/sdk['"]\)/.test(DAEMON_SRC));
});
test('daemon.js calls pluginSdkManager.destroy in cleanup', () => {
  assert.ok(/pluginSdkManager\.destroy\(\)/.test(DAEMON_SRC));
});
test('daemon.js registers IPC sdk handler', () => {
  assert.ok(/registerHandler\(['"]sdk['"]/.test(DAEMON_SRC));
});
test('daemon.js exposes pluginSdk in getState()', () => {
  assert.ok(/pluginSdk:\s*pluginSdkManager/.test(DAEMON_SRC));
});
test('daemon.js declares pluginSdkManager state variable', () => {
  assert.ok(/let\s+pluginSdkManager\s*=\s*null/.test(DAEMON_SRC));
});

// 6. Permission enforcement
test('PluginContext checks permissions', () => {
  const src = fs.readFileSync(path.join(SDK_DIR, 'plugin-context.js'), 'utf8');
  assert.ok(/_requirePermission/.test(src), 'must have _requirePermission()');
  assert.ok(/hasPermission/.test(src), 'must call hasPermission()');
});

// 7. Error isolation
test('PluginLifecycleManager wraps activation in try/catch', () => {
  const src = fs.readFileSync(path.join(SDK_DIR, 'plugin-lifecycle-manager.js'), 'utf8');
  assert.ok(/_activate[\s\S]*?try\s*\{[\s\S]*?catch/.test(src), 'must have try/catch in _activate()');
});
test('PluginLifecycleManager has disablePlugin method', () => {
  const src = fs.readFileSync(path.join(SDK_DIR, 'plugin-lifecycle-manager.js'), 'utf8');
  assert.ok(/disablePlugin\(/.test(src), 'must have disablePlugin()');
});

// 8. Manifest validation
test('manifest validation rejects missing required fields', () => {
  const { validateManifest } = require(SDK_DIR);
  const r = validateManifest({});
  assert.strictEqual(r.valid, false);
});

// 9. Behavioral smoke test
test('PluginLifecycleManager boots without errors', () => {
  const { PluginLifecycleManager } = require(SDK_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const mgr = new PluginLifecycleManager({
    config: { ...DEFAULT_CONFIG, DRY_RUN: true },
    apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  assert.strictEqual(mgr.size, 0);
  mgr.destroy();
});

test('PluginLifecycleManager loads + unloads plugin', () => {
  const { PluginLifecycleManager } = require(SDK_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const mgr = new PluginLifecycleManager({
    config: { ...DEFAULT_CONFIG, DRY_RUN: true },
    apiVersion: '1.0', daemonVersion: '0.5.0', providers: {},
  });
  const r = mgr.loadPlugin({
    id: 'com.test', name: 'Test', version: '1.0.0',
    minDynallocVersion: '0.5.0', apiVersion: '1.0', entryPoint: './i.js',
  });
  assert.strictEqual(r.success, true);
  assert.strictEqual(mgr.size, 1);
  mgr.unloadPlugin('com.test');
  assert.strictEqual(mgr.size, 0);
  mgr.destroy();
});

// 10. Test file exists
test('test/unit/test-plugin-sdk.js exists', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'test', 'unit', 'test-plugin-sdk.js')));
});

console.log('='.repeat(60));
console.log(`  Plugin SDK safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));
if (fail > 0) { console.error('\nFAIL: Plugin SDK safety regression detected.'); process.exit(1); }
process.exit(0);
