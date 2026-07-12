'use strict';

/**
 * verify-adaptive-switching.js — Safety & architecture validation for
 * the v0.5.0 Phase 4 Automatic Adaptive Profile Switching.
 *
 * Run with: node scripts/verify-adaptive-switching.js
 *
 * Checks:
 *   1. Module structure — all expected files exist and export documented API.
 *   2. No syscalls in adaptive modules — pure governance layer.
 *   3. No polling loops — only event-driven + unref'd debounce timer.
 *   4. Backward compatibility — ENABLE_ADAPTIVE_SWITCHING defaults false.
 *   5. Controller isolation — no cross-imports with detectors/profiles/lib.
 *   6. Daemon integration — gated construction, hot-reload, cleanup, IPC.
 *   7. Config schema — all new keys have schema + hot-reload entries.
 *   8. TransitionManager stability guarantees — debounce, cooldown, oscillation.
 *   9. AdaptiveEngine rollback + user override.
 *  10. Behavioral smoke test — boots + handles events without throwing.
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

console.log('Adaptive Switching Safety & Architecture Validation');
console.log('='.repeat(60));

const ADAPTIVE_DIR = path.join(__dirname, '..', 'adaptive');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('adaptive/transition-manager.js exists', () => {
  assert.ok(fs.existsSync(path.join(ADAPTIVE_DIR, 'transition-manager.js')));
});

test('adaptive/adaptive-engine.js exists', () => {
  assert.ok(fs.existsSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js')));
});

test('adaptive/index.js exists', () => {
  assert.ok(fs.existsSync(path.join(ADAPTIVE_DIR, 'index.js')));
});

test('adaptive/index.js exports documented API', () => {
  const idx = require(ADAPTIVE_DIR);
  assert.strictEqual(typeof idx.TransitionManager, 'function');
  assert.strictEqual(typeof idx.AdaptiveEngine, 'function');
});

// ── 2. No syscalls in adaptive modules ─────────────────────────────────

test('adaptive modules never call exec/execFile/spawn', () => {
  const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTIVE_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src),
      `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

test('adaptive modules never write to sysfs/proc', () => {
  const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTIVE_DIR, f), 'utf8');
    assert.ok(!/writeFileSync\(['"`]\/(sys|proc)/.test(src),
      `${f}: must NOT writeFileSync to /sys or /proc`);
  }
});

// ── 3. No polling loops ───────────────────────────────────────────────

test('adaptive modules use no setInterval (no polling)', () => {
  const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTIVE_DIR, f), 'utf8');
    assert.ok(!/setInterval\(/.test(src),
      `${f}: must NOT use setInterval (no polling)`);
  }
});

test('adaptive modules unref all setTimeout calls', () => {
  const tmSrc = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  // Every setTimeout should be followed by an unref() call
  const setTimeoutCount = (tmSrc.match(/setTimeout\(/g) || []).length;
  const unrefCount = (tmSrc.match(/\.unref\(\)/g) || []).length;
  assert.ok(unrefCount >= setTimeoutCount,
    `transition-manager.js: every setTimeout must be unref'd (${setTimeoutCount} timers, ${unrefCount} unrefs)`);
});

// ── 4. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_ADAPTIVE_SWITCHING defaulting to false', () => {
  assert.ok(/ENABLE_ADAPTIVE_SWITCHING:\s*false/.test(CONFIG_SRC),
    'ENABLE_ADAPTIVE_SWITCHING must default to false');
});

test('config.js has ADAPTIVE_DEBOUNCE_MS default', () => {
  assert.ok(/ADAPTIVE_DEBOUNCE_MS:\s*200/.test(CONFIG_SRC),
    'ADAPTIVE_DEBOUNCE_MS must default to 200');
});

test('config.js has ADAPTIVE_COOLDOWN_MS default', () => {
  assert.ok(/ADAPTIVE_COOLDOWN_MS:\s*1000/.test(CONFIG_SRC),
    'ADAPTIVE_COOLDOWN_MS must default to 1000');
});

test('config.js has ADAPTIVE_USER_OVERRIDE_PRIORITY default', () => {
  assert.ok(/ADAPTIVE_USER_OVERRIDE_PRIORITY:\s*1000/.test(CONFIG_SRC),
    'ADAPTIVE_USER_OVERRIDE_PRIORITY must default to 1000');
});

test('config.js has schema entries for all new keys', () => {
  for (const key of [
    'ENABLE_ADAPTIVE_SWITCHING', 'ADAPTIVE_DEBOUNCE_MS',
    'ADAPTIVE_COOLDOWN_MS', 'ADAPTIVE_USER_OVERRIDE_PRIORITY',
    'ADAPTIVE_MAX_HISTORY', 'ADAPTIVE_OSCILLATION_WINDOW_MS',
    'ADAPTIVE_OSCILLATION_THRESHOLD',
  ]) {
    assert.ok(CONFIG_SRC.includes(`${key}:`), `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all new keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of [
    'ENABLE_ADAPTIVE_SWITCHING', 'ADAPTIVE_DEBOUNCE_MS',
    'ADAPTIVE_COOLDOWN_MS', 'ADAPTIVE_USER_OVERRIDE_PRIORITY',
    'ADAPTIVE_MAX_HISTORY', 'ADAPTIVE_OSCILLATION_WINDOW_MS',
    'ADAPTIVE_OSCILLATION_THRESHOLD',
  ]) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key), `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 5. Controller isolation ───────────────────────────────────────────

test('adaptive modules do not import detectors/', () => {
  const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTIVE_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/detectors/.test(src),
      `${f}: must NOT import from detectors/ (circular dependency risk)`);
  }
});

test('adaptive modules do not import lib/controllers/', () => {
  const files = fs.readdirSync(ADAPTIVE_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTIVE_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/controllers/.test(src),
      `${f}: must NOT import from lib/controllers/ (loose coupling)`);
  }
});

// ── 6. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates AdaptiveEngine behind ENABLE_ADAPTIVE_SWITCHING', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_ADAPTIVE_SWITCHING/.test(DAEMON_SRC),
    'daemon.js must construct AdaptiveEngine only when ENABLE_ADAPTIVE_SWITCHING is true');
});

test('daemon.js requires ./adaptive lazily', () => {
  assert.ok(/require\(['"]\.\/adaptive['"]\)/.test(DAEMON_SRC),
    'daemon.js must require ./adaptive');
});

test('daemon.js calls adaptiveEngine.destroy in cleanupAndExit', () => {
  assert.ok(/adaptiveEngine\.destroy\(\)/.test(DAEMON_SRC),
    'daemon.js must call adaptiveEngine.destroy() in cleanupAndExit');
});

test('daemon.js calls adaptiveEngine.setConfig on hot-reload', () => {
  assert.ok(/adaptiveEngine\.setConfig\(/.test(DAEMON_SRC),
    'daemon.js must call adaptiveEngine.setConfig() on hot-reload');
});

test('daemon.js registers IPC adaptive handler', () => {
  assert.ok(/registerHandler\(['"]adaptive['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'adaptive'");
});

test('daemon.js registers IPC adaptive-override handler', () => {
  assert.ok(/registerHandler\(['"]adaptive-override['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'adaptive-override'");
});

test('daemon.js exposes adaptiveEngine in getState()', () => {
  assert.ok(/adaptiveEngine:\s*adaptiveEngine/.test(DAEMON_SRC),
    'daemon.js getState() must expose adaptiveEngine');
});

test('daemon.js declares adaptiveEngine state variable', () => {
  assert.ok(/let\s+adaptiveEngine\s*=\s*null/.test(DAEMON_SRC),
    'daemon.js must declare `let adaptiveEngine = null;`');
});

// ── 7. TransitionManager stability guarantees ─────────────────────────

test('TransitionManager has evaluateTransition method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/evaluateTransition\(/.test(src), 'must have evaluateTransition()');
});

test('TransitionManager has recordTransition method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/recordTransition\(/.test(src), 'must have recordTransition()');
});

test('TransitionManager has debounceTransition method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/debounceTransition\(/.test(src), 'must have debounceTransition()');
});

test('TransitionManager has oscillation detection', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/_detectOscillation/.test(src), 'must have _detectOscillation()');
  assert.ok(/oscillation/i.test(src), 'must reference oscillation');
});

test('TransitionManager has cooldown logic', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/cooldown/i.test(src), 'must reference cooldown');
});

test('TransitionManager has rollback support', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/rollback/i.test(src), 'must reference rollback');
  assert.ok(/_rollbackPending/.test(src), 'must track _rollbackPending');
});

test('TransitionManager has bounded history', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'transition-manager.js'), 'utf8');
  assert.ok(/_history/.test(src), 'must have _history');
  assert.ok(/getHistory/.test(src), 'must have getHistory()');
});

// ── 8. AdaptiveEngine rollback + user override ────────────────────────

test('AdaptiveEngine has demandUserOverride method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  assert.ok(/demandUserOverride\(/.test(src), 'must have demandUserOverride()');
});

test('AdaptiveEngine has releaseUserOverride method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  assert.ok(/releaseUserOverride\(/.test(src), 'must have releaseUserOverride()');
});

test('AdaptiveEngine has rollback method', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  assert.ok(/_rollback\(/.test(src), 'must have _rollback() method');
});

test('AdaptiveEngine emits transition events', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  assert.ok(/onProfileTransitionSucceeded/.test(src), 'must emit onProfileTransitionSucceeded');
  assert.ok(/onProfileTransitionFailed/.test(src), 'must emit onProfileTransitionFailed');
});

test('AdaptiveEngine subscribes to detector events', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  assert.ok(/onWorkloadDetected/.test(src), 'must subscribe to onWorkloadDetected');
  assert.ok(/onPowerStateChanged/.test(src), 'must subscribe to onPowerStateChanged');
  assert.ok(/onIdleStateChanged/.test(src), 'must subscribe to onIdleStateChanged');
});

test('AdaptiveEngine never terminates on failed transition', () => {
  const src = fs.readFileSync(path.join(ADAPTIVE_DIR, 'adaptive-engine.js'), 'utf8');
  // The _executeTransition method must have try/catch
  assert.ok(/_executeTransition[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/.test(src),
    '_executeTransition must have try/catch to prevent daemon termination');
});

// ── 9. Behavioral smoke test ──────────────────────────────────────────

test('AdaptiveEngine boots + handles events without throwing', () => {
  const { AdaptiveEngine } = require(ADAPTIVE_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { ProfileManager } = require(path.join(__dirname, '..', 'profiles'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));

  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, ADAPTIVE_DEBOUNCE_MS: 0, ADAPTIVE_COOLDOWN_MS: 0 };
  const bus = new EventBus();
  const rcm = {
    applyThermalProfile: () => ({ success: true }),
    applyPowerProfile: () => ({ success: true }),
    setPpdProfile: () => ({ success: true }),
    setGovernor: () => ({ success: true }),
    getController: () => null,
  };
  const pm = new ProfileManager({ config, bus, rcm });
  pm.setup();
  pm.start();

  const ae = new AdaptiveEngine({ config, bus, profileManager: pm });
  ae.setup();
  ae.start();

  bus.emit('onWorkloadDetected', { workload: 'GAME' });
  assert.strictEqual(ae.activeProfileId, 'gaming');

  ae.demandUserOverride('performance');
  assert.strictEqual(ae.activeProfileId, 'performance');

  ae.releaseUserOverride();
  assert.strictEqual(ae.activeProfileId, 'gaming');

  ae.destroy();
  pm.destroy();
});

test('TransitionManager boots without throwing', () => {
  const { TransitionManager } = require(ADAPTIVE_DIR);
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));
  const tm = new TransitionManager({ config: { ...DEFAULT_CONFIG, DRY_RUN: true } });
  const d = tm.evaluateTransition({ from: 'a', to: 'b' });
  assert.strictEqual(d.allowed, true);
  tm.recordTransition({ from: 'a', to: 'b', success: true });
  assert.strictEqual(tm.getStatus().historySize, 1);
});

// ── 10. Test file exists ──────────────────────────────────────────────

test('test/unit/test-adaptive-switching.js exists', () => {
  const p = path.join(__dirname, '..', 'test', 'unit', 'test-adaptive-switching.js');
  assert.ok(fs.existsSync(p));
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Adaptive Switching safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Adaptive Switching safety regression detected.');
  process.exit(1);
}

process.exit(0);
