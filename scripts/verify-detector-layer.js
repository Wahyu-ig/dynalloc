'use strict';

/**
 * verify-detector-layer.js — Safety & architecture validation for the
 * v0.5.0 Phase 1 Detector Layer.
 *
 * Run with: node scripts/verify-detector-layer.js
 *
 * This script performs source-text and behavioral checks to confirm:
 *
 *   1. Module structure — all expected files exist and export the
 *      documented API surface.
 *   2. No system mutation — detectors NEVER call exec, execFile,
 *      writeFileSync on sysfs, or any actuator method. They are
 *      purely observational.
 *   3. No shell invocation — no exec/spawn with shell strings.
 *   4. Backward compatibility — ENABLE_DETECTOR_LAYER defaults to
 *      false in config.js, and daemon.js gates all detector code
 *      behind that flag.
 *   5. Bus isolation — DetectorManager uses an isolated bus when
 *      PE is disabled (does not pollute the global bus).
 *   6. Config schema — all DETECTOR_* keys have schema entries and
 *      are hot-reloadable.
 *   7. Daemon integration — detectorMgr is constructed only when
 *      the flag is true, and destroyed on shutdown.
 *   8. IPC handler — the `detectors` handler is registered.
 *
 * If this script fails, the Detector Layer has a safety regression.
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

console.log('Detector Layer Safety & Architecture Validation');
console.log('='.repeat(60));

const DETECTORS_DIR = path.join(__dirname, '..', 'detectors');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── 1. Module structure ───────────────────────────────────────────────

test('detectors/base-detector.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'base-detector.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/detection-context.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'detection-context.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/detector-manager.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'detector-manager.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/workload-detector.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'workload-detector.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/power-state-detector.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'power-state-detector.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/idle-state-detector.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'idle-state-detector.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/index.js exists', () => {
  const p = path.join(DETECTORS_DIR, 'index.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

test('detectors/index.js exports the documented API surface', () => {
  const index = require(path.join(DETECTORS_DIR, 'index.js'));
  for (const name of [
    'DetectorManager', 'DetectionContext', 'BaseDetector',
    'WorkloadDetector', 'PowerStateDetector', 'IdleStateDetector',
    'createBuiltinDetectors',
  ]) {
    assert.ok(index[name] !== undefined, `index.js must export ${name}`);
  }
});

// ── 2. No system mutation ─────────────────────────────────────────────

test('detectors never call child_process.exec / execSync (shell)', () => {
  const files = fs.readdirSync(DETECTORS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DETECTORS_DIR, f), 'utf8');
    // Forbidden: exec() with shell string
    assert.ok(!/[^.]exec\(['"`]/.test(src),
      `${f}: must NOT use exec() with shell string`);
    assert.ok(!/execSync\(['"`]/.test(src),
      `${f}: must NOT use execSync() with shell string`);
  }
});

test('detectors never call execFile / execFileSync (no syscall)', () => {
  // The detector layer is purely observational — it should never
  // spawn subprocesses. Sensor reads are done by the daemon and
  // passed in via DetectionContext.
  const files = fs.readdirSync(DETECTORS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DETECTORS_DIR, f), 'utf8');
    assert.ok(!src.includes('execFile'),
      `${f}: must NOT call execFile (detectors are observational)`);
    assert.ok(!src.includes('execFileSync'),
      `${f}: must NOT call execFileSync (detectors are observational)`);
  }
});

test('detectors never write to sysfs/proc', () => {
  const files = fs.readdirSync(DETECTORS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DETECTORS_DIR, f), 'utf8');
    // Forbidden: writeFileSync on /sys or /proc
    assert.ok(!/writeFileSync\(['"`]\/(sys|proc)/.test(src),
      `${f}: must NOT writeFileSync to /sys or /proc`);
    // Forbidden: any actuator method call (detectors don't actuate)
    assert.ok(!/actuator\./.test(src),
      `${f}: must NOT reference actuator (detectors don't actuate)`);
  }
});

test('detectors never spawn processes', () => {
  const files = fs.readdirSync(DETECTORS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DETECTORS_DIR, f), 'utf8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(src),
      `${f}: must NOT require child_process (detectors don't spawn)`);
    assert.ok(!/\bspawn\b/.test(src),
      `${f}: must NOT use spawn()`);
  }
});

// ── 3. Backward compatibility ─────────────────────────────────────────

test('config.js has ENABLE_DETECTOR_LAYER defaulting to false', () => {
  assert.ok(/ENABLE_DETECTOR_LAYER:\s*false/.test(CONFIG_SRC),
    'ENABLE_DETECTOR_LAYER must default to false');
});

test('config.js has DETECTOR_IDLE_THRESHOLD_TICKS default', () => {
  assert.ok(/DETECTOR_IDLE_THRESHOLD_TICKS:\s*30/.test(CONFIG_SRC),
    'DETECTOR_IDLE_THRESHOLD_TICKS must default to 30');
});

test('config.js has DETECTOR_IDLE_CPU_PRESSURE_MAX default', () => {
  assert.ok(/DETECTOR_IDLE_CPU_PRESSURE_MAX:\s*2\.0/.test(CONFIG_SRC),
    'DETECTOR_IDLE_CPU_PRESSURE_MAX must default to 2.0');
});

test('config.js has DETECTOR_IDLE_NET_RX_KBPS_MAX default', () => {
  assert.ok(/DETECTOR_IDLE_NET_RX_KBPS_MAX:\s*5/.test(CONFIG_SRC),
    'DETECTOR_IDLE_NET_RX_KBPS_MAX must default to 5');
});

test('config.js has schema entries for all DETECTOR_* keys', () => {
  for (const key of [
    'ENABLE_DETECTOR_LAYER',
    'DETECTOR_IDLE_THRESHOLD_TICKS',
    'DETECTOR_IDLE_CPU_PRESSURE_MAX',
    'DETECTOR_IDLE_NET_RX_KBPS_MAX',
  ]) {
    assert.ok(CONFIG_SRC.includes(`${key}:`),
      `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all DETECTOR_* keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of [
    'ENABLE_DETECTOR_LAYER',
    'DETECTOR_IDLE_THRESHOLD_TICKS',
    'DETECTOR_IDLE_CPU_PRESSURE_MAX',
    'DETECTOR_IDLE_NET_RX_KBPS_MAX',
  ]) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key),
      `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 4. Daemon integration ─────────────────────────────────────────────

test('daemon.js gates DetectorManager behind ENABLE_DETECTOR_LAYER', () => {
  assert.ok(/if\s*\(CONFIG\.ENABLE_DETECTOR_LAYER\)/.test(DAEMON_SRC),
    'daemon.js must construct DetectorManager only when ENABLE_DETECTOR_LAYER is true');
});

test('daemon.js requires ./detectors lazily', () => {
  assert.ok(/require\(['"]\.\/detectors['"]\)/.test(DAEMON_SRC),
    'daemon.js must require ./detectors (lazily, inside the if block)');
});

test('daemon.js calls detectorMgr.tick in fastTick', () => {
  assert.ok(/detectorMgr\.tick\(/.test(DAEMON_SRC),
    'daemon.js must call detectorMgr.tick() in the tick loop');
});

test('daemon.js calls detectorMgr.setConfig on hot-reload', () => {
  assert.ok(/detectorMgr\.setConfig\(/.test(DAEMON_SRC),
    'daemon.js must call detectorMgr.setConfig() on hot-reload');
});

test('daemon.js calls detectorMgr.destroy in cleanupAndExit', () => {
  assert.ok(/detectorMgr\.destroy\(\)/.test(DAEMON_SRC),
    'daemon.js must call detectorMgr.destroy() in cleanupAndExit');
});

test('daemon.js registers IPC detectors handler', () => {
  assert.ok(/registerHandler\(['"]detectors['"]/.test(DAEMON_SRC),
    "daemon.js must register IPC handler for 'detectors'");
});

test('daemon.js exposes detectorLayer in getState()', () => {
  assert.ok(/detectorLayer:\s*detectorMgr/.test(DAEMON_SRC),
    "daemon.js getState() must expose detectorLayer");
});

test('daemon.js declares detectorMgr state variable', () => {
  assert.ok(/let\s+detectorMgr\s*=\s*null/.test(DAEMON_SRC),
    'daemon.js must declare `let detectorMgr = null;`');
});

// ── 5. Bus isolation ──────────────────────────────────────────────────

test('DetectorManager creates isolated bus when none provided', () => {
  const mgrSrc = fs.readFileSync(path.join(DETECTORS_DIR, 'detector-manager.js'), 'utf8');
  assert.ok(/new _EventBusClass\(\)|new EventBus\(\)/.test(mgrSrc),
    'DetectorManager must create an isolated EventBus when no bus is passed');
  assert.ok(/_ownsBus/.test(mgrSrc),
    'DetectorManager must track bus ownership (_ownsBus)');
});

test('DetectorManager.destroy only destroys owned bus', () => {
  const mgrSrc = fs.readFileSync(path.join(DETECTORS_DIR, 'detector-manager.js'), 'utf8');
  assert.ok(/if\s*\(this\._ownsBus/.test(mgrSrc),
    'DetectorManager.destroy() must check _ownsBus before destroying the bus');
});

// ── 6. DetectionContext immutability ──────────────────────────────────

test('DetectionContext freezes itself after construction', () => {
  const ctxSrc = fs.readFileSync(path.join(DETECTORS_DIR, 'detection-context.js'), 'utf8');
  assert.ok(/Object\.freeze\(this\)/.test(ctxSrc),
    'DetectionContext must call Object.freeze(this) at end of constructor');
});

test('DetectionContext freezes the battery sub-object', () => {
  const ctxSrc = fs.readFileSync(path.join(DETECTORS_DIR, 'detection-context.js'), 'utf8');
  assert.ok(/Object\.freeze\(\{\s*\.\.\.fields\.battery/.test(ctxSrc) ||
            /Object\.freeze\(\{[^}]*onBattery/.test(ctxSrc),
    'DetectionContext must freeze the battery sub-object');
});

// ── 7. Behavioral: end-to-end smoke test ──────────────────────────────

test('DetectorManager + built-in detectors boot without errors', () => {
  const { DetectorManager, createBuiltinDetectors } = require(DETECTORS_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { StateStore } = require(path.join(__dirname, '..', 'policy-engine', 'state-store.js'));
  const logger = require(path.join(__dirname, '..', 'logger.js'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));

  const config = { ...DEFAULT_CONFIG, DRY_RUN: true };
  const bus = new EventBus();
  const stateStore = new StateStore();
  const mgr = new DetectorManager({ config, bus, stateStore });
  const detectors = createBuiltinDetectors({ config, logger, bus, stateStore, metrics: null });
  for (const d of detectors) mgr.register(d);
  mgr.setupAll();
  mgr.startAll();
  assert.strictEqual(mgr.size, 3);
  mgr.destroy();
});

test('DetectorManager handles a full tick without throwing', () => {
  const { DetectorManager, createBuiltinDetectors, DetectionContext } = require(DETECTORS_DIR);
  const { EventBus } = require(path.join(__dirname, '..', 'policy-engine', 'event-bus.js'));
  const { StateStore } = require(path.join(__dirname, '..', 'policy-engine', 'state-store.js'));
  const logger = require(path.join(__dirname, '..', 'logger.js'));
  const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'config.js'));

  const config = { ...DEFAULT_CONFIG, DRY_RUN: true };
  const bus = new EventBus();
  const stateStore = new StateStore();
  const mgr = new DetectorManager({ config, bus, stateStore });
  const detectors = createBuiltinDetectors({ config, logger, bus, stateStore, metrics: null });
  for (const d of detectors) mgr.register(d);
  mgr.setupAll();
  mgr.startAll();

  // Run a tick with realistic data
  const result = mgr.tick({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '/usr/bin/firefox' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
    battery: { onBattery: true, capacity: 80 },
    cpuPressure: 1.0,
    networkRxKbps: 1,
    stressLevel: 'NORMAL',
  });
  assert.ok(result instanceof Map);
  assert.ok(result.size >= 1, 'expected at least one detector to produce a detection');
  mgr.destroy();
});

// ── 8. No shell metacharacter injection surface ───────────────────────

test('detector files contain no template-string command interpolation', () => {
  // Detectors should not construct commands at all, but defense in depth:
  // ensure no `${...}` interpolation inside any string that looks like a
  // command path.
  const files = fs.readdirSync(DETECTORS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DETECTORS_DIR, f), 'utf8');
    // Look for patterns like `exec(`...${...}...`)` — none should exist.
    assert.ok(!/exec\([^)]*\$\{/.test(src),
      `${f}: must not interpolate variables into exec() calls`);
  }
});

// ── 9. Test file exists ───────────────────────────────────────────────

test('test/unit/test-detector-layer.js exists', () => {
  const p = path.join(__dirname, '..', 'test', 'unit', 'test-detector-layer.js');
  assert.ok(fs.existsSync(p), `expected ${p} to exist`);
});

// ── Summary ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Detector Layer safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Detector Layer safety regression detected.');
  process.exit(1);
}

process.exit(0);
