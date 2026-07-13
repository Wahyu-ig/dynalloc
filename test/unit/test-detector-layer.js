'use strict';

/**
 * test-detector-layer.js — Unit tests for the v0.5.0 Phase 1 Detector Layer.
 *
 * Run with: node --test test/unit/test-detector-layer.js
 *
 * Covers:
 *   - BaseDetector interface contract
 *   - DetectionContext immutability and field handling
 *   - DetectorManager register/unregister/lifecycle
 *   - DetectorManager tick + aggregation
 *   - WorkloadDetector classification mapping + hysteresis
 *   - PowerStateDetector state transitions
 *   - IdleStateDetector state machine
 *   - Bus event emission
 *
 * All tests are pure — no real syscalls, no real bus, no real sensors.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BaseDetector = require(path.join(__dirname, '..', '..', 'detectors', 'base-detector.js'));
const { DetectionContext } = require(path.join(__dirname, '..', '..', 'detectors', 'detection-context.js'));
const { DetectorManager } = require(path.join(__dirname, '..', '..', 'detectors', 'detector-manager.js'));
const WorkloadDetector = require(path.join(__dirname, '..', '..', 'detectors', 'workload-detector.js'));
const PowerStateDetector = require(path.join(__dirname, '..', '..', 'detectors', 'power-state-detector.js'));
const IdleStateDetector = require(path.join(__dirname, '..', '..', 'detectors', 'idle-state-detector.js'));
const detectorIndex = require(path.join(__dirname, '..', '..', 'detectors'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));

// ── Test helpers ──────────────────────────────────────────────────────

function makeConfig(overrides) {
  return { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
}

function makeDeps(overrides) {
  const config = makeConfig(overrides && overrides.config);
  const logger = require(path.join(__dirname, '..', '..', 'logger.js'));
  const { EventBus } = require(path.join(__dirname, '..', '..', 'policy-engine', 'event-bus.js'));
  const { StateStore } = require(path.join(__dirname, '..', '..', 'policy-engine', 'state-store.js'));
  const bus = (overrides && overrides.bus) || new EventBus();
  const stateStore = (overrides && overrides.stateStore) || new StateStore();
  return { config, logger, bus, stateStore, metrics: null };
}

function makeContext(fields) {
  return new DetectionContext(fields || {});
}

// ── BaseDetector ──────────────────────────────────────────────────────

test('BaseDetector requires a non-empty name', () => {
  assert.throws(() => new BaseDetector('', {}), TypeError);
  assert.throws(() => new BaseDetector(null, {}), TypeError);
});

test('BaseDetector requires deps object', () => {
  assert.throws(() => new BaseDetector('test', null), TypeError);
  assert.throws(() => new BaseDetector('test', 'string'), TypeError);
});

test('BaseDetector default lifecycle is no-op + isAvailable true', () => {
  const d = new BaseDetector('test', makeDeps());
  assert.strictEqual(d.isAvailable(), true);
  assert.strictEqual(d.isRunning, false);
  d.start();
  assert.strictEqual(d.isRunning, true);
  d.stop();
  assert.strictEqual(d.isRunning, false);
});

test('BaseDetector detect() returns empty array by default', () => {
  const d = new BaseDetector('test', makeDeps());
  const result = d.detect(makeContext());
  assert.deepStrictEqual(result, []);
});

test('BaseDetector getStatus returns name + available + running', () => {
  const d = new BaseDetector('test', makeDeps());
  const s = d.getStatus();
  assert.strictEqual(s.name, 'test');
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.running, false);
});

test('BaseDetector setConfig updates deps.config', () => {
  const d = new BaseDetector('test', makeDeps());
  const newConfig = { ...DEFAULT_CONFIG, FOO: 'bar' };
  d.setConfig(newConfig);
  assert.strictEqual(d.config, newConfig);
});

test('BaseDetector destroy is idempotent', () => {
  const d = new BaseDetector('test', makeDeps());
  d.destroy();
  d.destroy();  // should not throw
  assert.strictEqual(d._destroyed, true);
});

// ── DetectionContext ──────────────────────────────────────────────────

test('DetectionContext defaults to safe values when fields missing', () => {
  const ctx = new DetectionContext();
  assert.strictEqual(ctx.foregroundPid, null);
  assert.strictEqual(ctx.foregroundInfo, null);
  assert.deepStrictEqual(ctx.procs, []);
  assert.strictEqual(ctx.procs.length, 0);
  assert.ok(ctx.mediaPids instanceof Set);
  assert.strictEqual(ctx.mediaPids.size, 0);
  assert.strictEqual(ctx.stressLevel, 'NORMAL');
  assert.strictEqual(ctx.cpuPressure, 0);
  assert.strictEqual(ctx.memPressure, 0);
  assert.strictEqual(ctx.thermalTemp, null);
  assert.strictEqual(ctx.gpuUtilization, null);
  assert.strictEqual(ctx.battery, null);
  assert.strictEqual(ctx.onBattery, false);
});

test('DetectionContext is frozen (immutable)', () => {
  const ctx = new DetectionContext({ foregroundPid: 1234 });
  assert.ok(Object.isFrozen(ctx));
  assert.throws(() => { ctx.foregroundPid = 9999; }, TypeError);
});

test('DetectionContext findProc returns matching process', () => {
  const procs = [
    { pid: 1, ppid: 0, pcpu: 0, comm: 'init' },
    { pid: 100, ppid: 1, pcpu: 5.0, comm: 'firefox' },
  ];
  const ctx = new DetectionContext({ procs });
  assert.strictEqual(ctx.findProc(100).comm, 'firefox');
  assert.strictEqual(ctx.findProc(999), null);
  assert.strictEqual(ctx.findProc(-1), null);
});

test('DetectionContext findProcByComm returns matching process', () => {
  const procs = [{ pid: 100, ppid: 1, pcpu: 5, comm: 'firefox' }];
  const ctx = new DetectionContext({ procs });
  assert.strictEqual(ctx.findProcByComm('firefox').pid, 100);
  assert.strictEqual(ctx.findProcByComm('chrome'), null);
  assert.strictEqual(ctx.findProcByComm(''), null);
});

test('DetectionContext foregroundIn checks if foreground PID is in set', () => {
  const ctx = new DetectionContext({ foregroundPid: 1234 });
  const set = new Set([1234, 5678]);
  assert.strictEqual(ctx.foregroundIn(set), true);
  assert.strictEqual(ctx.foregroundIn(new Set([5678])), false);
  assert.strictEqual(ctx.foregroundIn(new Set()), false);
});

test('DetectionContext rejects invalid stressLevel', () => {
  const ctx = new DetectionContext({ stressLevel: 'INVALID' });
  assert.strictEqual(ctx.stressLevel, 'NORMAL');
});

test('DetectionContext battery is frozen sub-object', () => {
  const ctx = new DetectionContext({
    battery: { onBattery: true, capacity: 50 },
  });
  assert.ok(Object.isFrozen(ctx.battery));
  assert.throws(() => { ctx.battery.capacity = 99; }, TypeError);
});

// ── DetectorManager ───────────────────────────────────────────────────

test('DetectorManager requires opts.config', () => {
  assert.throws(() => new DetectorManager({}), TypeError);
  assert.throws(() => new DetectorManager(), TypeError);
});

test('DetectorManager creates isolated bus when none provided', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  assert.ok(mgr.bus);
  assert.strictEqual(mgr._ownsBus, true);
  mgr.destroy();
});

test('DetectorManager uses provided bus without owning it', () => {
  const { EventBus } = require(path.join(__dirname, '..', '..', 'policy-engine', 'event-bus.js'));
  const bus = new EventBus();
  const mgr = new DetectorManager({ config: makeConfig(), bus });
  assert.strictEqual(mgr.bus, bus);
  assert.strictEqual(mgr._ownsBus, false);
  mgr.destroy();
  // Bus is not destroyed because manager doesn't own it.
  // (We can't easily assert this without spying on destroy(); the
  // contract is documented in the source.)
});

test('DetectorManager rejects invalid detector names', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();
  // Valid name — accepted
  assert.strictEqual(mgr.register(new BaseDetector('workload', deps)), true);
  // BaseDetector constructor throws on empty/null name
  assert.throws(() => new BaseDetector('', deps), TypeError);
  assert.throws(() => new BaseDetector(null, deps), TypeError);
  // Kebab-case pattern validation is in DetectorManager.register()
  // (constructor accepts any non-empty string; manager enforces naming)
  assert.strictEqual(mgr.register(new BaseDetector('MyDetector', deps)), false);
  assert.strictEqual(mgr.register(new BaseDetector('1foo', deps)), false);
  assert.strictEqual(mgr.register(new BaseDetector('a'.repeat(32), deps)), false);
  // Duplicate name
  assert.strictEqual(mgr.register(new BaseDetector('workload', deps)), false);
  mgr.destroy();
});

test('DetectorManager rejects detector without detect()', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const fake = { name: 'fake' };  // no detect()
  assert.strictEqual(mgr.register(fake), false);
  mgr.destroy();
});

test('DetectorManager setupAll/startAll/stopAll/destroy lifecycle', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();
  mgr.register(new BaseDetector('a', deps));
  mgr.register(new BaseDetector('b', deps));
  mgr.setupAll();
  mgr.startAll();
  assert.strictEqual(mgr.size, 2);
  mgr.stopAll();
  mgr.destroy();
  assert.strictEqual(mgr.size, 0);
});

test('DetectorManager.tick returns empty map when not started', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const result = mgr.tick({});
  assert.ok(result instanceof Map);
  assert.strictEqual(result.size, 0);
  mgr.destroy();
});

test('DetectorManager.tick runs all available detectors', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();

  // Custom detector that returns one detection
  class TestDetector extends BaseDetector {
    constructor(d) { super('test', d); this._count = 0; }
    detect(ctx) {
      this._count++;
      return [{
        detector: 'test',
        domain: 'test',
        classification: 'TEST',
        confidence: 1.0,
        payload: { count: this._count },
        timestamp: new Date().toISOString(),
      }];
    }
  }

  mgr.register(new TestDetector(deps));
  mgr.startAll();
  const result = mgr.tick({ foregroundPid: 1234 });
  assert.strictEqual(result.size, 1);
  assert.ok(result.has('test'));
  assert.strictEqual(result.get('test').length, 1);
  assert.strictEqual(result.get('test')[0].classification, 'TEST');
  mgr.destroy();
});

test('DetectorManager.tick skips unavailable detectors', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();

  class UnavailableDetector extends BaseDetector {
    constructor(d) { super('unavail', d); }
    isAvailable() { return false; }
    detect() { throw new Error('should not be called'); }
  }

  mgr.register(new UnavailableDetector(deps));
  mgr.startAll();
  const result = mgr.tick({});
  assert.strictEqual(result.size, 0);
  mgr.destroy();
});

test('DetectorManager.tick isolates detector errors', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();

  class ThrowingDetector extends BaseDetector {
    constructor(d) { super('throwing', d); }
    detect() { throw new Error('boom'); }
  }
  class OkDetector extends BaseDetector {
    constructor(d) { super('ok', d); }
    detect() {
      return [{
        detector: 'ok', domain: 'ok', classification: 'OK',
        confidence: 1.0, payload: {}, timestamp: new Date().toISOString(),
      }];
    }
  }

  mgr.register(new ThrowingDetector(deps));
  mgr.register(new OkDetector(deps));
  mgr.startAll();
  const result = mgr.tick({});
  // Throwing detector's error is caught; ok detector still runs.
  assert.strictEqual(result.size, 2);
  assert.strictEqual(result.get('throwing').length, 0);
  assert.strictEqual(result.get('ok').length, 1);
  mgr.destroy();
});

test('DetectorManager.setConfig propagates to all detectors', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();
  const d1 = new BaseDetector('a', deps);
  const d2 = new BaseDetector('b', deps);
  mgr.register(d1);
  mgr.register(d2);
  const newConfig = { ...DEFAULT_CONFIG, BATTERY_LOW_THRESHOLD: 99 };
  mgr.setConfig(newConfig);
  assert.strictEqual(d1.config, newConfig);
  assert.strictEqual(d2.config, newConfig);
  mgr.destroy();
});

test('DetectorManager.getStatus returns snapshot', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();
  mgr.register(new BaseDetector('a', deps));
  mgr.startAll();
  mgr.tick({});
  const status = mgr.getStatus();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.detectorCount, 1);
  assert.strictEqual(status.tickCount, 1);
  assert.ok(Array.isArray(status.detectors));
  assert.strictEqual(status.detectors[0].name, 'a');
  mgr.destroy();
});

test('DetectorManager.getLastDetections returns per-detector results', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();

  class FixedDetector extends BaseDetector {
    constructor(d) { super('fixed', d); }
    detect() {
      return [{
        detector: 'fixed', domain: 'd', classification: 'C',
        confidence: 1.0, payload: {}, timestamp: new Date().toISOString(),
      }];
    }
  }
  mgr.register(new FixedDetector(deps));
  mgr.startAll();
  mgr.tick({});
  const last = mgr.getLastDetections('fixed');
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].classification, 'C');
  const all = mgr.getLastDetections();
  assert.ok(all instanceof Map);
  assert.ok(all.has('fixed'));
  mgr.destroy();
});

// ── WorkloadDetector ──────────────────────────────────────────────────

test('WorkloadDetector classifies firefox as BROWSER', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '/usr/bin/firefox' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'BROWSER');
  assert.strictEqual(result[0].confidence, 0.95);
  assert.strictEqual(result[0].payload.comm, 'firefox');
  d.destroy();
});

test('WorkloadDetector classifies UnityPlayer as GAME', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 100,
    foregroundInfo: { pid: 100, comm: 'UnityPlayer', cmdline: '' },
    procs: [{ pid: 100, ppid: 1, pcpu: 30, comm: 'UnityPlayer' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'GAME');
  d.destroy();
});

test('WorkloadDetector classifies code (VS Code) as IDE', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 200,
    foregroundInfo: { pid: 200, comm: 'code', cmdline: '/usr/bin/code' },
    procs: [{ pid: 200, ppid: 1, pcpu: 2, comm: 'code' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'IDE');
  d.destroy();
});

test('WorkloadDetector classifies obs as RENDERER', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 300,
    foregroundInfo: { pid: 300, comm: 'obs', cmdline: '' },
    procs: [{ pid: 300, ppid: 1, pcpu: 15, comm: 'obs' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'RENDERER');
  d.destroy();
});

test('WorkloadDetector classifies qemu-system as VIRTUALIZATION', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 400,
    foregroundInfo: { pid: 400, comm: 'qemu-system-x86_64', cmdline: '' },
    procs: [{ pid: 400, ppid: 1, pcpu: 50, comm: 'qemu-system-x86_64' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'VIRTUALIZATION');
  d.destroy();
});

test('WorkloadDetector classifies rustc as COMPILER', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 500,
    foregroundInfo: { pid: 500, comm: 'rustc', cmdline: '' },
    procs: [{ pid: 500, ppid: 1, pcpu: 90, comm: 'rustc' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'COMPILER');
  d.destroy();
});

test('WorkloadDetector classifies mpv as MULTIMEDIA', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 600,
    foregroundInfo: { pid: 600, comm: 'mpv', cmdline: '' },
    procs: [{ pid: 600, ppid: 1, pcpu: 3, comm: 'mpv' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'MULTIMEDIA');
  d.destroy();
});

test('WorkloadDetector classifies unknown comm as UNKNOWN with low confidence', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 700,
    foregroundInfo: { pid: 700, comm: 'totally-unknown-app', cmdline: '' },
    procs: [{ pid: 700, ppid: 1, pcpu: 5, comm: 'totally-unknown-app' }],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'UNKNOWN');
  assert.strictEqual(result[0].confidence, 0.30);
  d.destroy();
});

test('WorkloadDetector hysteresis: same workload + comm = no new detection', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  // First tick — emits detection
  assert.strictEqual(d.detect(ctx).length, 1);
  // Second tick — same workload + comm — no new detection
  assert.strictEqual(d.detect(ctx).length, 0);
  d.destroy();
});

test('WorkloadDetector emits NONE when foreground disappears', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  // First — has foreground
  const ctx1 = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  d.detect(ctx1);
  // Second — no foreground
  const ctx2 = makeContext({});
  const result = d.detect(ctx2);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'NONE');
  d.destroy();
});

test('WorkloadDetector preserves classification when comm unavailable (fastTick)', () => {
  // Simulates the fastTick → slowTick pattern:
  //   fastTick: foregroundPid set, but foregroundInfo=null, procs=[]
  //   slowTick: foregroundInfo populated with real comm
  //
  // The detector should NOT downgrade an existing classification to
  // UNKNOWN just because fastTick can't see the comm.
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();

  // slowTick: classify firefox as BROWSER
  const slowCtx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  const slowResult = d.detect(slowCtx);
  assert.strictEqual(slowResult[0].classification, 'BROWSER');

  // fastTick: same PID but no foregroundInfo/procs — should preserve BROWSER
  const fastCtx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: null,
    procs: [],
  });
  const fastResult = d.detect(fastCtx);
  assert.strictEqual(fastResult.length, 0);  // no new detection — preserves BROWSER
  assert.strictEqual(d._lastWorkload, 'BROWSER');  // classification preserved

  d.destroy();
});

test('WorkloadDetector emits UNKNOWN on first tick if comm unavailable', () => {
  // First-ever tick with no comm info — should emit UNKNOWN
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: null,
    procs: [],
  });
  const result = d.detect(ctx);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'UNKNOWN');
  d.destroy();
});

test('WorkloadDetector emits onWorkloadDetected bus event', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  let received = null;
  deps.bus.on('onWorkloadDetected', (payload) => { received = payload; });
  const ctx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  d.detect(ctx);
  assert.ok(received);
  assert.strictEqual(received.workload, 'BROWSER');
  assert.strictEqual(received.comm, 'firefox');
  d.destroy();
});

test('WorkloadDetector updates stateStore on detection', () => {
  const deps = makeDeps();
  const d = new WorkloadDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
  });
  d.detect(ctx);
  assert.strictEqual(deps.stateStore.get('workload.classification'), 'BROWSER');
  assert.strictEqual(deps.stateStore.get('workload.comm'), 'firefox');
  assert.strictEqual(deps.stateStore.get('workload.pid'), 1234);
  d.destroy();
});

// ── PowerStateDetector ────────────────────────────────────────────────

test('PowerStateDetector detects AC state when plugged in and full', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: false, capacity: 100 },
  });
  const result = d.detect(ctx);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'AC');
  d.destroy();
});

test('PowerStateDetector detects CHARGING when plugged in and not full', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: false, capacity: 75 },
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'CHARGING');
  d.destroy();
});

test('PowerStateDetector detects BATTERY state when on battery and not low', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: true, capacity: 80 },
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'BATTERY');
  d.destroy();
});

test('PowerStateDetector detects BATTERY_LOW when capacity <= threshold', () => {
  const deps = makeDeps({ config: { BATTERY_LOW_THRESHOLD: 20 } });
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: true, capacity: 15 },
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'BATTERY_LOW');
  d.destroy();
});

test('PowerStateDetector detects BATTERY_CRITICAL when capacity very low', () => {
  const deps = makeDeps({ config: { BATTERY_LOW_THRESHOLD: 20 } });
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: true, capacity: 5 },
  });
  const result = d.detect(ctx);
  assert.strictEqual(result[0].classification, 'BATTERY_CRITICAL');
  d.destroy();
});

test('PowerStateDetector hysteresis: same state = no new detection', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  const ctx = makeContext({
    battery: { onBattery: true, capacity: 80 },
  });
  assert.strictEqual(d.detect(ctx).length, 1);
  // Same state, capacity unchanged — no new detection
  assert.strictEqual(d.detect(ctx).length, 0);
  d.destroy();
});

test('PowerStateDetector emits onAcPlugged on AC → BATTERY transition', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  // Start in AC
  d.detect(makeContext({ battery: { onBattery: false, capacity: 100 } }));
  let unplugged = false;
  deps.bus.on('onAcUnplugged', () => { unplugged = true; });
  // Switch to battery
  d.detect(makeContext({ battery: { onBattery: true, capacity: 90 } }));
  assert.ok(unplugged);
  d.destroy();
});

test('PowerStateDetector emits onBatteryLow when crossing threshold', () => {
  const deps = makeDeps({ config: { BATTERY_LOW_THRESHOLD: 20 } });
  const d = new PowerStateDetector(deps);
  d.start();
  // Start above threshold
  d.detect(makeContext({ battery: { onBattery: true, capacity: 50 } }));
  let lowEvent = null;
  deps.bus.on('onBatteryLow', (p) => { lowEvent = p; });
  // Cross threshold
  d.detect(makeContext({ battery: { onBattery: true, capacity: 15 } }));
  assert.ok(lowEvent);
  assert.strictEqual(lowEvent.capacity, 15);
  assert.strictEqual(lowEvent.threshold, 20);
  d.destroy();
});

test('PowerStateDetector emits UNKNOWN when battery disappears', () => {
  const deps = makeDeps();
  const d = new PowerStateDetector(deps);
  d.start();
  // Start with battery
  d.detect(makeContext({ battery: { onBattery: true, capacity: 80 } }));
  // Now no battery
  const result = d.detect(makeContext({}));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'UNKNOWN');
  d.destroy();
});

// ── IdleStateDetector ─────────────────────────────────────────────────

test('IdleStateDetector starts in ACTIVE state', () => {
  const deps = makeDeps();
  const d = new IdleStateDetector(deps);
  assert.strictEqual(d._state, 'ACTIVE');
  d.destroy();
});

test('IdleStateDetector transitions to IDLE after threshold ticks', () => {
  const deps = makeDeps({ config: { DETECTOR_IDLE_THRESHOLD_TICKS: 3 } });
  const d = new IdleStateDetector(deps);
  d.start();
  const ctx = makeContext({
    foregroundPid: 1234,
    cpuPressure: 1.0,    // below 2.0 threshold
    networkRxKbps: 1,    // below 5 threshold
  });
  // Tick 1, 2 — not yet idle (need 3 consecutive)
  d.detect(ctx); d.detect(ctx);
  assert.strictEqual(d._state, 'ACTIVE');
  // Tick 3 — transitions to IDLE
  const result = d.detect(ctx);
  assert.strictEqual(d._state, 'IDLE');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'IDLE');
  d.destroy();
});

test('IdleStateDetector returns to ACTIVE on activity', () => {
  const deps = makeDeps({ config: { DETECTOR_IDLE_THRESHOLD_TICKS: 2 } });
  const d = new IdleStateDetector(deps);
  d.start();
  // Go idle
  const idleCtx = makeContext({
    foregroundPid: 1234,
    cpuPressure: 1.0,
    networkRxKbps: 1,
  });
  d.detect(idleCtx); d.detect(idleCtx);
  assert.strictEqual(d._state, 'IDLE');
  // Activity: foreground changes
  const activeCtx = makeContext({
    foregroundPid: 5678,   // different PID
    cpuPressure: 1.0,
    networkRxKbps: 1,
  });
  const result = d.detect(activeCtx);
  assert.strictEqual(d._state, 'ACTIVE');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].classification, 'ACTIVE');
  d.destroy();
});

test('IdleStateDetector activity from CPU pressure resets idle counter', () => {
  const deps = makeDeps({ config: { DETECTOR_IDLE_THRESHOLD_TICKS: 3 } });
  const d = new IdleStateDetector(deps);
  d.start();
  // Two idle ticks
  const idleCtx = makeContext({
    foregroundPid: 1, cpuPressure: 1.0, networkRxKbps: 1,
  });
  d.detect(idleCtx); d.detect(idleCtx);
  assert.strictEqual(d._idleTicks, 2);
  // High CPU pressure tick — resets counter
  const busyCtx = makeContext({
    foregroundPid: 1, cpuPressure: 10.0, networkRxKbps: 1,
  });
  d.detect(busyCtx);
  assert.strictEqual(d._idleTicks, 0);
  assert.strictEqual(d._state, 'ACTIVE');
  d.destroy();
});

test('IdleStateDetector emits onIdle and onIdleEnd events', () => {
  const deps = makeDeps({ config: { DETECTOR_IDLE_THRESHOLD_TICKS: 2 } });
  const d = new IdleStateDetector(deps);
  d.start();
  let idleEvent = null;
  let idleEndEvent = null;
  deps.bus.on('onIdle', (p) => { idleEvent = p; });
  deps.bus.on('onIdleEnd', (p) => { idleEndEvent = p; });

  // Go idle
  const idleCtx = makeContext({
    foregroundPid: 1, cpuPressure: 1.0, networkRxKbps: 1,
  });
  d.detect(idleCtx); d.detect(idleCtx);
  assert.ok(idleEvent);

  // Return to active
  const activeCtx = makeContext({
    foregroundPid: 999, cpuPressure: 1.0, networkRxKbps: 1,
  });
  d.detect(activeCtx);
  assert.ok(idleEndEvent);
  d.destroy();
});

test('IdleStateDetector updates stateStore', () => {
  const deps = makeDeps({ config: { DETECTOR_IDLE_THRESHOLD_TICKS: 2 } });
  const d = new IdleStateDetector(deps);
  d.start();
  const idleCtx = makeContext({
    foregroundPid: 1, cpuPressure: 1.0, networkRxKbps: 1,
  });
  d.detect(idleCtx); d.detect(idleCtx);
  assert.strictEqual(deps.stateStore.get('idle.state'), 'IDLE');
  assert.strictEqual(deps.stateStore.get('idle.ticks'), 2);
  d.destroy();
});

// ── Public API (index.js) ─────────────────────────────────────────────

test('detectors/index.js exports all expected names', () => {
  assert.strictEqual(typeof detectorIndex.DetectorManager, 'function');
  assert.strictEqual(typeof detectorIndex.DetectionContext, 'function');
  assert.strictEqual(typeof detectorIndex.BaseDetector, 'function');
  assert.strictEqual(typeof detectorIndex.WorkloadDetector, 'function');
  assert.strictEqual(typeof detectorIndex.PowerStateDetector, 'function');
  assert.strictEqual(typeof detectorIndex.IdleStateDetector, 'function');
  assert.strictEqual(typeof detectorIndex.createBuiltinDetectors, 'function');
});

test('createBuiltinDetectors returns 3 detector instances', () => {
  const deps = makeDeps();
  const detectors = detectorIndex.createBuiltinDetectors(deps);
  assert.strictEqual(detectors.length, 3);
  assert.ok(detectors[0] instanceof WorkloadDetector);
  assert.ok(detectors[1] instanceof PowerStateDetector);
  assert.ok(detectors[2] instanceof IdleStateDetector);
  // Names follow the kebab-case convention
  assert.strictEqual(detectors[0].name, 'workload');
  assert.strictEqual(detectors[1].name, 'power-state');
  assert.strictEqual(detectors[2].name, 'idle-state');
});

test('DetectorManager integrates with createBuiltinDetectors', () => {
  const deps = makeDeps();
  const mgr = new DetectorManager({ config: deps.config, bus: deps.bus });
  const detectors = detectorIndex.createBuiltinDetectors(deps);
  for (const d of detectors) mgr.register(d);
  mgr.setupAll();
  mgr.startAll();
  assert.strictEqual(mgr.size, 3);

  // Run a tick — should not throw
  const result = mgr.tick({
    foregroundPid: 1234,
    foregroundInfo: { pid: 1234, comm: 'firefox', cmdline: '' },
    procs: [{ pid: 1234, ppid: 1, pcpu: 5, comm: 'firefox' }],
    battery: { onBattery: true, capacity: 80 },
    cpuPressure: 1.0,
    networkRxKbps: 1,
  });
  assert.ok(result instanceof Map);
  mgr.destroy();
});

// ── Edge cases / regression ───────────────────────────────────────────

test('DetectionContext handles null battery gracefully', () => {
  const ctx = makeContext({ battery: null });
  assert.strictEqual(ctx.battery, null);
  assert.strictEqual(ctx.onBattery, false);
});

test('DetectionContext handles missing procs as empty array', () => {
  const ctx = makeContext({});
  assert.deepStrictEqual(ctx.procs, []);
  // Frozen empty array — cannot push
  assert.throws(() => { ctx.procs.push(1); });
});

test('DetectorManager.tick handles malformed context fields', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();
  mgr.register(new WorkloadDetector(deps));
  mgr.startAll();
  // Pass garbage — should not throw, returns empty map or partial result
  const result = mgr.tick({
    foregroundPid: 'not-a-number',
    procs: 'not-an-array',
    battery: 'not-an-object',
  });
  assert.ok(result instanceof Map);
  mgr.destroy();
});

test('DetectorManager.destroy is idempotent', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  mgr.destroy();
  mgr.destroy();  // should not throw
});

test('DetectorManager.register returns false after destroy', () => {
  const mgr = new DetectorManager({ config: makeConfig() });
  mgr.destroy();
  const deps = makeDeps();
  assert.strictEqual(mgr.register(new BaseDetector('test', deps)), false);
});

test('DetectorManager.tick guards against re-entrancy', () => {
  // A detector that, when detect() is called, triggers a re-entrant
  // tick() via a bus event listener. The re-entrant call must return
  // an empty Map and NOT corrupt the outer tick's _lastDetections.
  const mgr = new DetectorManager({ config: makeConfig() });
  const deps = makeDeps();

  let reentrantResult = 'not-called';
  deps.bus.on('onWorkloadDetected', () => {
    // Re-entrant tick — should be skipped
    reentrantResult = mgr.tick({ foregroundPid: 9999 });
  });

  class ReentrantTrigger extends BaseDetector {
    constructor(d) { super('trigger', d); }
    detect(ctx) {
      // Emit an event that triggers the listener above
      this.bus.emit('onWorkloadDetected', { workload: 'TEST' });
      return [{
        detector: 'trigger', domain: 'test', classification: 'TEST',
        confidence: 1.0, payload: {}, timestamp: new Date().toISOString(),
      }];
    }
  }

  mgr.register(new ReentrantTrigger(deps));
  mgr.startAll();
  const result = mgr.tick({ foregroundPid: 1234 });

  // Outer tick returns the detection
  assert.strictEqual(result.size, 1);
  assert.ok(result.has('trigger'));
  // Re-entrant call returned empty Map
  assert.ok(reentrantResult instanceof Map);
  assert.strictEqual(reentrantResult.size, 0);
  mgr.destroy();
});
