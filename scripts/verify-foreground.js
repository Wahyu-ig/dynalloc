'use strict';

/**
 * Regression tests for v2.1.4 universal foreground detection.
 *
 * Tests cover:
 *   - _detectSession() correctly identifies Hyprland/Sway/KDE/GNOME/X11
 *   - _swayFindFocusedPid() correctly walks a sway tree
 *   - getForegroundPID() returns null gracefully when no detector works
 *   - _detectFocusMethod() (in daemon.js) returns correct method strings
 *
 * Run with: node scripts/verify-foreground.js
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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Verifying v2.1.4 universal foreground detection...\n');

// ── Fix #23: _detectSession() identifies all supported desktop environments ─

test('Fix #23a: _detectSession() identifies Hyprland', () => {
  // Save env, modify, restore
  const orig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  process.env.HYPRLAND_INSTANCE_SIGNATURE = 'test-1234';
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isHyprland, 'isHyprland should be true');
  } finally {
    if (orig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    else process.env.HYPRLAND_INSTANCE_SIGNATURE = orig;
    delete require.cache[require.resolve('../sensor')];
  }
});

test('Fix #23b: _detectSession() identifies Sway via SWAYSOCK', () => {
  const orig = process.env.SWAYSOCK;
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  process.env.SWAYSOCK = '/run/user/1000/sway-ipc.sock';
  delete process.env.XDG_CURRENT_DESKTOP;
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isSway, 'isSway should be true when SWAYSOCK is set');
  } finally {
    if (orig === undefined) delete process.env.SWAYSOCK;
    else process.env.SWAYSOCK = orig;
    if (origDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = origDesktop;
    delete require.cache[require.resolve('../sensor')];
  }
});

test('Fix #23c: _detectSession() identifies Sway via XDG_CURRENT_DESKTOP', () => {
  const orig = process.env.SWAYSOCK;
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  delete process.env.SWAYSOCK;
  process.env.XDG_CURRENT_DESKTOP = 'sway';
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isSway, 'isSway should be true when XDG_CURRENT_DESKTOP=sway');
  } finally {
    if (orig === undefined) delete process.env.SWAYSOCK;
    else process.env.SWAYSOCK = orig;
    if (origDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = origDesktop;
    delete require.cache[require.resolve('../sensor')];
  }
});

test('Fix #23d: _detectSession() identifies KDE/Wayland', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  process.env.XDG_CURRENT_DESKTOP = 'KDE';
  process.env.XDG_SESSION_TYPE = 'wayland';
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isKde, 'isKde should be true');
    assert.ok(s.isWayland, 'isWayland should be true');
  } finally {
    if (origDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = origDesktop;
    if (origSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = origSession;
    delete require.cache[require.resolve('../sensor')];
  }
});

test('Fix #23e: _detectSession() identifies GNOME/Wayland', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  process.env.XDG_CURRENT_DESKTOP = 'GNOME';
  process.env.XDG_SESSION_TYPE = 'wayland';
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isGnome, 'isGnome should be true');
    assert.ok(s.isWayland, 'isWayland should be true');
  } finally {
    if (origDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = origDesktop;
    if (origSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = origSession;
    delete require.cache[require.resolve('../sensor')];
  }
});

test('Fix #23f: _detectSession() identifies X11 session', () => {
  const origSession = process.env.XDG_SESSION_TYPE;
  const origWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = 'x11';
  try {
    delete require.cache[require.resolve('../sensor')];
    const { _detectSession } = require('../sensor');
    const s = _detectSession();
    assert.ok(s.isX11, 'isX11 should be true');
    assert.ok(!s.isWayland, 'isWayland should be false');
  } finally {
    if (origSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = origSession;
    if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
    delete require.cache[require.resolve('../sensor')];
  }
});

// ── Fix #24: _swayFindFocusedPid() walks a sway tree correctly ────────────

test('Fix #24a: _swayFindFocusedPid() finds the focused window PID in a nested tree', () => {
  delete require.cache[require.resolve('../sensor')];
  const { _swayFindFocusedPid } = require('../sensor');

  // Simulated sway tree structure
  const tree = {
    id: 1,
    name: 'root',
    type: 'root',
    focus: [2],
    nodes: [
      {
        id: 2,
        name: 'workspace 1',
        type: 'workspace',
        focus: [3, 4],
        nodes: [
          {
            id: 3,
            name: 'firefox',
            type: 'con',
            focused: true,
            pid: 12345,
          },
          {
            id: 4,
            name: 'terminal',
            type: 'con',
            focused: false,
            pid: 12346,
          },
        ],
      },
    ],
  };

  const pid = _swayFindFocusedPid(tree);
  assert.strictEqual(pid, 12345, `expected pid 12345 (firefox), got ${pid}`);
});

test('Fix #24b: _swayFindFocusedPid() finds focused window in floating_nodes', () => {
  delete require.cache[require.resolve('../sensor')];
  const { _swayFindFocusedPid } = require('../sensor');

  const tree = {
    id: 1,
    type: 'root',
    focus: [2],
    nodes: [
      {
        id: 2,
        type: 'workspace',
        focus: [],
        nodes: [],
        floating_nodes: [
          {
            id: 5,
            name: 'popup',
            type: 'floating_con',
            focused: true,
            pid: 54321,
          },
        ],
      },
    ],
  };

  const pid = _swayFindFocusedPid(tree);
  assert.strictEqual(pid, 54321, `expected pid 54321 (floating popup), got ${pid}`);
});

test('Fix #24c: _swayFindFocusedPid() returns null when no window is focused', () => {
  delete require.cache[require.resolve('../sensor')];
  const { _swayFindFocusedPid } = require('../sensor');

  const tree = {
    id: 1,
    type: 'root',
    focus: [],
    nodes: [
      {
        id: 2,
        type: 'workspace',
        focus: [],
        nodes: [
          { id: 3, name: 'a', focused: false, pid: 100 },
          { id: 4, name: 'b', focused: false, pid: 101 },
        ],
      },
    ],
  };

  const pid = _swayFindFocusedPid(tree);
  assert.strictEqual(pid, null, 'expected null when nothing is focused');
});

test('Fix #24d: _swayFindFocusedPid() handles empty/malformed tree gracefully', () => {
  delete require.cache[require.resolve('../sensor')];
  const { _swayFindFocusedPid } = require('../sensor');

  assert.strictEqual(_swayFindFocusedPid(null), null);
  assert.strictEqual(_swayFindFocusedPid(undefined), null);
  assert.strictEqual(_swayFindFocusedPid({}), null);
  assert.strictEqual(_swayFindFocusedPid({ nodes: 'not-an-array' }), null);
});

test('Fix #24e: _swayFindNodeById() finds a node by id recursively', () => {
  delete require.cache[require.resolve('../sensor')];
  const { _swayFindNodeById } = require('../sensor');

  const tree = {
    id: 1,
    nodes: [
      { id: 2, nodes: [] },
      { id: 3, nodes: [{ id: 4, nodes: [] }] },
    ],
  };

  const found = _swayFindNodeById(tree, 4);
  assert.ok(found, 'should find node id=4');
  assert.strictEqual(found.id, 4);

  const notFound = _swayFindNodeById(tree, 999);
  assert.strictEqual(notFound, null, 'should return null for non-existent id');
});

// ── Fix #25: getForegroundPID() returns null gracefully when no detector works ─

testAsync('Fix #25: getForegroundPID() returns null when all detectors fail', async () => {
  // In a CI/test environment without any real desktop, all detectors
  // should fail and the function should resolve to null.
  // We restore env to a clean state.
  const origEnv = { ...process.env };
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  delete process.env.SWAYSOCK;
  process.env.XDG_CURRENT_DESKTOP = '';
  process.env.XDG_SESSION_TYPE = '';

  try {
    delete require.cache[require.resolve('../sensor')];
    const { getForegroundPID } = require('../sensor');
    const pid = await getForegroundPID();
    // In a test env, no desktop detection will match → all detectors fail → null
    // (xdotool will fail because there's no X display)
    assert.strictEqual(pid, null, `expected null when no detector works, got ${pid}`);
  } finally {
    process.env = origEnv;
    delete require.cache[require.resolve('../sensor')];
  }
});

// ── Fix #26: daemon._detectFocusMethod() returns correct method strings ────

test('Fix #26a: _detectFocusMethod() returns "hyprctl" for Hyprland session', () => {
  // Read daemon.js source and verify the function exists with correct logic
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('function _detectFocusMethod()'),
    '_detectFocusMethod() function missing in daemon.js');
  // Verify it handles Hyprland
  assert.ok(/HYPRLAND_INSTANCE_SIGNATURE[\s\S]*?hyprctl/.test(src),
    '_detectFocusMethod should mention hyprctl for Hyprland');
  // Verify it handles Sway
  assert.ok(/SWAYSOCK[\s\S]*?swaymsg/.test(src),
    '_detectFocusMethod should mention swaymsg for Sway');
  // Verify it handles KDE/Wayland
  assert.ok(/kde.*wayland[\s\S]*?KWin/i.test(src),
    '_detectFocusMethod should mention KWin for KDE/Wayland');
});

test('Fix #26b: _detectFocusMethod() covers all session types in source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  const fnMatch = src.match(/function _detectFocusMethod\(\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(fnMatch, '_detectFocusMethod not found');
  const body = fnMatch[1];
  // Must mention all 5 session types
  assert.ok(body.includes('HYPRLAND'), 'should detect Hyprland');
  assert.ok(body.includes('SWAYSOCK'), 'should detect Sway');
  assert.ok(body.includes('kde'), 'should detect KDE');
  assert.ok(body.includes('gnome'), 'should detect GNOME');
  assert.ok(body.includes('xdotool'), 'should have xdotool fallback');
});

// ── Fix #27: self-check.js reports new session types + foreground tools ────

test('Fix #27a: self-check reports Sway and KDE/Wayland', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('function checkSway()'),
    'checkSway() function missing');
  assert.ok(src.includes('function checkKdeWayland()'),
    'checkKdeWayland() function missing');
  assert.ok(src.includes('function checkForegroundTool()'),
    'checkForegroundTool() function missing');
  // Should report sway and kdeWayland in the report object
  assert.ok(src.includes('sway: checkSway()'),
    'sway field missing in report');
  assert.ok(src.includes('kdeWayland: checkKdeWayland()'),
    'kdeWayland field missing in report');
  assert.ok(src.includes('foregroundTool: checkForegroundTool()'),
    'foregroundTool field missing in report');
});

test('Fix #27b: self-check printReport shows new session types', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(src.includes('Sway:'),
    'printReport should show Sway status');
  assert.ok(src.includes('KDE/Wayland:'),
    'printReport should show KDE/Wayland status');
  assert.ok(src.includes('Foreground tools:'),
    'printReport should show available foreground tools');
});

// ── Fix #28: CLI doctor shows new session types and foreground tools ────────

test('Fix #28a: CLI doctor lists Sway and KDE/Wayland checks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  assert.ok(src.includes("['Sway', report.sway]"),
    'doctor should check Sway');
  assert.ok(src.includes("['KDE/Wayland', report.kdeWayland]"),
    'doctor should check KDE/Wayland');
});

test('Fix #28b: CLI doctor shows foreground tools section', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  assert.ok(src.includes('Foreground tools:'),
    'doctor should show Foreground tools section');
  // Should list each tool with description
  assert.ok(src.includes('Hyprland IPC'),
    'doctor should describe hyprctl');
  assert.ok(src.includes('Sway IPC'),
    'doctor should describe swaymsg');
  assert.ok(src.includes('KDE KWin DBus'),
    'doctor should describe qdbus');
});

test('Fix #28c: CLI doctor diagnostics warn about missing foreground tools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  // Should suggest installing hyprctl when Hyprland detected but tool missing
  assert.ok(/report.hyprland && !ft.hyprctl/.test(src),
    'doctor should warn when hyprctl missing on Hyprland');
  // Should suggest swaymsg
  assert.ok(/report.sway && !ft.swaymsg/.test(src),
    'doctor should warn when swaymsg missing on Sway');
  // Should suggest qdbus or kdotool for KDE
  assert.ok(/report.kdeWayland && !ft.qdbus && !ft.kdotool/.test(src),
    'doctor should warn when qdbus+kdotool missing on KDE/Wayland');
});

// ── Fix #29: sensor.js exports new helper functions for testing ────────────

test('Fix #29: sensor.js exports _detectSession, _swayFindFocusedPid, _swayFindNodeById', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(typeof sensor._detectSession, 'function',
    '_detectSession should be exported');
  assert.strictEqual(typeof sensor._swayFindFocusedPid, 'function',
    '_swayFindFocusedPid should be exported');
  assert.strictEqual(typeof sensor._swayFindNodeById, 'function',
    '_swayFindNodeById should be exported');
});

// ── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Foreground detection tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
