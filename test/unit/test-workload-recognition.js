'use strict';

/**
 * test-workload-recognition.js — Unit tests for the v0.5.0 Phase 5
 * Workload Recognition & Smart Optimization.
 *
 * Run with: node --test test/unit/test-workload-recognition.js
 *
 * Covers:
 *   - WorkloadRecognizer: confidence scoring, multi-source, threshold, custom rules
 *   - OptimizationStrategies: 14 categories, strategy mapping
 *   - RecognitionEngine: event handling, debounce, demand routing, confidence gating
 *   - Stability: no oscillation, no duplicate demands, fallback behavior
 *   - Backward compatibility
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const WorkloadRecognizer = require(path.join(__dirname, '..', '..', 'recognition', 'workload-recognizer.js'));
const RecognitionEngine = require(path.join(__dirname, '..', '..', 'recognition', 'recognition-engine.js'));
const recognitionIndex = require(path.join(__dirname, '..', '..', 'recognition'));
const { OPTIMIZATION_STRATEGIES, getStrategy, getWorkloadCategories } = require(path.join(__dirname, '..', '..', 'recognition', 'optimization-strategies.js'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));
const { EventBus } = require(path.join(__dirname, '..', '..', 'policy-engine', 'event-bus.js'));
const { ProfileManager } = require(path.join(__dirname, '..', '..', 'profiles'));

// ── Test helpers ──────────────────────────────────────────────────────

function makeConfig(overrides) {
  return { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
}

function makeFakeRcm() {
  return {
    applyThermalProfile: () => ({ success: true }),
    applyPowerProfile: () => ({ success: true }),
    setPpdProfile: () => ({ success: true }),
    setGovernor: () => ({ success: true }),
    getController: () => null,
  };
}

function makeProfileManager(config, bus) {
  const pm = new ProfileManager({ config, bus, rcm: makeFakeRcm() });
  pm.setup();
  pm.start();
  return pm;
}

// ── WorkloadRecognizer ────────────────────────────────────────────────

test('WorkloadRecognizer requires config', () => {
  assert.throws(() => new WorkloadRecognizer({}), TypeError);
  assert.throws(() => new WorkloadRecognizer(), TypeError);
});

test('WorkloadRecognizer loads built-in rules', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  assert.ok(r.ruleCount >= 14);  // 14 built-in rules
  assert.strictEqual(r.customRuleCount, 0);
});

test('WorkloadRecognizer recognizes gaming (GAME classification)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'GAME',
    foregroundComm: 'UnityPlayer',
    gpuUtilization: 85,
    cpuPressure: 15,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'gaming');
  assert.ok(detections[0].confidence >= 0.60);
  assert.strictEqual(detections[0].profile, 'gaming');
});

test('WorkloadRecognizer recognizes development (IDE classification)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'IDE',
    foregroundComm: 'code',
    cpuPressure: 20,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'development');
  assert.ok(detections[0].confidence >= 0.60);
});

test('WorkloadRecognizer recognizes compiler (high CPU)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'COMPILER',
    foregroundComm: 'rustc',
    cpuPressure: 80,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'development');
  assert.ok(detections[0].confidence >= 0.70);  // compiler boost
});

test('WorkloadRecognizer recognizes browsing (BROWSER classification)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'BROWSER',
    foregroundComm: 'firefox',
    gpuUtilization: 10,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'web-browsing');
});

test('WorkloadRecognizer recognizes video editing', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'UNKNOWN',
    foregroundComm: 'kdenlive',
    gpuUtilization: 40,
    cpuPressure: 25,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'video-editing');
  assert.strictEqual(detections[0].profile, 'rendering');
});

test('WorkloadRecognizer recognizes 3D rendering (high GPU)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'UNKNOWN',
    foregroundComm: 'blender',
    gpuUtilization: 75,
    cpuPressure: 35,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, '3d-rendering');
});

test('WorkloadRecognizer recognizes streaming (MULTIMEDIA)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'MULTIMEDIA',
    foregroundComm: 'mpv',
    mediaPidsCount: 3,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'streaming');
});

test('WorkloadRecognizer recognizes virtual machines', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'VIRTUALIZATION',
    foregroundComm: 'qemu-system-x86_64',
    memoryUsage: 60,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'virtual-machines');
});

test('WorkloadRecognizer recognizes AI/ML (python + high GPU)', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'UNKNOWN',
    foregroundComm: 'python3',
    gpuUtilization: 85,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'ai-ml');
  assert.strictEqual(detections[0].profile, 'performance');
});

test('WorkloadRecognizer recognizes file compression', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'UNKNOWN',
    foregroundComm: 'xz',
    cpuPressure: 50,
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'file-compression');
});

test('WorkloadRecognizer recognizes idle', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    idleState: 'IDLE',
    workloadClassification: 'UNKNOWN',
    foregroundComm: '',
  });
  assert.ok(detections.length > 0);
  assert.strictEqual(detections[0].workload, 'idle');
  assert.ok(detections[0].confidence >= 0.85);
});

test('WorkloadRecognizer filters by confidence threshold', () => {
  const r = new WorkloadRecognizer({ config: makeConfig({ RECOGNITION_CONFIDENCE_THRESHOLD: 0.90 }) });
  // Gaming with no GPU signal → confidence ~0.50 (below 0.90)
  const detections = r.recognize({
    workloadClassification: 'GAME',
    foregroundComm: 'UnityPlayer',
    gpuUtilization: null,
    cpuPressure: 0,
  });
  // Should be empty (0.50 < 0.90)
  assert.strictEqual(detections.length, 0);
});

test('WorkloadRecognizer returns detections sorted by confidence', () => {
  const r = new WorkloadRecognizer({ config: makeConfig({ RECOGNITION_CONFIDENCE_THRESHOLD: 0.30 }) });
  const detections = r.recognize({
    workloadClassification: 'GAME',
    foregroundComm: 'UnityPlayer',
    gpuUtilization: 85,
    cpuPressure: 15,
    idleState: 'IDLE',
  });
  // Both gaming and idle should match; gaming should have higher confidence
  assert.ok(detections.length >= 1);
  if (detections.length >= 2) {
    assert.ok(detections[0].confidence >= detections[1].confidence);
  }
});

test('WorkloadRecognizer handles empty/invalid context', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  assert.strictEqual(r.recognize(null).length, 0);
  assert.strictEqual(r.recognize(undefined).length, 0);
  assert.strictEqual(r.recognize('string').length, 0);
  assert.strictEqual(r.recognize({}).length, 0);
});

test('WorkloadRecognizer registerRule accepts custom rule', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const ok = r.registerRule({
    id: 'my-custom',
    workload: 'custom-workload',
    profile: 'balanced',
    match: (ctx) => ctx.foregroundComm === 'my-app',
    confidence: (ctx) => 0.80,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(r.customRuleCount, 1);

  const detections = r.recognize({
    foregroundComm: 'my-app',
    workloadClassification: 'UNKNOWN',
  });
  assert.ok(detections.some((d) => d.workload === 'custom-workload'));
});

test('WorkloadRecognizer registerRule rejects invalid rule', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  assert.strictEqual(r.registerRule(null), false);
  assert.strictEqual(r.registerRule({}), false);
  assert.strictEqual(r.registerRule({ id: 'x' }), false);  // no match/confidence
});

test('WorkloadRecognizer registerRule rejects duplicate id', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  r.registerRule({ id: 'dup', workload: 'w', profile: 'p', match: () => true, confidence: () => 0.5 });
  assert.strictEqual(r.registerRule({ id: 'dup', workload: 'w2', profile: 'p2', match: () => true, confidence: () => 0.5 }), false);
});

test('WorkloadRecognizer unregisterRule removes rule', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  r.registerRule({ id: 'temp', workload: 'w', profile: 'p', match: () => true, confidence: () => 0.5 });
  assert.strictEqual(r.unregisterRule('temp'), true);
  assert.strictEqual(r.customRuleCount, 0);
  assert.strictEqual(r.unregisterRule('nonexistent'), false);
});

test('WorkloadRecognizer getStatus returns snapshot', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  r.recognize({ workloadClassification: 'GAME', foregroundComm: 'UnityPlayer' });
  const status = r.getStatus();
  assert.ok(status.ruleCount >= 14);
  assert.strictEqual(status.customRuleCount, 0);
  assert.ok(status.recognitionCount >= 1);
  assert.ok(status.confidenceThreshold > 0);
  assert.ok(status.lastRecognition);
});

test('WorkloadRecognizer records lastRecognition', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  r.recognize({ workloadClassification: 'GAME', foregroundComm: 'UnityPlayer', gpuUtilization: 85 });
  const last = r.lastRecognition;
  assert.ok(last);
  assert.ok(last.timestamp > 0);
  assert.ok(last.totalDetected >= 0);
  assert.ok(last.confidentCount >= 0);
  assert.ok(Array.isArray(last.detections));
});

test('WorkloadRecognizer detection includes source + reason + context', () => {
  const r = new WorkloadRecognizer({ config: makeConfig() });
  const detections = r.recognize({
    workloadClassification: 'GAME',
    foregroundComm: 'UnityPlayer',
    gpuUtilization: 85,
    cpuPressure: 15,
  });
  assert.ok(detections.length > 0);
  const d = detections[0];
  assert.ok(typeof d.source === 'string');
  assert.ok(typeof d.reason === 'string');
  assert.ok(d.context);
  assert.strictEqual(d.context.foregroundComm, 'UnityPlayer');
  assert.strictEqual(d.context.gpuUtilization, 85);
});

// ── Optimization Strategies ───────────────────────────────────────────

test('14 workload categories defined', () => {
  const categories = getWorkloadCategories();
  assert.strictEqual(categories.length, 14);
});

test('all categories have unique IDs', () => {
  const categories = getWorkloadCategories();
  assert.strictEqual(new Set(categories).size, categories.length);
});

test('getStrategy returns strategy for known workload', () => {
  const s = getStrategy('gaming');
  assert.ok(s);
  assert.strictEqual(s.workload, 'gaming');
  assert.strictEqual(s.profile, 'gaming');
  assert.ok(s.description);
  assert.ok(s.priorities);
});

test('getStrategy returns null for unknown workload', () => {
  assert.strictEqual(getStrategy('nonexistent'), null);
});

test('all strategies have required fields', () => {
  for (const cat of getWorkloadCategories()) {
    const s = getStrategy(cat);
    assert.ok(s.workload, `${cat}: missing workload`);
    assert.ok(s.profile, `${cat}: missing profile`);
    assert.ok(s.description, `${cat}: missing description`);
    assert.ok(s.priorities, `${cat}: missing priorities`);
    assert.ok(s.priorities.cpu, `${cat}: missing priorities.cpu`);
    assert.ok(s.priorities.gpu, `${cat}: missing priorities.gpu`);
    assert.ok(s.priorities.thermal, `${cat}: missing priorities.thermal`);
    assert.ok(s.priorities.power, `${cat}: missing priorities.power`);
  }
});

test('gaming strategy has aggressive thermal', () => {
  const s = getStrategy('gaming');
  assert.strictEqual(s.priorities.thermal, 'aggressive');
  assert.strictEqual(s.priorities.power, 'performance');
});

test('idle strategy has power-saver', () => {
  const s = getStrategy('idle');
  assert.strictEqual(s.priorities.power, 'power-saver');
  assert.strictEqual(s.priorities.cpu, 'low');
});

// ── RecognitionEngine ─────────────────────────────────────────────────

test('RecognitionEngine requires config, bus, profileManager', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig(), bus);
  assert.throws(() => new RecognitionEngine({}), TypeError);
  assert.throws(() => new RecognitionEngine({ config: makeConfig() }), TypeError);
  assert.throws(() => new RecognitionEngine({ config: makeConfig(), bus }), TypeError);
  assert.ok(new RecognitionEngine({ config: makeConfig(), bus, profileManager: pm }));
});

test('RecognitionEngine starts and stops cleanly', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({ config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus, profileManager: pm });
  engine.setup();
  engine.start();
  assert.strictEqual(engine.getStatus().running, true);
  engine.stop();
  assert.strictEqual(engine.getStatus().running, false);
  engine.destroy();
});

test('RecognitionEngine handles workload event and demands profile', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  // After debounce (0ms), recognition runs and demands 'gaming'
  assert.strictEqual(engine.demandedProfile, 'gaming');
  engine.destroy();
});

test('RecognitionEngine withdraws demand when no confident detection', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0, RECOGNITION_CONFIDENCE_THRESHOLD: 0.99 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  // Emit a workload event that won't meet the 0.99 threshold
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  // Should NOT have demanded anything (confidence < 0.99)
  assert.strictEqual(engine.demandedProfile, null);
  engine.destroy();
});

test('RecognitionEngine emits onWorkloadRecognized event', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  let received = null;
  bus.on('onWorkloadRecognized', (p) => { received = p; });
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.ok(received);
  assert.strictEqual(received.workload, 'gaming');
  assert.strictEqual(received.profile, 'gaming');
  assert.ok(received.confidence >= 0.60);
  engine.destroy();
});

test('RecognitionEngine handles idle event', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  // First emit a workload event so there's something to recognize
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.strictEqual(engine.demandedProfile, 'gaming');
  // Now emit idle — should demand 'idle' (confidence 0.90 > threshold)
  bus.emit('onIdleStateChanged', { to: 'IDLE' });
  assert.strictEqual(engine.demandedProfile, 'idle');
  engine.destroy();
});

test('RecognitionEngine handles malformed events gracefully', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  bus.emit('onWorkloadDetected', null);
  bus.emit('onWorkloadDetected', {});
  bus.emit('onPowerStateChanged', null);
  bus.emit('onIdleStateChanged', null);
  bus.emit('onDetectionTick', null);
  // Should not crash
  assert.strictEqual(engine.getStatus().running, true);
  engine.destroy();
});

test('RecognitionEngine does not demand same profile twice', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  const count1 = engine.getStatus().demandCount;
  // Emit same event again — should not increment demand count
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  const count2 = engine.getStatus().demandCount;
  assert.strictEqual(count2, count1);  // no new demand
  engine.destroy();
});

test('RecognitionEngine destroy withdraws demand', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.strictEqual(engine.demandedProfile, 'gaming');
  engine.destroy();
  // After destroy, demand should be withdrawn
  assert.strictEqual(engine.demandedProfile, null);
});

test('RecognitionEngine setConfig updates config', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig(), bus);
  const engine = new RecognitionEngine({ config: makeConfig(), bus, profileManager: pm });
  const newConfig = makeConfig({ RECOGNITION_CONFIDENCE_THRESHOLD: 0.90 });
  engine.setConfig(newConfig);
  assert.strictEqual(engine.recognizer._config.RECOGNITION_CONFIDENCE_THRESHOLD, 0.90);
  engine.destroy();
});

test('RecognitionEngine getStatus returns snapshot', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  const status = engine.getStatus();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.running, true);
  assert.ok(status.recognizer);
  assert.ok(status.demandedProfile);
  assert.ok(status.demandCount >= 1);
  engine.destroy();
});

test('RecognitionEngine destroy is idempotent', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig(), bus);
  const engine = new RecognitionEngine({ config: makeConfig(), bus, profileManager: pm });
  engine.setup();
  engine.start();
  engine.destroy();
  engine.destroy();  // should not throw
});

// ── Public API ────────────────────────────────────────────────────────

test('recognition/index.js exports documented API', () => {
  assert.strictEqual(typeof recognitionIndex.WorkloadRecognizer, 'function');
  assert.strictEqual(typeof recognitionIndex.RecognitionEngine, 'function');
  assert.ok(recognitionIndex.OPTIMIZATION_STRATEGIES);
  assert.strictEqual(typeof recognitionIndex.getStrategy, 'function');
  assert.strictEqual(typeof recognitionIndex.getWorkloadCategories, 'function');
});

// ── Stability ─────────────────────────────────────────────────────────

test('RecognitionEngine does not oscillate on repeated events', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  // Emit the same event 10 times rapidly
  for (let i = 0; i < 10; i++) {
    bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  }
  // Should have demanded 'gaming' only once (same-profile no-op)
  assert.strictEqual(engine.demandedProfile, 'gaming');
  const status = engine.getStatus();
  // demandCount should be 1 (first demand) — subsequent same-profile demands don't count
  assert.ok(status.demandCount <= 2);
  engine.destroy();
});

test('RecognitionEngine falls back when workload disappears', () => {
  const bus = new EventBus();
  const pm = makeProfileManager(makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }), bus);
  const engine = new RecognitionEngine({
    config: makeConfig({ RECOGNITION_DEBOUNCE_MS: 0 }),
    bus, profileManager: pm,
  });
  engine.setup();
  engine.start();
  // Demand gaming
  bus.emit('onWorkloadDetected', { workload: 'GAME', comm: 'UnityPlayer', pid: 1234 });
  assert.strictEqual(engine.demandedProfile, 'gaming');
  // Now emit NONE — no confident detection → withdraw demand
  bus.emit('onWorkloadDetected', { workload: 'NONE', comm: '', pid: null });
  assert.strictEqual(engine.demandedProfile, null);
  engine.destroy();
});
