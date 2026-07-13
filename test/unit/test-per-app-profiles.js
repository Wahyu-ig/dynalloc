'use strict';

/**
 * DynAlloc — PerAppProfiles Unit Tests (v1.1.0)
 * ==============================================
 *
 * Comprehensive unit tests for per-app-profiles.js covering:
 *   - Construction & defaults
 *   - getProfile() normal behavior (returns matched profile)
 *   - getProfile() invalid input (non-string comm, empty string)
 *   - getProfile() when feature flag is disabled (returns null)
 *   - Cache behavior (5-second reload interval)
 *   - reload() (force re-read from disk)
 *   - isProtected() / getOverrideSchedClass() / getOverrideNice()
 *   - File persistence (JSON file parsing, missing dir, malformed files)
 *   - Field validation (type checking, defaults)
 *   - Getters (profileCount, profiles)
 *   - Hot-reload edge cases
 *
 * Run: node --test test/unit/test-per-app-profiles.js
 */

const { describe, it, before, after, mock } = require('node:test');
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

// ── Module under test ──────────────────────────────────────────────────

const { PerAppProfiles } = require('../../per-app-profiles');

// ── Test helpers ───────────────────────────────────────────────────────
//
// node:test runs tests inside a `describe` block in parallel. We must
// NOT share module-level mutable state. Each test creates its own
// unique tmpdir via `freshDir()` and is responsible for cleanup.

let _dirCounter = 0;

function freshDir() {
  _dirCounter++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dynalloc-pap-${_dirCounter}-${process.pid}-`));
  return dir;
}

function makeConfig(overrides = {}) {
  const dir = freshDir();
  return {
    ENABLE_PER_APP_PROFILES: true,
    PER_APP_PROFILES_DIR: path.join(dir, 'apps.d'),
    _tmpDir: dir, // keep a reference for cleanup
    ...overrides,
  };
}

function cleanup(cfg) {
  if (cfg && cfg._tmpDir) {
    try { fs.rmSync(cfg._tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function writeProfile(cfg, filename, profileObj) {
  const dir = cfg.PER_APP_PROFILES_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(profileObj));
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles construction', () => {
  it('uses provided PER_APP_PROFILES_DIR', () => {
    const cfg = makeConfig({ PER_APP_PROFILES_DIR: '/custom/apps.d' });
    const pap = new PerAppProfiles(cfg);
    // No public accessor for _dir, but we can verify behaviorally by
    // checking that no file is read from the custom dir during construction.
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('falls back to default dir when PER_APP_PROFILES_DIR is null', () => {
    const pap = new PerAppProfiles({
      ENABLE_PER_APP_PROFILES: true,
      PER_APP_PROFILES_DIR: null,
    });
    assert.strictEqual(pap.profileCount, 0);
  });

  it('falls back to default dir when PER_APP_PROFILES_DIR is undefined', () => {
    const pap = new PerAppProfiles({
      ENABLE_PER_APP_PROFILES: true,
    });
    assert.strictEqual(pap.profileCount, 0);
  });

  it('starts with zero profiles', () => {
    const cfg = makeConfig();
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.profileCount, 0);
    assert.deepStrictEqual(pap.profiles, []);
    cleanup(cfg);
  });

  it('does not load profiles on construction (lazy load on first getProfile)', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', schedClass: 'INTERACTIVE' });
    const pap = new PerAppProfiles(cfg);
    // No profiles loaded until first getProfile() call
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. getProfile() NORMAL BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles.getProfile() normal behavior', () => {
  it('returns the matching profile', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', {
      name: 'firefox',
      schedClass: 'INTERACTIVE',
      nice: -3,
      ioClass: 1,
      ioLevel: 4,
      protect: true,
    });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p, 'expected a profile for firefox');
    assert.strictEqual(p.name, 'firefox');
    assert.strictEqual(p.schedClass, 'INTERACTIVE');
    assert.strictEqual(p.nice, -3);
    assert.strictEqual(p.ioClass, 1);
    assert.strictEqual(p.ioLevel, 4);
    assert.strictEqual(p.protect, true);
    cleanup(cfg);
  });

  it('returns null when no profile matches', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile('chrome'), null);
    cleanup(cfg);
  });

  it('returns null when no profiles loaded', () => {
    const cfg = makeConfig();
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile('firefox'), null);
    cleanup(cfg);
  });

  it('loads multiple profiles from multiple files', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    writeProfile(cfg, 'chrome.json', { name: 'chrome', nice: -2 });
    writeProfile(cfg, 'rustc.json', { name: 'rustc', nice: 5, schedClass: 'BACKGROUND' });
    const pap = new PerAppProfiles(cfg);
    assert.ok(pap.getProfile('firefox'));
    assert.ok(pap.getProfile('chrome'));
    assert.ok(pap.getProfile('rustc'));
    assert.strictEqual(pap.profileCount, 3);
    cleanup(cfg);
  });

  it('returns the same object reference within a cache window', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    const p1 = pap.getProfile('firefox');
    const p2 = pap.getProfile('firefox');
    assert.strictEqual(p1, p2, 'should be same object within cache window');
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. getProfile() INVALID INPUT
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles.getProfile() invalid input', () => {
  it('returns null when ENABLE_PER_APP_PROFILES is false', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile('firefox'), null);
    cleanup(cfg);
  });

  it('returns null when comm is not a string', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile(null), null);
    assert.strictEqual(pap.getProfile(undefined), null);
    assert.strictEqual(pap.getProfile(12345), null);
    assert.strictEqual(pap.getProfile({}), null);
    assert.strictEqual(pap.getProfile([]), null);
    assert.strictEqual(pap.getProfile(true), null);
    cleanup(cfg);
  });

  it('returns null when comm is empty string', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile(''), null);
    cleanup(cfg);
  });

  it('does not match when filename differs from name field', () => {
    // The match is on the "name" field inside the JSON, not the filename.
    const cfg = makeConfig();
    writeProfile(cfg, 'random-filename.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    assert.ok(pap.getProfile('firefox'));
    assert.strictEqual(pap.getProfile('random-filename'), null);
    cleanup(cfg);
  });

  it('is case-sensitive on comm', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.ok(pap.getProfile('firefox'));
    assert.strictEqual(pap.getProfile('Firefox'), null);
    assert.strictEqual(pap.getProfile('FIREFOX'), null);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. EDGE CASES — field validation
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles field validation', () => {
  it('drops non-string schedClass', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', schedClass: 123 });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.schedClass, undefined);
    cleanup(cfg);
  });

  it('drops non-number nice', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: 'high' });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.nice, undefined);
    cleanup(cfg);
  });

  it('drops non-number ioClass', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', ioClass: 'best-effort' });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.ioClass, undefined);
    cleanup(cfg);
  });

  it('drops non-number ioLevel', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', ioLevel: true });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.ioLevel, undefined);
    cleanup(cfg);
  });

  it('coerces truthy non-boolean protect to true', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: 'yes' });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.protect, true);
    cleanup(cfg);
  });

  it('coerces falsy protect to false', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: 0 });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.protect, false);
    cleanup(cfg);
  });

  it('defaults protect to false when missing', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.ok(p);
    assert.strictEqual(p.protect, false);
    cleanup(cfg);
  });

  it('accepts negative nice values', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -20 });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.strictEqual(p.nice, -20);
    cleanup(cfg);
  });

  it('accepts nice=0', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: 0 });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    // Note: 0 is a valid number, so it should be preserved
    assert.strictEqual(p.nice, 0);
    cleanup(cfg);
  });

  it('skips profiles without name field', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'no-name.json', { schedClass: 'INTERACTIVE' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('skips profiles with non-string name', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'numeric-name.json', { name: 12345 });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('preserves all valid fields together', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', {
      name: 'firefox',
      schedClass: 'INTERACTIVE',
      nice: -5,
      ioClass: 1,
      ioLevel: 2,
      protect: true,
    });
    const pap = new PerAppProfiles(cfg);
    const p = pap.getProfile('firefox');
    assert.strictEqual(p.name, 'firefox');
    assert.strictEqual(p.schedClass, 'INTERACTIVE');
    assert.strictEqual(p.nice, -5);
    assert.strictEqual(p.ioClass, 1);
    assert.strictEqual(p.ioLevel, 2);
    assert.strictEqual(p.protect, true);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. FILE PERSISTENCE — loading from disk
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles file persistence', () => {
  it('loads only .json files (ignores other extensions)', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'firefox.json'),
      JSON.stringify({ name: 'firefox' }));
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'chrome.txt'),
      JSON.stringify({ name: 'chrome' }));
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'readme.md'),
      'not a profile');
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 1);
    assert.ok(pap.getProfile('firefox'));
    assert.strictEqual(pap.getProfile('chrome'), null);
    cleanup(cfg);
  });

  it('handles a missing profiles directory gracefully', () => {
    const cfg = makeConfig();
    // Don't create the directory
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 0);
    assert.strictEqual(pap.getProfile('firefox'), null);
    cleanup(cfg);
  });

  it('handles a profiles directory that becomes unreadable', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'firefox.json'),
      JSON.stringify({ name: 'firefox' }));
    // Make the directory unreadable (skip on root)
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(cfg.PER_APP_PROFILES_DIR, 0o000);
      const pap = new PerAppProfiles(cfg);
      pap.reload();
      assert.strictEqual(pap.profileCount, 0);
      fs.chmodSync(cfg.PER_APP_PROFILES_DIR, 0o755);
    }
    cleanup(cfg);
  });

  it('skips malformed JSON files', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'broken.json'),
      '{ this is not valid json');
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'firefox.json'),
      JSON.stringify({ name: 'firefox' }));
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 1);
    assert.ok(pap.getProfile('firefox'));
    cleanup(cfg);
  });

  it('handles empty JSON file', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'empty.json'), '');
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('handles JSON file containing an array (not an object)', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'arr.json'),
      JSON.stringify([{ name: 'firefox' }]));
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    // An array doesn't have a string `name` property — should be skipped.
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('handles JSON file containing null', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'null.json'), 'null');
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('handles JSON file containing a string', () => {
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'str.json'),
      JSON.stringify('hello'));
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('later file overwrites earlier file when same name', () => {
    // Map insertion order = readdir order. If two files declare the same
    // "name", the later one wins. (Implementation: this._profiles.set
    // called for each file in readdir order.)
    const cfg = makeConfig();
    fs.mkdirSync(cfg.PER_APP_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'a-firefox.json'),
      JSON.stringify({ name: 'firefox', nice: -1 }));
    fs.writeFileSync(path.join(cfg.PER_APP_PROFILES_DIR, 'b-firefox.json'),
      JSON.stringify({ name: 'firefox', nice: -5 }));
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 1);
    const p = pap.getProfile('firefox');
    // Both keys map to "firefox"; the second set() wins. The exact
    // readdir order is not guaranteed, so we just verify one of them.
    assert.ok(p.nice === -1 || p.nice === -5);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. CACHE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles cache behavior', () => {
  it('does not reload within the 5-second cache window', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    const p1 = pap.getProfile('firefox');
    // Modify the file
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -10 });
    const p2 = pap.getProfile('firefox');
    // Same object — cache returned, no reload
    assert.strictEqual(p1, p2);
    assert.strictEqual(p2.nice, -3);
    cleanup(cfg);
  });

  it('reloads after the cache window expires', async () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    // Force a load
    pap.reload();
    // Verify loaded
    assert.strictEqual(pap.getProfile('firefox').nice, -3);

    // Hack: directly mutate the load interval to a very short value so we
    // don't have to wait 5 seconds. The interval is stored as
    // _loadIntervalMs; we patch it to 10ms.
    pap._loadIntervalMs = 10;
    // Modify the file
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -10 });
    // Wait 50ms — past the new interval
    await new Promise((r) => setTimeout(r, 50));
    // Next getProfile() should reload
    const p = pap.getProfile('firefox');
    assert.strictEqual(p.nice, -10);
    cleanup(cfg);
  });

  it('force reload() bypasses the cache', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.getProfile('firefox').nice, -3);
    // Modify the file
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -10 });
    // Force reload — bypasses cache
    pap.reload();
    assert.strictEqual(pap.getProfile('firefox').nice, -10);
    cleanup(cfg);
  });

  it('reload() picks up newly added files', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 1);
    // Add a new profile
    writeProfile(cfg, 'chrome.json', { name: 'chrome', nice: -2 });
    pap.reload();
    assert.strictEqual(pap.profileCount, 2);
    assert.ok(pap.getProfile('chrome'));
    cleanup(cfg);
  });

  it('reload() picks up deleted files', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    writeProfile(cfg, 'chrome.json', { name: 'chrome' });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 2);
    // Delete one file
    fs.unlinkSync(path.join(cfg.PER_APP_PROFILES_DIR, 'chrome.json'));
    pap.reload();
    assert.strictEqual(pap.profileCount, 1);
    assert.strictEqual(pap.getProfile('chrome'), null);
    cleanup(cfg);
  });

  it('reload() clears removed entries from the internal map', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.ok(pap.getProfile('firefox'));
    // Delete the file and force reload
    fs.unlinkSync(path.join(cfg.PER_APP_PROFILES_DIR, 'firefox.json'));
    pap.reload();
    assert.strictEqual(pap.getProfile('firefox'), null);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. HELPER METHODS — isProtected / getOverrideSchedClass / getOverrideNice
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles helper methods', () => {
  it('isProtected() returns true for protected profiles', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected('firefox'), true);
    cleanup(cfg);
  });

  it('isProtected() returns false for non-protected profiles', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: false });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected('firefox'), false);
    cleanup(cfg);
  });

  it('isProtected() returns false for unknown profiles', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected('chrome'), false);
    cleanup(cfg);
  });

  it('isProtected() returns false when feature disabled', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected('firefox'), false);
    cleanup(cfg);
  });

  it('isProtected() returns false for invalid comm', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected(''), false);
    assert.strictEqual(pap.isProtected(null), false);
    assert.strictEqual(pap.isProtected(undefined), false);
    cleanup(cfg);
  });

  it('getOverrideSchedClass() returns the override', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', {
      name: 'firefox', schedClass: 'INTERACTIVE',
    });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideSchedClass('firefox'), 'INTERACTIVE');
    cleanup(cfg);
  });

  it('getOverrideSchedClass() returns null when no override', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideSchedClass('firefox'), null);
    cleanup(cfg);
  });

  it('getOverrideSchedClass() returns null for unknown comm', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', schedClass: 'INTERACTIVE' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideSchedClass('chrome'), null);
    cleanup(cfg);
  });

  it('getOverrideNice() returns the override', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -5 });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideNice('firefox'), -5);
    cleanup(cfg);
  });

  it('getOverrideNice() returns null when no override', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideNice('firefox'), null);
    cleanup(cfg);
  });

  it('getOverrideNice() returns null for unknown comm', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -5 });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideNice('chrome'), null);
    cleanup(cfg);
  });

  it('getOverrideNice() returns 0 when profile sets nice=0', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: 0 });
    const pap = new PerAppProfiles(cfg);
    const n = pap.getOverrideNice('firefox');
    assert.strictEqual(n, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. GETTERS
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles getters', () => {
  it('profileCount returns 0 when empty', () => {
    const cfg = makeConfig();
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('profileCount returns N when N profiles loaded', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'a.json', { name: 'a' });
    writeProfile(cfg, 'b.json', { name: 'b' });
    writeProfile(cfg, 'c.json', { name: 'c' });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.strictEqual(pap.profileCount, 3);
    cleanup(cfg);
  });

  it('profiles returns array of profile names', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'a.json', { name: 'a' });
    writeProfile(cfg, 'b.json', { name: 'b' });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    const names = pap.profiles;
    assert.ok(Array.isArray(names));
    assert.strictEqual(names.length, 2);
    assert.ok(names.includes('a'));
    assert.ok(names.includes('b'));
    cleanup(cfg);
  });

  it('profiles returns empty array when no profiles loaded', () => {
    const cfg = makeConfig();
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    assert.deepStrictEqual(pap.profiles, []);
    cleanup(cfg);
  });

  it('profiles returns a fresh array each call', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'a.json', { name: 'a' });
    const pap = new PerAppProfiles(cfg);
    pap.reload();
    const a1 = pap.profiles;
    const a2 = pap.profiles;
    assert.notStrictEqual(a1, a2);
    assert.deepStrictEqual(a1, a2);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. FEATURE FLAG DISABLED
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles with feature disabled', () => {
  it('getProfile() returns null even with files on disk', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile('firefox'), null);
    cleanup(cfg);
  });

  it('does not perform disk I/O when disabled', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    // Don't even create the directory
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getProfile('firefox'), null);
    assert.strictEqual(pap.profileCount, 0);
    cleanup(cfg);
  });

  it('isProtected returns false when disabled', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox', protect: true });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.isProtected('firefox'), false);
    cleanup(cfg);
  });

  it('getOverrideSchedClass returns null when disabled', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox', schedClass: 'INTERACTIVE' });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideSchedClass('firefox'), null);
    cleanup(cfg);
  });

  it('getOverrideNice returns null when disabled', () => {
    const cfg = makeConfig({ ENABLE_PER_APP_PROFILES: false });
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -5 });
    const pap = new PerAppProfiles(cfg);
    assert.strictEqual(pap.getOverrideNice('firefox'), null);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. ROUND-TRIP INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

describe('PerAppProfiles round-trip integration', () => {
  it('end-to-end: write, load, getProfile, isProtected, getOverrideNice', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', {
      name: 'firefox',
      schedClass: 'INTERACTIVE',
      nice: -5,
      ioClass: 1,
      ioLevel: 4,
      protect: true,
    });
    writeProfile(cfg, 'chrome.json', {
      name: 'chrome',
      schedClass: 'INTERACTIVE',
      nice: -2,
      protect: false,
    });
    writeProfile(cfg, 'rustc.json', {
      name: 'rustc',
      schedClass: 'BACKGROUND',
      nice: 10,
      protect: false,
    });
    const pap = new PerAppProfiles(cfg);
    pap.reload();

    assert.strictEqual(pap.profileCount, 3);

    // Firefox — interactive, protected, boosted
    assert.strictEqual(pap.getOverrideSchedClass('firefox'), 'INTERACTIVE');
    assert.strictEqual(pap.getOverrideNice('firefox'), -5);
    assert.strictEqual(pap.isProtected('firefox'), true);

    // Chrome — interactive, not protected
    assert.strictEqual(pap.getOverrideSchedClass('chrome'), 'INTERACTIVE');
    assert.strictEqual(pap.getOverrideNice('chrome'), -2);
    assert.strictEqual(pap.isProtected('chrome'), false);

    // Rustc — background, throttled
    assert.strictEqual(pap.getOverrideSchedClass('rustc'), 'BACKGROUND');
    assert.strictEqual(pap.getOverrideNice('rustc'), 10);
    assert.strictEqual(pap.isProtected('rustc'), false);

    // Unknown
    assert.strictEqual(pap.getProfile('unknown'), null);
    assert.strictEqual(pap.getOverrideSchedClass('unknown'), null);
    assert.strictEqual(pap.getOverrideNice('unknown'), null);
    assert.strictEqual(pap.isProtected('unknown'), false);

    cleanup(cfg);
  });

  it('new instance picks up changes from another writer', () => {
    const cfg = makeConfig();
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -3 });
    const pap1 = new PerAppProfiles(cfg);
    pap1.reload();
    assert.strictEqual(pap1.getOverrideNice('firefox'), -3);

    // Update the file
    writeProfile(cfg, 'firefox.json', { name: 'firefox', nice: -10 });

    // A new instance sees the updated value
    const pap2 = new PerAppProfiles(cfg);
    pap2.reload();
    assert.strictEqual(pap2.getOverrideNice('firefox'), -10);

    // pap1 still has the cached value until its cache window expires
    assert.strictEqual(pap1.getOverrideNice('firefox'), -3);

    cleanup(cfg);
  });
});
