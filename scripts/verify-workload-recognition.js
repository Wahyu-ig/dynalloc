'use strict';

/**
 * verify-workload-recognition.js — Safety & architecture validation for
 * the v0.5.0 Phase 5 Workload Recognition & Smart Optimization.
 *
 * Run with: node scripts/verify-workload-recognition.js
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

console.log('Workload Recognition Safety & Architecture Validation');
console.log('='.repeat(60));

const RECOGNITION_DIR = path.join(__dirname, '..', 'recognition');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('recognition/workload-recognizer.js exists', () => {
  assert.ok(fs.existsSync(path.join(RECOGNITION_DIR, 'workload-recognizer.js')));
});

test('recognition/optimization-strategies.js exists', () => {
  assert.ok(fs.existsSync(path.join(RECOGNITION_DIR, 'optimization-strategies.js')));
});

test('recognition/recognition-engine.js exists', () => {
  assert.ok(fs.existsSync(path.join(RECOGNITION_DIR, 'recognition-engine.js')));
});

test('recognition/index.js exists', () => {
  assert.ok(fs.existsSync(path.join(RECOGNITION_DIR, 'index.js')));
});

test('recognition/index.js exports documented API', () => {
  const idx = require(RECOGNITION_DIR);
  assert.strictEqual(typeof idx.WorkloadRecognizer, 'function');
  assert.strictEqual(typeof idx.RecognitionEngine, 'function');
  assert.ok(idx.OPTIMIZATION_STRATEGIES);
  assert.strictEqual(typeof idx.getStrategy, 'function');
  assert.strictEqual(typeof idx.getWorkloadCategories, 'function');
});

// ── 2. No syscalls in recognition modules ─────────────────────────────

test('recognition modules never call exec/execFile/spawn', () => {
  const files = fs.readdirSync(RECOGNITION_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECOGNITION_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src),
      `${f}: must NOT require child_process`);
    assert.ok(!/\bexecFile\b/.test(src), `${f}: must NOT call execFile`);
    assert.ok(!/\bspawn\b/.test(src), `${f}: must NOT call spawn`);
  }
});

test('recognition modules never write to sysfs/proc', () => {
  const files = fs.readdirSync(RECOGNITION_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECOGNITION_DIR, f), 'utf8');
    assert.ok(!/writeFileSync\(['"`]\/(sys|proc)/.test(src),
      `${f}: must NOT writeFileSync to /sys or /proc`);
  }
});

// ── 3. No polling loops ───────────────────────────────────────────────

test('recognition modules use no setInterval (no polling)', () => {
  const files = fs.readdirSync(RECOGNITION_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECOGNITION_DIR, f), 'utf8');
    assert.ok(!/setInterval\(/.test(src),
      `${f}: must NOT use setInterval (no polling)`);
  }
});

test('recognition modules unref all setTimeout calls', () => {
  const src = fs.readFileSync(path.join(RECOGNITION_DIR, 'recognition-engine.js'), 'utf8');
  const setTimeoutCount = (src.match(/setTimeout\(/g) || []).length;
  const unrefCount = (src.match(/\.unref\(\)/g) || []).length;
  assert.ok(unrefCount >= setTimeoutCount,
    `recognition-engine.js: every setTimeout must be unref'd (${setTimeoutCount} timers, ${unrefCount} unrefs)`);
});

// ── 4. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_WORKLOAD_RECOGNITION defaulting to false', () => {
  assert.ok(/ENABLE_WORKLOAD_RECOGNITION:\s*false/.test(CONFIG_SRC),
    'ENABLE_WORKLOAD_RECOGNITION must default to false');
});

test('config.js has RECOGNITION_CONFIDENCE_THRESHOLD default', () => {
  assert.ok(/RECOGNITION_CONFIDENCE_THRESHOLD:\s*0\.60/.test(CONFIG_SRC),
    'RECOGNITION_CONFIDENCE_THRESHOLD must default to 0.60');
});

test('config.js has RECOGNITION_DEBOUNCE_MS default', () => {
  assert.ok(/RECOGNITION_DEBOUNCE_MS:\s*300/.test(CONFIG_SRC),
    'RECOGNITION_DEBOUNCE_MS must default to 300');
});

test('config.js has schema entries for all new keys', () => {
  for (const key of ['ENABLE_WORKLOAD_RECOGNITION', 'RECOGNITION_CONFIDENCE_THRESHOLD', 'RECOGNITION_DEBOUNCE_MS']) {
    assert.ok(CONFIG_SRC.includes(`${key}:`), `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all new keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of ['ENABLE_WORKLOAD_RECOGNITION', 'RECOGNITION_CONFIDENCE_THRESHOLD', 'RECOGNITION_DEBOUNCE_MS']) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key), `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 5. Controller isolation ───────────────────────────────────────────

test('recognition modules do not import detectors/', () => {
  const files = fs.readdirSync(RECOGNITION_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECOGNITION_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/detectors/.test(src),
      `${f}: must NOT import from detectors/ (circular dependency risk)`);
  }
});

test('recognition modules do not import adaptive/', () => {
  const files = fs.readdirSync(RECOGNITION_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECOGNITION_DIR, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/adaptive/.test(src),
      `${f}: must NOT import from adaptive/ (circular dependency risk)`);
  }
});

// ── 6. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates RecognitionEngine behind ENABLE_WORKLOAD_RECOGNITION', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_WORKLOAD_RECOGNITION/.test(DAEMON_SRC),
    'daemon.js must construct RecognitionEngine only when ENABLE_WORKLOAD_RECOGNITION is true');
});

test('daemon.js requires ./recognition lazily', () => {
  assert.ok(/require\(['"]\.\/recognition['"]\)/.test(DAEMON_SRC),
    'daemon.js must require ./recognition');
});

test('daemon.js calls recognitionEngine.destroy in cleanupAndExit', () => {
  assert.ok(/recognitionEngine\.destroy\(\)/.test(DAEMON_SRC),
    'daemon.js must call recognitionEngine.destroy() in cleanupAndExit');
});

test('daemon.js calls recognitionEngine.setConfig on hot-reload', () => {
  assert.ok(/recognitionEngine\.setConfig\(/.test(DAEMON_SRC),
    'daemon.js must call recognitionEngine.setConfig() on hot-reload');
});

test('daemon.js registers IPC recognition handler', () => {
  assert.ok(/registerHandler\(['"]recognition['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'recognition'");
});

test('daemon.js exposes recognitionEngine in getState()', () => {
  assert.ok(/recognitionEngine:\s*recognitionEngine/.test(DAEMON_SRC),
    'daemon.js getState() must expose recognitionEngine');
});

test('daemon.js declares recognitionEngine state variable', () => {
  assert.ok(/let\s+recognitionEngine\s*=\s*null/.test(DAEMON_SRC),
    'daemon.js must declare `let recognitionEngine = null;`');
});

// ── 7. 14 workload categories ─────────────────────────────────────────

test('14 workload categories defined', () => {
  const { getWorkloadCategories } = require(RECOGNITION_DIR);
  assert.strictEqual(getWorkloadCategories().length, 14);
});

test('all expected categories present', () => {
  const { getWorkloadCategories } = require(RECOGNITION_DIR);
  const cats = getWorkloadCategories();
  for (const expected of [
    'gaming', 'development', 'web-browsing', 'office-productivity',
    'video-editing', 'audio-production', '3d-rendering', 'streaming',
    'virtual-machines', 'containers', 'ai-ml', 'file-compression',
    'idle', 'background-tasks',
  ]) {
    assert.ok(cats.includes(expected), `missing category: ${expected}`);
  }
});

// ── 8. Confidence model ───────────────────────────────────────────────

test('WorkloadRecognizer has confidence threshold', () => {
  const src = fs.readFileSync(path.join(RECOGNITION_DIR, 'workload-recognizer.js'), 'utf8');
  assert.ok(/CONFIDENCE_THRESHOLD/i.test(src), 'must reference confidence threshold');
  assert.ok(/_getConfidenceThreshold/.test(src), 'must have _getConfidenceThreshold()');
});

test('WorkloadRecognizer WEIGHTS defined', () => {
  const src = fs.readFileSync(path.join(RECOGNITION_DIR, 'workload-recognizer.js'), 'utf8');
  assert.ok(/WEIGHTS/.test(src), 'must define WEIGHTS');
  assert.ok(/PROCESS_NAME/.test(src), 'must have PROCESS_NAME weight');
  assert.ok(/CPU_PATTERN/.test(src), 'must have CPU_PATTERN weight');
  assert.ok(/GPU_PATTERN/.test(src), 'must have GPU_PATTERN weight');
});

test('WorkloadRecognizer registerRule for plugin extensibility', () => {
  const src = fs.readFileSync(path.join(RECOGNITION_DIR, 'workload-recognizer.js'), 'utf8');
  assert.ok(/registerRule\(/.test(src), 'must have registerRule()');
  assert.ok(/unregisterRule\(/.test(src), 'must have unregisterRule()');
});

// ── 9. Behavioral smoke test ──────────────────────────────────────────

test('RecognitionEngine boots + recognizes workload without throwing', () => {
  const { RecognitionEngine } = require(RECOGNITION_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { ProfileManager } = require(path.join(__dirname, '..', 'profiles'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));

  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, RECOGNITION_DEBOUNCE_MS: 0 };
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

  const engine = new RecognitionEngine({ config, bus, profileManager: pm });
  engine.setup();
  engine.start();

  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.strictEqual(engine.demandedProfile, 'gaming');

  engine.destroy();
  pm.destroy();
});

test('RecognitionEngine respects confidence threshold', () => {
  const { RecognitionEngine } = require(RECOGNITION_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { ProfileManager } = require(path.join(__dirname, '..', 'profiles'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));

  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, RECOGNITION_DEBOUNCE_MS: 0, RECOGNITION_CONFIDENCE_THRESHOLD: 0.99 };
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

  const engine = new RecognitionEngine({ config, bus, profileManager: pm });
  engine.setup();
  engine.start();

  // Gaming without GPU → confidence ~0.50 < 0.99 → no demand
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.strictEqual(engine.demandedProfile, null);

  engine.destroy();
  pm.destroy();
});

// ── 10. Test file exists ──────────────────────────────────────────────

test('test/unit/test-workload-recognition.js exists', () => {
  const p = path.join(__dirname, '..', 'test', 'unit', 'test-workload-recognition.js');
  assert.ok(fs.existsSync(p));
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Workload Recognition safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Workload Recognition safety regression detected.');
  process.exit(1);
}

process.exit(0);
