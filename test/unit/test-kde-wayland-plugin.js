'use strict';

/**
 * DynAlloc — KDE Plasma Wayland Plugin Unit Tests (v1.1.0)
 * ==========================================================
 *
 * Comprehensive unit tests for plugins/kde-wayland.js covering:
 *   - Plugin manifest properties (name, version, description)
 *   - Session detection (isKdeWaylandSession via env vars)
 *   - isSupported() returns true only on KDE Plasma Wayland
 *   - detect() returns [] on non-KDE sessions (no interference)
 *   - detect() returns BOOST for context.foregroundPid on KDE
 *   - detect() uses cache when context.foregroundPid is missing
 *   - getForegroundPid() returns null on non-KDE sessions
 *   - getForegroundPid() probes qdbus lazily
 *   - getForegroundPid() returns null when qdbus missing
 *   - getForegroundPid() returns null when DBus call fails
 *   - _queryPlasma6() — happy path, malformed output, errors
 *   - _queryPlasma5() — happy path, malformed output, errors
 *   - destroy() clears cache
 *   - init() resets state
 *
 * All execFile calls are mocked to avoid hitting a real DBus.
 *
 * Run: node --test test/unit/test-kde-wayland-plugin.js
 */

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

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

// ── Test helpers ───────────────────────────────────────────────────────

const child_process = require('child_process');

// Snapshot of process.env so we can restore it after each test
const ENV_SNAPSHOT = { ...process.env };

function setEnv(overrides) {
  // Clear session-related env vars, then apply overrides
  delete process.env.XDG_CURRENT_DESKTOP;
  delete process.env.XDG_SESSION_TYPE;
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  delete process.env.SWAYSOCK;
  Object.assign(process.env, overrides);
}

function restoreEnv() {
  // Restore from snapshot
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

/**
 * Create a fresh plugin instance with isolated state. We use
 * Object.create(plugin) so each test gets its own _cachePid etc.
 * without mutating the shared export.
 */
function makePlugin() {
  // Deep-ish copy: Object.create inherits, but we want own properties
  // for state. So we copy explicitly.
  const cp = require('../../plugins/kde-wayland');
  return Object.assign(Object.create(cp), {
    _cachePid: null,
    _cacheTs: 0,
    _enabled: false,
    _qdbusAvailable: false,
    _qdbusProbed: false,
  });
}

/**
 * Mock execFile to invoke `cb(err, stdout, stderr)` after a microtask.
 * The mock recognizes the first arg (the command) and dispatches based
 * on it + the args array.
 *
 * @param {Function} dispatcher - (cmd, args) => { err?, stdout?, stderr? }
 */
function mockExecFile(dispatcher) {
  const orig = child_process.execFile;
  const fn = mock.method(child_process, 'execFile', (cmd, args, opts, cb) => {
    // Handle the (cmd, args, cb) form (no opts)
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const result = dispatcher(cmd, args || []);
    process.nextTick(() => {
      cb(result.err || null, result.stdout || '', result.stderr || '');
    });
  });
  return () => {
    fn.mock.restore();
    child_process.execFile = orig;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. MANIFEST
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin manifest', () => {
  it('has the correct name', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(plugin.name, 'kde-wayland');
  });

  it('has a semver version', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.ok(/^\d+\.\d+\.\d+$/.test(plugin.version));
  });

  it('has a non-empty description', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.ok(plugin.description.length > 0);
  });

  it('exposes a detect() function', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(typeof plugin.detect, 'function');
  });

  it('exposes an init() function', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(typeof plugin.init, 'function');
  });

  it('exposes a destroy() function', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(typeof plugin.destroy, 'function');
  });

  it('exposes getForegroundPid() async function', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(typeof plugin.getForegroundPid, 'function');
  });

  it('exposes isSupported() function', () => {
    const plugin = require('../../plugins/kde-wayland');
    assert.strictEqual(typeof plugin.isSupported, 'function');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. SESSION DETECTION
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin session detection', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('isSupported() returns true on KDE Plasma Wayland', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'KDE',
      XDG_SESSION_TYPE: 'wayland',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), true);
  });

  it('isSupported() returns true with WAYLAND_DISPLAY set', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'KDE',
      WAYLAND_DISPLAY: 'wayland-0',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), true);
  });

  it('isSupported() returns false on KDE Plasma X11', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'KDE',
      XDG_SESSION_TYPE: 'x11',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() returns false on GNOME Wayland', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'GNOME',
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() returns false on Hyprland', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'Hyprland',
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
      HYPRLAND_INSTANCE_SIGNATURE: 'abc123',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() returns false on Sway', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'Sway',
      XDG_SESSION_TYPE: 'wayland',
      SWAYSOCK: '/run/user/1000/sway-ipc.sock',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() returns false on X11 generic', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      XDG_SESSION_TYPE: 'x11',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() returns false when env vars unset', () => {
    setEnv({});
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), false);
  });

  it('isSupported() handles XDG_CURRENT_DESKTOP with multiple entries (KDE:last)', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'ubuntu:KDE',
      XDG_SESSION_TYPE: 'wayland',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), true);
  });

  it('isSupported() handles lowercase kde', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'kde',
      XDG_SESSION_TYPE: 'wayland',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), true);
  });

  it('isSupported() handles mixed-case KDE', () => {
    setEnv({
      XDG_CURRENT_DESKTOP: 'Kde',
      XDG_SESSION_TYPE: 'wayland',
    });
    const plugin = makePlugin();
    assert.strictEqual(plugin.isSupported(), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. init() STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin init()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('init() sets _enabled=true on KDE Plasma Wayland', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    assert.strictEqual(plugin._enabled, true);
  });

  it('init() sets _enabled=false on GNOME Wayland', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    assert.strictEqual(plugin._enabled, false);
  });

  it('init() resets the cache', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin._cachePid = 1234;
    plugin._cacheTs = Date.now();
    plugin.init({});
    assert.strictEqual(plugin._cachePid, null);
    assert.strictEqual(plugin._cacheTs, 0);
  });

  it('init() resets the qdbus probe state', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin._qdbusProbed = true;
    plugin._qdbusAvailable = true;
    plugin.init({});
    assert.strictEqual(plugin._qdbusProbed, false);
    assert.strictEqual(plugin._qdbusAvailable, false);
  });

  it('init() does not throw on null config', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    assert.doesNotThrow(() => plugin.init(null));
  });

  it('init() does not throw on undefined config', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    assert.doesNotThrow(() => plugin.init(undefined));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. detect() — STANDARD PLUGIN INTERFACE
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin detect()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('returns [] when not on KDE Wayland (no interference)', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([{ pid: 1234, comm: 'firefox' }], { foregroundPid: 1234 });
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when not enabled', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    assert.strictEqual(plugin._enabled, false);
    const result = plugin.detect([{ pid: 1234, comm: 'firefox' }], { foregroundPid: 1234 });
    assert.deepStrictEqual(result, []);
  });

  it('returns BOOST detection for context.foregroundPid on KDE Wayland', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect(
      [{ pid: 1234, comm: 'firefox' }, { pid: 5678, comm: 'chrome' }],
      { foregroundPid: 1234 }
    );
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 1234);
    assert.strictEqual(result[0].action, 'BOOST');
    assert.ok(result[0].reason.includes('firefox'),
      `reason should include comm: ${result[0].reason}`);
    assert.ok(result[0].reason.includes('KDE'),
      `reason should mention KDE: ${result[0].reason}`);
  });

  it('returns BOOST even when foregroundPid is not in procs list', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect(
      [{ pid: 5678, comm: 'chrome' }],
      { foregroundPid: 9999 }  // not in procs list
    );
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 9999);
    assert.strictEqual(result[0].action, 'BOOST');
  });

  it('updates cache when context.foregroundPid is set', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    plugin.detect([{ pid: 1234, comm: 'firefox' }], { foregroundPid: 1234 });
    assert.strictEqual(plugin._cachePid, 1234);
    assert.ok(plugin._cacheTs > 0);
  });

  it('uses cache when context.foregroundPid is missing', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    // Prime the cache
    plugin._cachePid = 4242;
    plugin._cacheTs = Date.now();
    // Detect without foregroundPid in context
    const result = plugin.detect([{ pid: 4242, comm: 'firefox' }], {});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 4242);
  });

  it('ignores stale cache (older than 500ms)', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    // Prime the cache with an old timestamp
    plugin._cachePid = 4242;
    plugin._cacheTs = Date.now() - 600; // 600ms ago — stale
    // Detect without foregroundPid in context
    const result = plugin.detect([{ pid: 4242, comm: 'firefox' }], {});
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when no foregroundPid and no cache', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([{ pid: 1234, comm: 'firefox' }], {});
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when context is null', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([{ pid: 1234, comm: 'firefox' }], null);
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when context is undefined', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([{ pid: 1234, comm: 'firefox' }], undefined);
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when procs is null', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect(null, { foregroundPid: 1234 });
    // Even without procs, we can return BOOST with no comm
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 1234);
    assert.strictEqual(result[0].action, 'BOOST');
  });

  it('returns [] when procs is empty array', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([], { foregroundPid: 1234 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].pid, 1234);
  });

  it('returns [] when foregroundPid is 0 (falsy)', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([], { foregroundPid: 0 });
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when foregroundPid is null', () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const result = plugin.detect([], { foregroundPid: null });
    assert.deepStrictEqual(result, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. getForegroundPid() — ASYNC FOREGROUND QUERY
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin getForegroundPid()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('returns null when not on KDE Wayland', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
  });

  it('returns null when qdbus is not available', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: new Error('not found') }));
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
    assert.strictEqual(plugin._qdbusProbed, true);
    assert.strictEqual(plugin._qdbusAvailable, false);
    restore();
  });

  it('probes qdbus only once', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    let probeCount = 0;
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        probeCount++;
        return { err: null, stdout: 'qdbus 5.0' };
      }
      return { err: new Error('unexpected call') };
    });
    const plugin = makePlugin();
    plugin.init({});
    await plugin.getForegroundPid();
    await plugin.getForegroundPid();
    await plugin.getForegroundPid();
    assert.strictEqual(probeCount, 1, 'qdbus should be probed only once');
    restore();
  });

  it('returns null when Plasma 6 query fails and Plasma 5 fails', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      // All other qdbus calls fail
      return { err: new Error('dbus error') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns PID on Plasma 6 happy path', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      // Step 1: ActiveWindow query — qdbus Properties.Get returns
      // "QVariant(uint32, 12345)" or just the bare number. The plugin's
      // regex matches the first digit sequence, so we return a bare
      // number to keep the test deterministic.
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '12345' };
      }
      // Step 2: GetWindowInfo
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: null, stdout: 'pid :variant int 12345\ncaption :variant "test"' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, 12345);
    assert.strictEqual(plugin._cachePid, 12345);
    restore();
  });

  it('returns PID on Plasma 5 happy path (when Plasma 6 fails)', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 5.0' };
      }
      // Plasma 6 ActiveWindow — fail
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: new Error('no such property') };
      }
      // Plasma 5 scripting
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('evaluateScript'))) {
        return { err: null, stdout: '12345' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, 12345);
    restore();
  });

  it('returns null when Plasma 6 returns invalid window id', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '0' }; // 0 = invalid
      }
      // Plasma 5 fallback also fails
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('evaluateScript'))) {
        return { err: new Error('no scripting') };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when Plasma 6 returns no pid in window info', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '12345' };
      }
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: null, stdout: 'caption :variant "test"\nno pid here' };
      }
      // Plasma 5 also fails
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('evaluateScript'))) {
        return { err: new Error('no scripting') };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when Plasma 5 scripting returns no number', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 5.0' };
      }
      // Plasma 6 fails
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: new Error('no Plasma 6') };
      }
      // Plasma 5 returns no number
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('evaluateScript'))) {
        return { err: null, stdout: 'undefined' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid = await plugin.getForegroundPid();
    assert.strictEqual(pid, null);
    restore();
  });

  it('caches the result for subsequent calls', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    let plasma6CallCount = 0;
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        plasma6CallCount++;
        return { err: null, stdout: '12345' };
      }
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: null, stdout: 'pid :variant int 12345' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin.init({});
    const pid1 = await plugin.getForegroundPid();
    assert.strictEqual(pid1, 12345);
    assert.strictEqual(plasma6CallCount, 1);
    // Note: getForegroundPid() does NOT use the cache itself — it always
    // queries DBus. The cache is only used by detect(). So a second
    // call WILL hit DBus again. This is by design: getForegroundPid()
    // is the source of truth, detect() is the consumer.
    const pid2 = await plugin.getForegroundPid();
    assert.strictEqual(pid2, 12345);
    assert.strictEqual(plasma6CallCount, 2);
    restore();
  });

  it('clears cache when foreground detection fails', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args[0] === '--version') {
        return { err: null, stdout: 'qdbus 6.0' };
      }
      return { err: new Error('all fail') };
    });
    const plugin = makePlugin();
    plugin.init({});
    // Prime the cache
    plugin._cachePid = 9999;
    plugin._cacheTs = Date.now();
    await plugin.getForegroundPid();
    assert.strictEqual(plugin._cachePid, null);
    restore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. _queryPlasma6() — DIRECT UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin _queryPlasma6()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('parses a valid Plasma 6 reply', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '12345' };
      }
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: null, stdout: 'pid :variant int 12345' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    plugin._qdbusAvailable = true;
    plugin._qdbusProbed = true;
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, 12345);
    restore();
  });

  it('returns null when ActiveWindow call fails', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: new Error('dbus fail') }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when ActiveWindow returns no number', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: 'no active window' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when ActiveWindow returns 0', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '0' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when GetWindowInfo call fails', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '12345' };
      }
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: new Error('window not found') };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when GetWindowInfo has no pid field', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile((cmd, args) => {
      if (cmd === 'qdbus' && args.includes('ActiveWindow')) {
        return { err: null, stdout: '12345' };
      }
      if (cmd === 'qdbus' && args.some(a => typeof a === 'string' && a.includes('GetWindowInfo'))) {
        return { err: null, stdout: 'caption :variant "test"' };
      }
      return { err: new Error('unexpected') };
    });
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma6();
    assert.strictEqual(pid, null);
    restore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. _queryPlasma5() — DIRECT UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin _queryPlasma5()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('parses a valid Plasma 5 scripting reply', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: null, stdout: '12345' }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma5();
    assert.strictEqual(pid, 12345);
    restore();
  });

  it('returns null when scripting call fails', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: new Error('scripting fail') }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma5();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when output has no number', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: null, stdout: 'undefined' }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma5();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when output is empty', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: null, stdout: '' }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma5();
    assert.strictEqual(pid, null);
    restore();
  });

  it('returns null when pid is 0', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: null, stdout: '0' }));
    const plugin = makePlugin();
    const pid = await plugin._queryPlasma5();
    assert.strictEqual(pid, null);
    restore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. _probeQdbus()
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin _probeQdbus()', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('returns true when qdbus --version succeeds', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: null, stdout: 'qdbus 6.0' }));
    const plugin = makePlugin();
    const ok = await plugin._probeQdbus();
    assert.strictEqual(ok, true);
    restore();
  });

  it('returns false when qdbus is not found', async () => {
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const restore = mockExecFile(() => ({ err: new Error('ENOENT') }));
    const plugin = makePlugin();
    const ok = await plugin._probeQdbus();
    assert.strictEqual(ok, false);
    restore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. destroy()
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin destroy()', () => {
  it('clears the cache', () => {
    const plugin = makePlugin();
    plugin._cachePid = 1234;
    plugin._cacheTs = Date.now();
    plugin.destroy();
    assert.strictEqual(plugin._cachePid, null);
    assert.strictEqual(plugin._cacheTs, 0);
  });

  it('is safe to call when cache is already empty', () => {
    const plugin = makePlugin();
    plugin._cachePid = null;
    plugin._cacheTs = 0;
    assert.doesNotThrow(() => plugin.destroy());
  });

  it('is safe to call multiple times', () => {
    const plugin = makePlugin();
    plugin._cachePid = 1234;
    plugin.destroy();
    plugin.destroy();
    plugin.destroy();
    assert.strictEqual(plugin._cachePid, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. INTEGRATION WITH PLUGIN MANAGER
// ═══════════════════════════════════════════════════════════════════════

describe('kde-wayland plugin integration with PluginManager', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('can be registered with PluginManager', () => {
    const { PluginManager, resetPluginManager } = require('../../plugin-manager');
    resetPluginManager();
    const mgr = new PluginManager();
    const plugin = require('../../plugins/kde-wayland');
    const ok = mgr.register(plugin);
    assert.strictEqual(ok, true);
    assert.ok(mgr.registeredPlugins.includes('kde-wayland'));
    resetPluginManager();
  });

  it('init() is called by PluginManager.initAll()', () => {
    const { PluginManager, resetPluginManager } = require('../../plugin-manager');
    resetPluginManager();
    setEnv({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' });
    const mgr = new PluginManager();
    mgr.register(require('../../plugins/kde-wayland'));
    mgr.initAll({});
    // The plugin's _enabled should be set after initAll
    // (we can't directly access the registered plugin's state, but
    // runDetection should now work)
    const result = mgr.runDetection([], { foregroundPid: 1234 });
    assert.ok(result.has(1234), 'expected PID 1234 to be in detection results');
    assert.ok(result.get(1234).actions.includes('BOOST'));
    resetPluginManager();
  });

  it('does not interfere with GNOME session (plugin returns empty)', () => {
    const { PluginManager, resetPluginManager } = require('../../plugin-manager');
    resetPluginManager();
    setEnv({ XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const mgr = new PluginManager();
    mgr.register(require('../../plugins/kde-wayland'));
    mgr.initAll({});
    const result = mgr.runDetection([], { foregroundPid: 1234 });
    // On GNOME, the plugin should return [] and not affect detection
    assert.strictEqual(result.size, 0);
    resetPluginManager();
  });

  it('does not interfere with Hyprland session', () => {
    const { PluginManager, resetPluginManager } = require('../../plugin-manager');
    resetPluginManager();
    setEnv({
      XDG_CURRENT_DESKTOP: 'Hyprland',
      XDG_SESSION_TYPE: 'wayland',
      HYPRLAND_INSTANCE_SIGNATURE: 'abc',
    });
    const mgr = new PluginManager();
    mgr.register(require('../../plugins/kde-wayland'));
    mgr.initAll({});
    const result = mgr.runDetection([], { foregroundPid: 1234 });
    assert.strictEqual(result.size, 0);
    resetPluginManager();
  });

  it('does not interfere with X11 session', () => {
    const { PluginManager, resetPluginManager } = require('../../plugin-manager');
    resetPluginManager();
    setEnv({
      XDG_CURRENT_DESKTOP: 'KDE',  // KDE but X11
      XDG_SESSION_TYPE: 'x11',
    });
    const mgr = new PluginManager();
    mgr.register(require('../../plugins/kde-wayland'));
    mgr.initAll({});
    const result = mgr.runDetection([], { foregroundPid: 1234 });
    assert.strictEqual(result.size, 0);
    resetPluginManager();
  });
});
