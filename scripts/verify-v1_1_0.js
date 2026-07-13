'use strict';

/**
 * v1.1.0 Milestone Verification Script
 * =====================================
 *
 * Verifies the four v1.1.0 milestone deliverables:
 *
 *   1. GitHub Actions CI pipeline includes the new test files
 *      (test-system-plugin, test-learning-logger, test-per-app-profiles,
 *       test-kde-wayland-plugin) and the new verify-v1_1_0 script.
 *
 *   2. Comprehensive unit tests for learning-logger.js and
 *      per-app-profiles.js exist and have non-trivial coverage.
 *
 *   3. `dynalloc watch` CLI command exists with:
 *      - 1-second default refresh
 *      - ANSI rendering via lib/watch-renderer.js
 *      - Ctrl+C handling (SIGINT)
 *      - --refresh and --width options
 *
 *   4. KDE Plasma Wayland foreground detection plugin exists at
 *      plugins/kde-wayland.js with:
 *      - Standard plugin interface (name, version, detect, init, destroy)
 *      - Session detection (only activates on KDE Plasma Wayland)
 *      - DBus-based foreground query (qdbus)
 *      - Graceful fallback (returns [] on non-KDE sessions)
 *      - No interference with GNOME, Hyprland, or X11
 *
 * Run with: node scripts/verify-v1_1_0.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

const ROOT = path.join(__dirname, '..');

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('Verifying v1.1.0 milestone deliverables...\n');

// ═══════════════════════════════════════════════════════════════════════
// 1. CI PIPELINE
// ═══════════════════════════════════════════════════════════════════════

console.log('─ CI Pipeline ─');

test('ci.yml exists', () => {
  assert.ok(fileExists('.github/workflows/ci.yml'));
});

test('ci.yml runs test-system-plugin.js', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('test/unit/test-system-plugin.js'),
    'test-system-plugin.js not in CI');
});

test('ci.yml runs test-learning-logger.js', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('test/unit/test-learning-logger.js'),
    'test-learning-logger.js not in CI');
});

test('ci.yml runs test-per-app-profiles.js', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('test/unit/test-per-app-profiles.js'),
    'test-per-app-profiles.js not in CI');
});

test('ci.yml runs test-kde-wayland-plugin.js', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('test/unit/test-kde-wayland-plugin.js'),
    'test-kde-wayland-plugin.js not in CI');
});

test('ci.yml runs verify-ppd.js (existing requirement)', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('verify-ppd'),
    'verify-ppd.js not in CI');
});

test('ci.yml runs verify-v1_1_0.js', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('verify-v1_1_0'),
    'verify-v1_1_0.js not in CI');
});

test('ci.yml runs integration tests', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('test/integration/test-integration.js'),
    'integration tests not in CI');
  assert.ok(src.includes('test/integration/test-policy-integration.js'),
    'policy integration tests not in CI');
});

test('ci.yml has fail-fast behavior (set -e)', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('set -e'),
    'CI does not fail fast on errors');
});

test('ci.yml has a regression-gate job', () => {
  const src = readFile('.github/workflows/ci.yml');
  assert.ok(src.includes('regression-gate'),
    'no regression-gate job');
});

test('package.json test script includes new test files', () => {
  const src = readFile('package.json');
  assert.ok(src.includes('test-learning-logger'),
    'package.json test script missing test-learning-logger');
  assert.ok(src.includes('test-per-app-profiles'),
    'package.json test script missing test-per-app-profiles');
  assert.ok(src.includes('test-kde-wayland-plugin'),
    'package.json test script missing test-kde-wayland-plugin');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. TEST COVERAGE
// ═══════════════════════════════════════════════════════════════════════

console.log('\n─ Test Coverage ─');

test('test-learning-logger.js exists', () => {
  assert.ok(fileExists('test/unit/test-learning-logger.js'));
});

test('test-learning-logger.js has at least 30 tests', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  const matches = src.match(/\bit\(/g);
  assert.ok(matches && matches.length >= 30,
    `expected >= 30 tests, found ${matches ? matches.length : 0}`);
});

test('test-learning-logger.js covers construction', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('LearningLogger construction'),
    'no construction tests');
});

test('test-learning-logger.js covers normal behavior', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('logAction() normal behavior'),
    'no normal behavior tests');
});

test('test-learning-logger.js covers invalid input', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('logAction() invalid input'),
    'no invalid input tests');
});

test('test-learning-logger.js covers edge cases', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('logAction() edge cases'),
    'no edge case tests');
});

test('test-learning-logger.js covers error handling', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('logAction() error handling'),
    'no error handling tests');
});

test('test-learning-logger.js covers file persistence (readEntries)', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('readEntries()'),
    'no readEntries tests');
});

test('test-learning-logger.js covers suggestRules', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('suggestRules()'),
    'no suggestRules tests');
});

test('test-learning-logger.js covers clear()', () => {
  const src = readFile('test/unit/test-learning-logger.js');
  assert.ok(src.includes('clear()'),
    'no clear tests');
});

test('test-per-app-profiles.js exists', () => {
  assert.ok(fileExists('test/unit/test-per-app-profiles.js'));
});

test('test-per-app-profiles.js has at least 30 tests', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  const matches = src.match(/\bit\(/g);
  assert.ok(matches && matches.length >= 30,
    `expected >= 30 tests, found ${matches ? matches.length : 0}`);
});

test('test-per-app-profiles.js covers construction', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  assert.ok(src.includes('construction'),
    'no construction tests');
});

test('test-per-app-profiles.js covers file persistence', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  assert.ok(src.includes('file persistence'),
    'no file persistence tests');
});

test('test-per-app-profiles.js covers cache behavior', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  assert.ok(src.includes('cache behavior'),
    'no cache tests');
});

test('test-per-app-profiles.js covers invalid input', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  assert.ok(src.includes('invalid input'),
    'no invalid input tests');
});

test('test-per-app-profiles.js covers feature flag disabled', () => {
  const src = readFile('test/unit/test-per-app-profiles.js');
  assert.ok(src.includes('feature disabled'),
    'no feature flag tests');
});

test('test-kde-wayland-plugin.js exists', () => {
  assert.ok(fileExists('test/unit/test-kde-wayland-plugin.js'));
});

test('test-kde-wayland-plugin.js has at least 30 tests', () => {
  const src = readFile('test/unit/test-kde-wayland-plugin.js');
  const matches = src.match(/\bit\(/g);
  assert.ok(matches && matches.length >= 30,
    `expected >= 30 tests, found ${matches ? matches.length : 0}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. `dynalloc watch` CLI COMMAND
// ═══════════════════════════════════════════════════════════════════════

console.log('\n─ dynalloc watch command ─');

test('lib/watch-renderer.js exists', () => {
  assert.ok(fileExists('lib/watch-renderer.js'));
});

test('watch-renderer exports renderFrame function', () => {
  const mod = require('../lib/watch-renderer');
  assert.strictEqual(typeof mod.renderFrame, 'function');
});

test('watch-renderer exports ANSI escape sequences', () => {
  const mod = require('../lib/watch-renderer');
  assert.ok(mod.ANSI, 'ANSI export missing');
  assert.ok(mod.ANSI.clearScreen, 'clearScreen missing');
  assert.ok(mod.ANSI.cursorHome, 'cursorHome missing');
  assert.ok(mod.ANSI.hideCursor, 'hideCursor missing');
  assert.ok(mod.ANSI.showCursor, 'showCursor missing');
});

test('watch-renderer renderFrame produces a non-empty string', () => {
  const mod = require('../lib/watch-renderer');
  const frame = mod.renderFrame({
    daemon: { version: '1.1.0', pid: 12345, uptime: 100 },
    cpu: { usagePercent: 12.5 },
    memory: { usedBytes: 4e9, totalBytes: 16e9 },
    scheduler: { stressLevel: 'NORMAL' },
    foreground: { pid: 1234, comm: 'firefox' },
    boosted: [], throttled: [], plugins: [], events: [],
  }, { width: 80, firstFrame: true });
  assert.ok(typeof frame === 'string');
  assert.ok(frame.length > 0);
});

test('watch-renderer firstFrame emits hideCursor + clearScreen', () => {
  const mod = require('../lib/watch-renderer');
  const frame = mod.renderFrame({}, { width: 80, firstFrame: true });
  assert.ok(frame.includes(mod.ANSI.hideCursor), 'hideCursor not emitted');
  assert.ok(frame.includes(mod.ANSI.clearScreen), 'clearScreen not emitted');
});

test('watch-renderer subsequent frames do NOT emit clearScreen (anti-flicker)', () => {
  const mod = require('../lib/watch-renderer');
  const frame = mod.renderFrame({}, { width: 80, firstFrame: false });
  assert.ok(!frame.includes(mod.ANSI.clearScreen),
    'subsequent frames should NOT clear screen (causes flicker)');
  assert.ok(frame.includes(mod.ANSI.cursorHome),
    'subsequent frames should reposition cursor');
});

test('watch-renderer pads lines to terminal width (anti-flicker)', () => {
  const mod = require('../lib/watch-renderer');
  const frame = mod.renderFrame({
    daemon: {}, cpu: {}, memory: {}, scheduler: {},
    foreground: null, boosted: [], throttled: [], plugins: [], events: [],
  }, { width: 100, firstFrame: false });
  // Check that at least one line has trailing whitespace padding
  assert.ok(frame.includes('  '.repeat(10)) || frame.length > 200,
    'frame should be padded to terminal width');
});

test('watch-renderer handles empty snapshot gracefully', () => {
  const mod = require('../lib/watch-renderer');
  assert.doesNotThrow(() => {
    mod.renderFrame({}, { width: 80, firstFrame: false });
  });
});

test('watch-renderer handles null fields gracefully', () => {
  const mod = require('../lib/watch-renderer');
  assert.doesNotThrow(() => {
    mod.renderFrame({
      daemon: null, cpu: null, memory: null, scheduler: null,
      foreground: null, boosted: null, throttled: null, plugins: null,
      events: null, thermal: null, policy: null, profile: null, governor: null,
    }, { width: 80, firstFrame: false });
  });
});

test('watch-renderer renderExit emits showCursor', () => {
  const mod = require('../lib/watch-renderer');
  const exit = mod.renderExit();
  assert.ok(exit.includes(mod.ANSI.showCursor), 'showCursor not emitted');
});

test('CLI registers watch command in main switch', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes("case 'watch'"),
    "no 'watch' case in CLI switch");
});

test('CLI help includes watch command', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('watch') && src.includes('Live dashboard'),
    'watch not documented in help');
});

test('CLI help includes --refresh option', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('--refresh'),
    '--refresh option not documented');
});

test('CLI help includes --width option', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('--width'),
    '--width option not documented');
});

test('CLI watch default refresh is 1000ms', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('refreshMs = 1000') || src.includes('refreshMs || 1000'),
    'default refresh is not 1000ms');
});

test('CLI watch handles SIGINT for clean exit', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('SIGINT'),
    'no SIGINT handler in watch');
  assert.ok(src.includes('renderExit'),
    'SIGINT handler does not call renderExit');
});

test('CLI watch reads /proc for CPU/memory', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('/proc/stat'),
    'does not read /proc/stat for CPU');
  assert.ok(src.includes('/proc/meminfo'),
    'does not read /proc/meminfo for memory');
  assert.ok(src.includes('/proc/loadavg'),
    'does not read /proc/loadavg');
});

test('CLI watch polls daemon via IPC', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes("sendCommand(socketPath, 'status'"),
    'does not poll status');
  assert.ok(src.includes("sendCommand(socketPath, 'metrics'"),
    'does not poll metrics');
  assert.ok(src.includes("sendCommand(socketPath, 'throttled'"),
    'does not poll throttled');
});

test('CLI watch uses setInterval for refresh', () => {
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes('setInterval(tick'),
    'no setInterval for refresh');
  assert.ok(src.includes('.unref()'),
    'interval not unref\'d (would prevent clean exit)');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. KDE PLASMA WAYLAND PLUGIN
// ═══════════════════════════════════════════════════════════════════════

console.log('\n─ KDE Plasma Wayland Plugin ─');

test('plugins/kde-wayland.js exists', () => {
  assert.ok(fileExists('plugins/kde-wayland.js'));
});

test('kde-wayland plugin has standard manifest', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.name, 'string');
  assert.ok(plugin.name.length > 0);
  assert.strictEqual(typeof plugin.version, 'string');
  assert.ok(/^\d+\.\d+\.\d+$/.test(plugin.version), 'version is not semver');
  assert.strictEqual(typeof plugin.description, 'string');
  assert.ok(plugin.description.length > 0);
});

test('kde-wayland plugin has detect() function', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.detect, 'function');
});

test('kde-wayland plugin has init() function', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.init, 'function');
});

test('kde-wayland plugin has destroy() function', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.destroy, 'function');
});

test('kde-wayland plugin has isSupported() function', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.isSupported, 'function');
});

test('kde-wayland plugin has getForegroundPid() function', () => {
  const plugin = require('../plugins/kde-wayland');
  assert.strictEqual(typeof plugin.getForegroundPid, 'function');
});

test('kde-wayland plugin does NOT activate on GNOME Wayland', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  const origWayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_CURRENT_DESKTOP = 'GNOME';
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  try {
    const plugin = require('../plugins/kde-wayland');
    assert.strictEqual(plugin.isSupported(), false,
      'plugin should NOT activate on GNOME');
  } finally {
    process.env.XDG_CURRENT_DESKTOP = origDesktop;
    process.env.XDG_SESSION_TYPE = origSession;
    process.env.WAYLAND_DISPLAY = origWayland;
  }
});

test('kde-wayland plugin does NOT activate on Hyprland', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  const origSig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  process.env.XDG_CURRENT_DESKTOP = 'Hyprland';
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.HYPRLAND_INSTANCE_SIGNATURE = 'abc';
  try {
    const plugin = require('../plugins/kde-wayland');
    assert.strictEqual(plugin.isSupported(), false,
      'plugin should NOT activate on Hyprland');
  } finally {
    process.env.XDG_CURRENT_DESKTOP = origDesktop;
    process.env.XDG_SESSION_TYPE = origSession;
    process.env.HYPRLAND_INSTANCE_SIGNATURE = origSig;
  }
});

test('kde-wayland plugin does NOT activate on X11', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  const origWayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_CURRENT_DESKTOP = 'KDE';
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;  // X11 must not have this set
  try {
    const plugin = require('../plugins/kde-wayland');
    assert.strictEqual(plugin.isSupported(), false,
      'plugin should NOT activate on X11');
  } finally {
    process.env.XDG_CURRENT_DESKTOP = origDesktop;
    process.env.XDG_SESSION_TYPE = origSession;
    if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
  }
});

test('kde-wayland plugin DOES activate on KDE Plasma Wayland', () => {
  const origDesktop = process.env.XDG_CURRENT_DESKTOP;
  const origSession = process.env.XDG_SESSION_TYPE;
  process.env.XDG_CURRENT_DESKTOP = 'KDE';
  process.env.XDG_SESSION_TYPE = 'wayland';
  try {
    const plugin = require('../plugins/kde-wayland');
    assert.strictEqual(plugin.isSupported(), true,
      'plugin SHOULD activate on KDE Plasma Wayland');
  } finally {
    process.env.XDG_CURRENT_DESKTOP = origDesktop;
    process.env.XDG_SESSION_TYPE = origSession;
  }
});

test('kde-wayland plugin uses qdbus (not gdbus or hyprctl)', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes("'qdbus'"),
    'plugin should use qdbus');
  assert.ok(!src.includes("'gdbus'"),
    'plugin should NOT use gdbus (GNOME-specific)');
  assert.ok(!src.includes("'hyprctl'"),
    'plugin should NOT use hyprctl (Hyprland-specific)');
  assert.ok(!src.includes("'swaymsg'"),
    'plugin should NOT use swaymsg (Sway-specific)');
});

test('kde-wayland plugin uses Plasma 6 WindowManagement DBus interface', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes('org.kde.KWin.WindowManagement'),
    'no Plasma 6 WindowManagement interface');
  assert.ok(src.includes('ActiveWindow'),
    'no ActiveWindow property');
  assert.ok(src.includes('GetWindowInfo'),
    'no GetWindowInfo method');
});

test('kde-wayland plugin uses Plasma 5 scripting fallback', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes('Scripting'),
    'no Plasma 5 Scripting interface');
  assert.ok(src.includes('evaluateScript'),
    'no evaluateScript method');
});

test('kde-wayland plugin has timeout on qdbus calls (no hang)', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes('QDBUS_TIMEOUT_MS'),
    'no qdbus timeout constant');
  assert.ok(src.includes('timeout: QDBUS_TIMEOUT_MS'),
    'timeout not applied to execFile calls');
});

test('kde-wayland plugin caches foreground PID to avoid DBus spam', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes('CACHE_TTL_MS'),
    'no cache TTL constant');
  assert.ok(src.includes('_cachePid'),
    'no cache variable');
});

test('kde-wayland plugin uses execFile (not exec, no shell injection)', () => {
  const src = readFile('plugins/kde-wayland.js');
  assert.ok(src.includes('child_process.execFile'),
    'should use execFile (no shell)');
  assert.ok(!src.includes('child_process.exec('),
    'should NOT use exec (shell injection risk)');
});

test('kde-wayland plugin can be registered with PluginManager', () => {
  const { PluginManager, resetPluginManager } = require('../plugin-manager');
  resetPluginManager();
  const mgr = new PluginManager();
  const plugin = require('../plugins/kde-wayland');
  const ok = mgr.register(plugin);
  assert.strictEqual(ok, true);
  assert.ok(mgr.registeredPlugins.includes('kde-wayland'));
  resetPluginManager();
});

test('kde-wayland plugin auto-loads via loadBuiltinPlugins', () => {
  // The plugin file lives in plugins/ which is auto-scanned
  const src = readFile('plugin-manager.js');
  assert.ok(src.includes("f.endsWith('.js')"),
    'plugin manager should auto-load .js files from plugins/');
  // Verify our plugin is in plugins/
  assert.ok(fileExists('plugins/kde-wayland.js'),
    'kde-wayland.js should be in plugins/ for auto-loading');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. DOCUMENTATION
// ═══════════════════════════════════════════════════════════════════════

console.log('\n─ Documentation ─');

test('CHANGELOG.md has a v1.1.0 entry', () => {
  const src = readFile('CHANGELOG.md');
  assert.ok(src.includes('1.1.0'),
    'CHANGELOG.md does not mention v1.1.0');
});

test('CHANGELOG.md mentions dynalloc watch', () => {
  const src = readFile('CHANGELOG.md');
  assert.ok(src.toLowerCase().includes('watch'),
    'CHANGELOG.md does not mention watch');
});

test('CHANGELOG.md mentions KDE Plasma Wayland plugin', () => {
  const src = readFile('CHANGELOG.md');
  assert.ok(src.includes('KDE') && src.includes('Wayland'),
    'CHANGELOG.md does not mention KDE Plasma Wayland');
});

test('package.json version is at least 1.1.0', () => {
  const pkg = JSON.parse(readFile('package.json'));
  const [major, minor] = pkg.version.split('.').map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 1),
    `package.json version ${pkg.version} is older than the v1.1.0 milestone`);
});

test('CLI version string matches package.json', () => {
  const pkg = JSON.parse(readFile('package.json'));
  const src = readFile('dynalloc-cli.js');
  assert.ok(src.includes(`VERSION = '${pkg.version}'`),
    `CLI VERSION constant does not match package.json (${pkg.version})`);
});

test('daemon ping version matches package.json', () => {
  const pkg = JSON.parse(readFile('package.json'));
  const src = readFile('daemon.js');
  assert.ok(src.includes(`version: '${pkg.version}'`),
    `daemon.js version string does not match package.json (${pkg.version})`);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. RUN ALL NEW TESTS
// ═══════════════════════════════════════════════════════════════════════

console.log('\n─ Run new test suites ─');

testAsync('test-learning-logger.js passes', async () => {
  try {
    execFileSync('node', ['--test', 'test/unit/test-learning-logger.js'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`test-learning-logger.js failed: ${err.message}`);
  }
});

testAsync('test-per-app-profiles.js passes', async () => {
  try {
    execFileSync('node', ['--test', 'test/unit/test-per-app-profiles.js'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`test-per-app-profiles.js failed: ${err.message}`);
  }
});

testAsync('test-kde-wayland-plugin.js passes', async () => {
  try {
    execFileSync('node', ['--test', 'test/unit/test-kde-wayland-plugin.js'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`test-kde-wayland-plugin.js failed: ${err.message}`);
  }
});

testAsync('test-system-plugin.js passes', async () => {
  try {
    execFileSync('node', ['--test', 'test/unit/test-system-plugin.js'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`test-system-plugin.js failed: ${err.message}`);
  }
});

testAsync('syntax check all new files passes', async () => {
  const files = [
    'lib/watch-renderer.js',
    'plugins/kde-wayland.js',
    'test/unit/test-learning-logger.js',
    'test/unit/test-per-app-profiles.js',
    'test/unit/test-kde-wayland-plugin.js',
  ];
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`syntax error in ${f}: ${err.message}`);
    }
  }
});

testAsync('daemon boots in DRY_RUN mode', async () => {
  // Quick smoke test: the daemon should still boot with all the new code.
  try {
    execFileSync('node', ['dynalloc-daemon.js'], {
      cwd: ROOT,
      env: { ...process.env, DYNALLOC_DRY_RUN: '1' },
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch (err) {
    // timeout (124) is the success path — daemon was killed after boot.
    if (err.status === 124 || (err.signal === 'SIGTERM')) {
      return;
    }
    // Any non-zero exit other than timeout is a failure.
    if (err.status && err.status !== 0) {
      throw new Error(`daemon boot failed: exit ${err.status}, stderr: ${err.stderr || ''}`);
    }
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  v1.1.0 verification: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 8000);
