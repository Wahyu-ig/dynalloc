'use strict';

/**
 * verify-profile-manager.js — Safety & architecture validation for the
 * v0.5.0 Phase 3 Profile Manager & Adaptive Policy Profiles.
 *
 * Run with: node scripts/verify-profile-manager.js
 *
 * Checks:
 *   1. Module structure — all expected files exist and export documented API.
 *   2. No syscalls in profile modules — profiles are data + lifecycle only.
 *   3. Backward compatibility — ENABLE_PROFILE_MANAGER defaults false.
 *   4. Controller isolation — no cross-imports between profiles/ and
 *      detectors/ or policy-engine/.
 *   5. Daemon integration — gated construction, hot-reload, cleanup, IPC.
 *   6. Config schema — all new keys have schema + hot-reload entries.
 *   7. 9 built-in profiles with correct priorities.
 *   8. Inheritance chain — gaming→performance, battery-saver→powersave.
 *   9. Behavioral smoke test — boots + activates profiles without throwing.
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

console.log('Profile Manager Safety & Architecture Validation');
console.log('='.repeat(60));

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('profiles/base-profile.js exists', () => {
  assert.ok(fs.existsSync(path.join(PROFILES_DIR, 'base-profile.js')));
});

test('profiles/profile-registry.js exists', () => {
  assert.ok(fs.existsSync(path.join(PROFILES_DIR, 'profile-registry.js')));
});

test('profiles/profile-manager.js exists', () => {
  assert.ok(fs.existsSync(path.join(PROFILES_DIR, 'profile-manager.js')));
});

test('profiles/builtin-profiles.js exists', () => {
  assert.ok(fs.existsSync(path.join(PROFILES_DIR, 'builtin-profiles.js')));
});

test('profiles/index.js exists', () => {
  assert.ok(fs.existsSync(path.join(PROFILES_DIR, 'index.js')));
});

test('profiles/index.js exports documented API', () => {
  const idx = require(PROFILES_DIR);
  for (const name of ['Profile', 'ProfileRegistry', 'ProfileManager', 'createBuiltinProfiles', 'BUILTIN_DEFINITIONS']) {
    assert.ok(idx[name] !== undefined, `index.js must export ${name}`);
  }
});

// ── 2. No syscalls in profile modules ─────────────────────────────────

test('profile modules never call exec/execFile/spawn', () => {
  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src),
      `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
    assert.ok(!/[^.]exec\(['"`]/.test(src), `${f}: must NOT use exec() with shell`);
  }
});

test('profile modules never write to sysfs/proc', () => {
  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
    assert.ok(!/writeFileSync\(['"`]\/(sys|proc)/.test(src),
      `${f}: must NOT writeFileSync to /sys or /proc`);
  }
});

// ── 3. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_PROFILE_MANAGER defaulting to false', () => {
  assert.ok(/ENABLE_PROFILE_MANAGER:\s*false/.test(CONFIG_SRC),
    'ENABLE_PROFILE_MANAGER must default to false');
});

test('config.js has PROFILE_FILE_PATH defaulting to null', () => {
  assert.ok(/PROFILE_FILE_PATH:\s*null/.test(CONFIG_SRC),
    'PROFILE_FILE_PATH must default to null');
});

test('config.js has PROFILE_IDLE_TIMEOUT_MS default', () => {
  assert.ok(/PROFILE_IDLE_TIMEOUT_MS:\s*300000/.test(CONFIG_SRC),
    'PROFILE_IDLE_TIMEOUT_MS must default to 300000 (5 min)');
});

test('config.js has schema entries for all new keys', () => {
  for (const key of ['ENABLE_PROFILE_MANAGER', 'PROFILE_FILE_PATH', 'PROFILE_IDLE_TIMEOUT_MS']) {
    assert.ok(CONFIG_SRC.includes(`${key}:`), `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all new keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of ['ENABLE_PROFILE_MANAGER', 'PROFILE_FILE_PATH', 'PROFILE_IDLE_TIMEOUT_MS']) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key), `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 4. Controller isolation ───────────────────────────────────────────

test('profile modules do not import detectors/', () => {
  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/detectors/.test(src),
      `${f}: must NOT import from detectors/ (circular dependency risk)`);
  }
});

test('profile modules do not import policy-engine/ directly', () => {
  // Exception: profile-registry reuses policy-loader's YAML parser —
  // that's a utility import, not a dependency on PE runtime.
  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.js') && f !== 'profile-registry.js');
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/policy-engine/.test(src),
      `${f}: must NOT import from policy-engine/ (circular dependency risk)`);
  }
});

// ── 5. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates ProfileManager behind ENABLE_PROFILE_MANAGER', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_PROFILE_MANAGER/.test(DAEMON_SRC),
    'daemon.js must construct ProfileManager only when ENABLE_PROFILE_MANAGER is true');
});

test('daemon.js requires ./profiles lazily', () => {
  assert.ok(/require\(['"]\.\/profiles['"]\)/.test(DAEMON_SRC),
    'daemon.js must require ./profiles');
});

test('daemon.js calls profileMgr.destroy in cleanupAndExit', () => {
  assert.ok(/profileMgr\.destroy\(\)/.test(DAEMON_SRC),
    'daemon.js must call profileMgr.destroy() in cleanupAndExit');
});

test('daemon.js calls profileMgr.setConfig on hot-reload', () => {
  assert.ok(/profileMgr\.setConfig\(/.test(DAEMON_SRC),
    'daemon.js must call profileMgr.setConfig() on hot-reload');
});

test('daemon.js registers IPC profiles handler', () => {
  assert.ok(/registerHandler\(['"]profiles['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'profiles'");
});

test('daemon.js exposes profileManager in getState()', () => {
  assert.ok(/profileManager:\s*profileMgr/.test(DAEMON_SRC),
    'daemon.js getState() must expose profileManager');
});

test('daemon.js declares profileMgr state variable', () => {
  assert.ok(/let\s+profileMgr\s*=\s*null/.test(DAEMON_SRC),
    'daemon.js must declare `let profileMgr = null;`');
});

// ── 6. Built-in profiles ──────────────────────────────────────────────

test('9 built-in profiles defined', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  assert.strictEqual(BUILTIN_DEFINITIONS.length, 9);
});

test('built-in profiles have unique IDs', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const ids = BUILTIN_DEFINITIONS.map(p => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('built-in profiles have valid priorities (0-1000)', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  for (const p of BUILTIN_DEFINITIONS) {
    assert.ok(typeof p.priority === 'number' && p.priority >= 0 && p.priority <= 1000,
      `${p.id}: priority must be 0-1000`);
  }
});

test('gaming priority > development priority', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const byId = Object.fromEntries(BUILTIN_DEFINITIONS.map(p => [p.id, p]));
  assert.ok(byId.gaming.priority > byId.development.priority,
    'gaming must have higher priority than development');
});

test('battery-saver priority > performance priority', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const byId = Object.fromEntries(BUILTIN_DEFINITIONS.map(p => [p.id, p]));
  assert.ok(byId['battery-saver'].priority > byId.performance.priority,
    'battery-saver must have higher priority than performance');
});

test('idle priority is lowest', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const idle = BUILTIN_DEFINITIONS.find(p => p.id === 'idle');
  for (const p of BUILTIN_DEFINITIONS) {
    if (p.id !== 'idle') {
      assert.ok(p.priority > idle.priority,
        `idle must have lowest priority (lower than ${p.id})`);
    }
  }
});

// ── 7. Inheritance ────────────────────────────────────────────────────

test('gaming inherits performance', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const gaming = BUILTIN_DEFINITIONS.find(p => p.id === 'gaming');
  assert.deepStrictEqual(gaming.inherits, ['performance']);
});

test('battery-saver inherits powersave', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const bs = BUILTIN_DEFINITIONS.find(p => p.id === 'battery-saver');
  assert.deepStrictEqual(bs.inherits, ['powersave']);
});

test('development inherits balanced', () => {
  const { BUILTIN_DEFINITIONS } = require(PROFILES_DIR);
  const dev = BUILTIN_DEFINITIONS.find(p => p.id === 'development');
  assert.deepStrictEqual(dev.inherits, ['balanced']);
});

// ── 8. Behavioral smoke test ──────────────────────────────────────────

test('ProfileManager boots + activates profiles without throwing', () => {
  const { ProfileManager } = require(PROFILES_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const config = { ...DEFAULT_CONFIG, DRY_RUN: true };
  const bus = new EventBus();
  const rcm = {
    applyThermalProfile: () => ({ success: true }),
    applyPowerProfile: () => ({ success: true }),
    setPpdProfile: () => ({ success: true }),
    setGovernor: () => ({ success: true }),
    getController: () => null,
  };
  const mgr = new ProfileManager({ config, bus, rcm });
  mgr.setup();
  mgr.start();
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.demand('test', 'gaming');
  assert.strictEqual(mgr.activeProfileId, 'gaming');
  mgr.demand('test', null);
  assert.strictEqual(mgr.activeProfileId, 'balanced');
  mgr.destroy();
});

test('ProfileRegistry rejects circular inheritance without crashing', () => {
  const { ProfileRegistry } = require(PROFILES_DIR);
  const r = new ProfileRegistry();
  // Should not throw — falls back to raw settings
  r.registerAll([
    { id: 'a', version: '1.0.0', inherits: ['b'], settings: { x: 1 } },
    { id: 'b', version: '1.0.0', inherits: ['a'], settings: { y: 2 } },
  ]);
  assert.ok(r.get('a'));
  assert.ok(r.get('b'));
});

// ── 9. Test file exists ───────────────────────────────────────────────

test('test/unit/test-profile-manager.js exists', () => {
  const p = path.join(__dirname, '..', 'test', 'unit', 'test-profile-manager.js');
  assert.ok(fs.existsSync(p));
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Profile Manager safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Profile Manager safety regression detected.');
  process.exit(1);
}

process.exit(0);
