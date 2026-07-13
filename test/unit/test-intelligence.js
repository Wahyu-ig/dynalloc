'use strict';

/**
 * Tests for the Intelligence Subsystem (v2.0)
 *
 * Covers: LearningEngine, RecommendationEngine, ExplainabilityEngine,
 *        TimelineEngine, DoctorEngine, ReportGenerator.
 *
 * Uses node:test (Node.js >= 18).
 */

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Suppress logger output
const logger = require('../../logger');
logger.setLevel('fatal');
const origConsoleError = console.error;
const origConsoleWarn = console.warn;
const origConsoleLog = console.log;

// ── Helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    ENABLE_INTELLIGENCE: true,
    LEARNING_SUGGESTION_COOLDOWN_MS: 60000,
    LEARNING_DATA_DIR: null,
    ...overrides,
  };
}

function makeLearningEngine(config) {
  const { LearningEngine } = require('../../intelligence/learning-engine');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
  return { engine: new LearningEngine({ config: config || makeConfig(), dataDir: tmpDir }), tmpDir };
}

// ── Learning Engine Tests ─────────────────────────────────────────────

describe('LearningEngine', () => {

  it('should construct without errors', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      assert.ok(engine);
      assert.equal(engine._totalObservations, 0);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should record foreground changes', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordForeground({ pid: 1234, comm: 'steam' }, { cpuPressure: 5 });
      engine.recordForeground({ pid: 1234, comm: 'steam' }, { cpuPressure: 5 });
      engine.recordForeground({ pid: 5678, comm: 'firefox' }, { cpuPressure: 20 });

      assert.equal(engine._totalObservations, 3);
      assert.equal(engine._appFrequency.get('steam').count, 2);
      assert.equal(engine._appFrequency.get('firefox').count, 1);
      assert.equal(engine._foregroundHistory.length, 3);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should track CPU intensive apps', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordForeground({ pid: 100, comm: 'chrome' }, { cpuPressure: 50 });
      engine.recordForeground({ pid: 100, comm: 'chrome' }, { cpuPressure: 60 });
      engine.recordForeground({ pid: 100, comm: 'chrome' }, { cpuPressure: 55 });

      const intensive = engine.getCpuIntensiveApps();
      assert.equal(intensive.length, 1);
      assert.equal(intensive[0].comm, 'chrome');
      assert.equal(intensive[0].count, 3);
      assert.ok(intensive[0].avgPressure > 50);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should compute hourly activity', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      const hour = new Date().getHours();
      engine.recordForeground({ pid: 1, comm: 'test' }, {});
      engine.recordForeground({ pid: 2, comm: 'test' }, {});

      const activity = engine.getHourlyActivity();
      assert.ok(Array.isArray(activity));
      assert.equal(activity.length, 24);
      assert.ok(activity[hour] >= 2);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should get top apps sorted by count', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      for (let i = 0; i < 10; i++) engine.recordForeground({ pid: 1, comm: 'app-a' }, {});
      for (let i = 0; i < 5; i++) engine.recordForeground({ pid: 2, comm: 'app-b' }, {});
      for (let i = 0; i < 2; i++) engine.recordForeground({ pid: 3, comm: 'app-c' }, {});

      const top = engine.getTopApps(2);
      assert.equal(top.length, 2);
      assert.equal(top[0].comm, 'app-a');
      assert.equal(top[0].count, 10);
      assert.equal(top[1].comm, 'app-b');
      assert.equal(top[1].count, 5);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should record and query battery samples', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      // Record with a small time gap to ensure rate computation
      const now = Date.now();
      engine._batterySamples.push({ ts: now - 3600000, capacity: 90, discharging: true, rate: 10 });
      engine._batterySamples.push({ ts: now - 1800000, capacity: 80, discharging: true, rate: 20 });

      const stats = engine.getBatteryStats();
      assert.ok(stats.samples >= 1);
      assert.ok(stats.avgRate >= 0);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should record profile switches', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordProfileSwitch({ from: 'balanced', to: 'gaming', reason: 'Steam detected', trigger: { app: 'steam', hour: 19 } });
      engine.recordProfileSwitch({ from: 'gaming', to: 'balanced', reason: 'Steam closed', trigger: { app: 'steam', hour: 19 } });
      engine.recordProfileSwitch({ to: 'battery-saver', reason: 'Low battery' });

      assert.equal(engine._totalProfileSwitches, 3);
      const patterns = engine.getProfilePatterns();
      assert.ok(patterns.length >= 1);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should persist and load data', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordForeground({ pid: 1, comm: 'test-app' }, { cpuPressure: 10 });
      engine.persist();

      // Create a new engine with the same data dir
      const { LearningEngine } = require('../../intelligence/learning-engine');
      const engine2 = new LearningEngine({ config: makeConfig(), dataDir: tmpDir });
      try {
        assert.equal(engine2._totalObservations, 1);
        assert.equal(engine2._appFrequency.get('test-app').count, 1);
      } finally {
        engine2.clear();
      }
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should enforce memory bounds', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      // Add many unique apps to exceed MAX_FREQ_ENTRIES
      for (let i = 0; i < 3000; i++) {
        engine.recordForeground({ pid: i, comm: `app-${i}` }, { cpuPressure: 1 });
      }
      assert.ok(engine._appFrequency.size <= 2048);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return status', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordForeground({ pid: 1, comm: 'test' }, {});
      const status = engine.getStatus();
      assert.equal(status.enabled, true);
      assert.equal(status.totalObservations, 1);
      assert.equal(status.uniqueApps, 1);
      assert.ok('peakHours' in status);
      assert.ok('topApps' in status);
    } finally {
      engine.clear();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should clear all data', () => {
    const { engine, tmpDir } = makeLearningEngine();
    try {
      engine.recordForeground({ pid: 1, comm: 'test' }, {});
      engine.recordProfileSwitch({ to: 'gaming', reason: 'test' });
      engine.clear();

      assert.equal(engine._totalObservations, 0);
      assert.equal(engine._appFrequency.size, 0);
      assert.equal(engine._profileSwitchHistory.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Recommendation Engine Tests ───────────────────────────────────────

describe('RecommendationEngine', () => {

  it('should construct with a learning engine', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const le = new LearningEngine({ config: makeConfig(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-')) });
    const re = new RecommendationEngine({ learningEngine: le, config: makeConfig() });
    assert.ok(re);
    assert.equal(re.getPending().length, 0);
    le.clear();
  });

  it('should generate CPU-intensive recommendations', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
    const le = new LearningEngine({ config: makeConfig(), dataDir: tmpDir });

    // Simulate CPU intensive app
    for (let i = 0; i < 10; i++) {
      le.recordForeground({ pid: 100, comm: 'chrome' }, { cpuPressure: 50 });
    }

    const re = new RecommendationEngine({ learningEngine: le, config: makeConfig() });
    const recs = re.generate({ foregroundComm: 'chrome' });

    // Should generate a CPU-intensive recommendation
    const cpuRec = recs.find(r => r.type === 'cpu-intensive');
    assert.ok(cpuRec, 'Should generate a cpu-intensive recommendation');
    assert.ok(cpuRec.id.startsWith('rec-'));
    assert.ok(cpuRec.confidence > 0);
    assert.equal(cpuRec.status, 'pending');

    le.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should approve and dismiss recommendations', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
    const le = new LearningEngine({ config: makeConfig(), dataDir: tmpDir });

    // Create pattern that triggers auto-profile recommendation
    for (let i = 0; i < 10; i++) {
      le.recordProfileSwitch({
        from: 'balanced', to: 'gaming', reason: 'test',
        trigger: { app: 'steam', hour: 19 },
      });
    }

    const re = new RecommendationEngine({ learningEngine: le, config: makeConfig() });
    re.generate({ hour: 19, foregroundComm: 'steam' });

    const pending = re.getPending();
    if (pending.length > 0) {
      const id = pending[0].id;

      // Test dismiss
      const dismissResult = re.dismiss(id);
      assert.equal(dismissResult.success, true);
      assert.equal(re.getPending().length, pending.length - 1);

      // Dismissed ID should not be approvable
      const approveResult = re.approve(id);
      assert.equal(approveResult.success, false);
    }

    le.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should not re-suggest dismissed recommendations within cooldown', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-'));
    const le = new LearningEngine({ config: makeConfig(), dataDir: tmpDir });

    for (let i = 0; i < 10; i++) {
      le.recordProfileSwitch({
        to: 'battery-saver', reason: 'low battery',
        trigger: { app: 'system', battery: 10 },
      });
    }

    const re = new RecommendationEngine({
      learningEngine: le,
      config: makeConfig({ LEARNING_RECOMMENDATION_COOLDOWN_MS: 60000 }),
    });

    // Generate first batch
    re.generate({ battery: 10 });
    const pending = re.getPending();

    if (pending.length > 0) {
      re.dismiss(pending[0].id);

      // Generate again — should NOT produce the same recommendation
      const recs2 = re.generate({ battery: 10 });
      const sameKey = recs2.find(r => r.key === pending[0].key);
      assert.equal(sameKey, undefined, 'Dismissed recommendation should not reappear');
    }

    le.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return status', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const le = new LearningEngine({ config: makeConfig(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-')) });
    const re = new RecommendationEngine({ learningEngine: le, config: makeConfig() });
    const status = re.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.pendingCount, 0);
    le.clear();
  });

  it('should never apply recommendations automatically', () => {
    const { LearningEngine } = require('../../intelligence/learning-engine');
    const { RecommendationEngine } = require('../../intelligence/recommendation-engine');

    const le = new LearningEngine({ config: makeConfig(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dynalloc-test-')) });
    const re = new RecommendationEngine({ learningEngine: le, config: makeConfig() });

    // The engine only generates — never applies
    assert.equal(typeof re.generate, 'function');
    assert.equal(typeof re.approve, 'function');
    assert.equal(typeof re.dismiss, 'function');
    // No "apply" method exists
    assert.equal(typeof re.apply, 'undefined');
    le.clear();
  });
});

// ── Explainability Engine Tests ───────────────────────────────────────

describe('ExplainabilityEngine', () => {

  it('should record a boost explanation', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    const exp = ee.recordBoost({
      pid: 1234, comm: 'steam', schedClass: 'INTERACTIVE',
      cores: [0, 1, 2], nice: -5,
      io: { ioClass: 2, ioLevel: 0 },
      governorChanged: true, governor: 'performance',
      context: { cpuPressure: 10, memPressure: 5, thermal: 65 },
    });

    assert.ok(exp);
    assert.equal(exp.decision, 'boost');
    assert.equal(exp.target, 'steam (PID 1234)');
    assert.ok(exp.factors.length > 0);
    assert.ok(exp.factors.every(f => f.check && typeof f.result === 'boolean'));

    ee.clear();
  });

  it('should record a throttle explanation', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    const exp = ee.recordThrottle({
      pid: 5678, comm: 'chrome', reason: 'high background CPU',
      nice: 10, cores: [3, 4],
    });

    assert.ok(exp);
    assert.equal(exp.decision, 'throttle');
    assert.equal(exp.source, 'scheduler');
    ee.clear();
  });

  it('should record a governor change explanation', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    const exp = ee.recordGovernorChange({
      governor: 'performance', cores: [0, 1, 2], reason: 'foreground boost',
    });

    assert.ok(exp);
    assert.equal(exp.decision, 'governor_change');
    ee.clear();
  });

  it('should record a policy action explanation', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    const exp = ee.recordPolicyAction({
      ruleId: 'rule-1', actionType: 'setGovernor', eventName: 'ON_CPU_HIGH',
      success: true, elapsedMs: 5.2,
      matchDetails: { matchedConditions: ['cpu > 20', 'battery > 50'] },
    });

    assert.ok(exp);
    assert.equal(exp.decision, 'policy_rule');
    assert.equal(exp.source, 'policy_engine');
    assert.ok(exp.factors.some(f => f.check.includes('rule-1')));
    ee.clear();
  });

  it('should record a profile switch explanation', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    const exp = ee.recordProfileSwitch({
      from: 'balanced', to: 'gaming', reason: 'Steam detected',
      source: 'profile_manager', triggerInfo: { app: 'steam' },
    });

    assert.ok(exp);
    assert.equal(exp.decision, 'profile_switch');
    ee.clear();
  });

  it('should query recent explanations', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    ee.recordBoost({ pid: 1, comm: 'a', schedClass: 'INTERACTIVE', cores: [0], nice: -5, io: { ioClass: 2, ioLevel: 0 } });
    ee.recordThrottle({ pid: 2, comm: 'b', reason: 'test', nice: 10, cores: [0] });

    const all = ee.getRecent({ limit: 10 });
    assert.equal(all.length, 2);

    const boosts = ee.getRecent({ type: 'boost' });
    assert.equal(boosts.length, 1);

    ee.clear();
  });

  it('should enforce ring buffer size', () => {
    const { ExplainabilityEngine, MAX_EXPLANATIONS } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });

    for (let i = 0; i < MAX_EXPLANATIONS + 100; i++) {
      ee.recordBoost({ pid: i, comm: `app-${i}`, schedClass: 'INTERACTIVE', cores: [0], nice: -5, io: { ioClass: 2, ioLevel: 0 } });
    }

    assert.ok(ee._buffer.length <= MAX_EXPLANATIONS);
    assert.equal(ee._totalRecorded, MAX_EXPLANATIONS + 100);
    ee.clear();
  });

  it('should format explanations as text', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const text = ExplainabilityEngine.format(null);
    assert.equal(text, '(no explanation)');

    const ee = new ExplainabilityEngine({ config: makeConfig() });
    const exp = ee.recordBoost({ pid: 1, comm: 'test', schedClass: 'INTERACTIVE', cores: [0], nice: -5, io: { ioClass: 2, ioLevel: 0 } });
    const formatted = ExplainabilityEngine.format(exp);
    assert.ok(formatted.includes('Decision: boost'));
    assert.ok(formatted.includes('Reason:'));
    assert.ok(formatted.includes('✓'));
    ee.clear();
  });

  it('should return status', () => {
    const { ExplainabilityEngine } = require('../../intelligence/explainability-engine');
    const ee = new ExplainabilityEngine({ config: makeConfig() });
    const status = ee.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.bufferSize, 0);
    assert.equal(status.maxBufferSize, 500);
    ee.clear();
  });
});

// ── Timeline Engine Tests ─────────────────────────────────────────────

describe('TimelineEngine', () => {

  it('should record events', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    const e = te.record({ category: 'daemon', event: 'started', summary: 'Daemon started' });
    assert.ok(e);
    assert.equal(e.id, 0);
    assert.equal(e.category, 'daemon');
    assert.equal(e.event, 'started');
    assert.equal(e.severity, 'info');

    te.clear();
  });

  it('should record with severity convenience methods', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.warn('system', 'thermal_high', 'CPU temp high', { temp: 90 });
    te.error('daemon', 'crash', 'Crash detected');

    const warnEntry = te.recent(2).find(e => e.severity === 'warn');
    const errEntry = te.recent(2).find(e => e.severity === 'error');
    assert.ok(warnEntry);
    assert.ok(errEntry);

    te.clear();
  });

  it('should query by category', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.info('daemon', 'a', 'event a');
    te.info('scheduler', 'b', 'event b');
    te.info('scheduler', 'c', 'event c');

    const result = te.query({ category: 'scheduler' });
    assert.equal(result.filtered, 2);
    assert.equal(result.entries.length, 2);

    te.clear();
  });

  it('should query by severity', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.info('daemon', 'a', 'info event');
    te.warn('daemon', 'b', 'warn event');
    te.error('daemon', 'c', 'error event');

    const result = te.query({ severity: 'error' });
    assert.equal(result.filtered, 1);

    te.clear();
  });

  it('should query by time range', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    const now = Date.now();
    te.info('daemon', 'a', 'old event');
    // Manually set ts to 1 hour ago
    te._entries[0].ts = now - 3600000;

    te.info('daemon', 'b', 'recent event');

    const result = te.query({ since: now - 60000 });
    assert.equal(result.filtered, 1);
    assert.equal(result.entries[0].event, 'b');

    te.clear();
  });

  it('should query by search text', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.info('daemon', 'a', 'Steam opened');
    te.info('daemon', 'b', 'Chrome opened');
    te.info('system', 'c', 'Battery low');

    const result = te.query({ search: 'steam' });
    assert.equal(result.filtered, 1);

    te.clear();
  });

  it('should support pagination', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    for (let i = 0; i < 10; i++) {
      te.info('daemon', `event-${i}`, `Event ${i}`);
    }

    const page1 = te.query({ limit: 3, offset: 0 });
    const page2 = te.query({ limit: 3, offset: 3 });
    assert.equal(page1.entries.length, 3);
    assert.equal(page2.entries.length, 3);
    // Ensure no overlap (entries returned newest first)
    assert.notEqual(page1.entries[0].id, page2.entries[0].id);

    te.clear();
  });

  it('should enforce max entries', () => {
    const { TimelineEngine, MAX_ENTRIES } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    for (let i = 0; i < MAX_ENTRIES + 500; i++) {
      te.info('daemon', `e-${i}`, `Event ${i}`);
    }

    assert.ok(te._entries.length <= MAX_ENTRIES);
    assert.equal(te._totalRecorded, MAX_ENTRIES + 500);

    te.clear();
  });

  it('should export data', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.info('daemon', 'test', 'Test event');
    const exported = te.exportData();

    assert.ok(Array.isArray(exported));
    assert.ok(exported.length > 0);
    assert.ok(exported[0].time); // ISO string

    te.clear();
  });

  it('should return stats', () => {
    const { TimelineEngine } = require('../../intelligence/timeline-engine');
    const te = new TimelineEngine({ config: makeConfig() });

    te.info('daemon', 'a', 'A');
    te.warn('system', 'b', 'B');

    const stats = te.getStats();
    assert.equal(stats.bufferSize, 2);
    assert.equal(stats.totalRecorded, 2);
    assert.equal(stats.bySeverity.info, 1);
    assert.equal(stats.bySeverity.warn, 1);
    assert.equal(stats.byCategory.daemon, 1);
    assert.equal(stats.byCategory.system, 1);

    te.clear();
  });
});

// ── Doctor Engine Tests ────────────────────────────────────────────────

describe('DoctorEngine', () => {

  it('should run and return a result with score', () => {
    const { DoctorEngine } = require('../../intelligence/doctor-engine');
    const doctor = new DoctorEngine();

    const result = doctor.run({
      config: {
        ENABLE_POLICY_ENGINE: false,
        ENABLE_GOVERNOR_SWITCH: false,
        FAST_TICK_MS: 1000,
        SLOW_TICK_MS: 3000,
        PSI_CPU_WARN: 8.0,
        PSI_CPU_CRITICAL: 20.0,
        PSI_MEM_WARN: 4.0,
        PSI_MEM_CRITICAL: 12.0,
      },
      daemonState: {
        stressLevel: 'NORMAL',
        foregroundPid: 1234,
        throttledCount: 0,
        plugins: ['steam', 'game'],
      },
    });

    assert.ok(result.checks);
    assert.ok(result.checks.length > 0);
    assert.ok(typeof result.score === 'number');
    assert.ok(typeof result.percentage === 'number');
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.timestamp);
  });

  it('should include binary checks', () => {
    const { DoctorEngine } = require('../../intelligence/doctor-engine');
    const doctor = new DoctorEngine();

    const result = doctor.run({ config: {}, daemonState: {} });
    const binCheck = result.checks.find(c => c.name === 'Required Binaries');
    assert.ok(binCheck);
    // renice and ionice should always exist on Linux
    assert.ok(binCheck.status === 'PASS' || binCheck.status === 'ERROR');
  });

  it('should detect config issues', () => {
    const { DoctorEngine } = require('../../intelligence/doctor-engine');
    const doctor = new DoctorEngine();

    const result = doctor.run({
      config: {
        FAST_TICK_MS: 50,  // very low
        SLOW_TICK_MS: 200,  // very low
        PSI_CPU_WARN: 25,
        PSI_CPU_CRITICAL: 20,  // WARN > CRITICAL
      },
      daemonState: {},
    });

    const configCheck = result.checks.find(c => c.name === 'Configuration');
    assert.ok(configCheck);
    assert.ok(configCheck.status === 'WARNING');
  });
});

// ── Report Generator Tests ─────────────────────────────────────────────

describe('ReportGenerator', () => {

  it('should generate valid HTML', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      system: { hostname: 'test', kernel: '5.15', arch: 'x64', cpuCount: 8, totalMemory: 16384 },
      status: { stressLevel: 'NORMAL', foregroundPid: 1234, throttledCount: 0, uptime: 3600 },
      config: { FAST_TICK_MS: 1000, ENABLE_INTELLIGENCE: true },
    });

    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('DynAlloc Diagnostic Report'));
    assert.ok(html.includes('System Information'));
    assert.ok(html.includes('</html>'));
    assert.ok(html.length > 1000);
  });

  it('should render health score', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      doctor: {
        percentage: 85,
        summary: 'Good',
        checks: [
          { name: 'Test Check', status: 'PASS', message: 'OK' },
          { name: 'Warn Check', status: 'WARNING', message: 'Caution' },
        ],
      },
    });

    assert.ok(html.includes('85%'));
    assert.ok(html.includes('score-good') || html.includes('Good'));
    assert.ok(html.includes('Test Check'));
  });

  it('should render timeline with categories', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      timeline: [
        { ts: Date.now(), category: 'scheduler', event: 'boost', summary: 'Boosted steam', severity: 'info' },
        { ts: Date.now(), category: 'system', event: 'thermal', summary: 'CPU temp high', severity: 'warn' },
      ],
    });

    assert.ok(html.includes('cat-scheduler'));
    assert.ok(html.includes('cat-system'));
    assert.ok(html.includes('Boosted steam'));
  });

  it('should render recommendations', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      recommendations: [
        {
          id: 'rec-1', type: 'auto-profile', priority: 'high',
          summary: 'Steam is usually gaming', suggestion: 'Create a policy?',
          confidence: 0.85, createdAt: Date.now(), status: 'pending',
        },
      ],
    });

    assert.ok(html.includes('Steam is usually gaming'));
    assert.ok(html.includes('badge-high'));
  });

  it('should render explanations', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      explanations: [
        {
          id: 0, ts: Date.now(), decision: 'boost', target: 'steam (PID 1234)',
          source: 'scheduler', outcome: 'Full boost applied',
          factors: [
            { check: 'CPU pressure acceptable', result: true, value: 10 },
            { check: 'Battery low', result: false, value: 15 },
          ],
        },
      ],
    });

    assert.ok(html.includes('boost'));
    assert.ok(html.includes('factor-pass'));
    assert.ok(html.includes('factor-fail'));
  });

  it('should render configuration', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      config: { FAST_TICK_MS: 1000, ENABLE_INTELLIGENCE: true, LOG_LEVEL: 'info' },
    });

    assert.ok(html.includes('FAST_TICK_MS'));
    assert.ok(html.includes('1000'));
  });

  it('should escape HTML entities in content', () => {
    const { ReportGenerator } = require('../../intelligence/report-generator');
    const gen = new ReportGenerator();

    const html = gen.generate({
      version: '2.0.0',
      status: { stressLevel: 'NORMAL<script>', foregroundPid: null, throttledCount: 0, uptime: 0 },
    });

    // The report's own <script> tag should exist, but
    // the stress level should be escaped
    assert.ok(html.includes('&lt;script&gt;'));
    // The escaped version should NOT contain unescaped script tag in content
    // (the only <script> should be the report's own JS at the bottom)
    const scriptCount = (html.match(/<script/g) || []).length;
    assert.ok(scriptCount <= 1, `Expected at most 1 script tag, found ${scriptCount}`);
  });
});

// ── Integration: Intelligence Module Index ─────────────────────────────

describe('Intelligence Module Index', () => {

  it('should export all components', () => {
    const mod = require('../../intelligence');
    assert.ok(mod.LearningEngine);
    assert.ok(mod.RecommendationEngine);
    assert.ok(mod.ExplainabilityEngine);
    assert.ok(mod.TimelineEngine);
    assert.ok(mod.CATEGORIES);
    assert.ok(mod.SEVERITIES);
  });
});