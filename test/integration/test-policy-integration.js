'use strict';

/**
 * DynAlloc — Policy Engine Integration Tests
 * ==========================================
 *
 * Verifies that the Policy Engine integrates correctly with the
 * existing daemon subsystems (Actuator, GovernorManager, Scheduler)
 * and does NOT break any existing behavior when ENABLE_POLICY_ENGINE
 * is false.
 *
 * Run: node --test test/integration/test-policy-integration.js
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Silence logger
const logger = require('../../logger');
logger.setLevel('fatal');

// ── Imports ───────────────────────────────────────────────────────────

const { PolicyEngine, EVENTS } = require('../../policy-engine');
const { EventSources } = require('../../policy-engine/event-sources');
const { DEFAULT_CONFIG } = require('../../config');
const { Scheduler } = require('../../scheduler');
const { CpuHistory } = require('../../sensor');
const Actuator = require('../../actuator');
const GovernorManager = require('../../governor');
const { getMetrics, resetMetrics } = require('../../metrics');

// ── Helpers ───────────────────────────────────────────────────────────

function mockTopology(logicalCount = 4) {
  const allCores = Array.from({ length: logicalCount }, (_, i) => i);
  return {
    logicalCount,
    physicalCount: logicalCount,
    smtEnabled: false,
    threadsPerCore: 1,
    numaNodes: [],
    isHybrid: false,
    pCores: [],
    eCores: [],
    isAMD: false,
    ccds: [],
    ccdCount: 0,
    logicalToPhysical: new Map(allCores.map((c) => [c, c])),
    threadSiblings: new Map(allCores.map((c) => [c, [c]])),
  };
}

function makeConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    DRY_RUN: true, // never touch the real system
    ENABLE_POLICY_ENGINE: true,
    POLICY_HOT_RELOAD: false,
    ENABLE_METRICS: true,
    ENABLE_GOVERNOR_SWITCH: false, // skip real cpufreq calls
    ...overrides,
  };
}

function makeRealSubsystems(config) {
  const cpuHistory = new CpuHistory(config.CPU_HISTORY_SIZE || 5);
  const scheduler = new Scheduler(config, mockTopology(), cpuHistory);
  const actuator = new Actuator(config);
  const governor = new GovernorManager();
  return { scheduler, actuator, governor, cpuHistory };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Policy Engine Integration', () => {
  describe('with ENABLE_POLICY_ENGINE = false (default)', () => {
    it('should not load the policy engine module at all', () => {
      // The daemon's bootstrap() gates the require() behind
      // CONFIG.ENABLE_POLICY_ENGINE. Here we just verify that the
      // config default is false.
      assert.equal(DEFAULT_CONFIG.ENABLE_POLICY_ENGINE, false);
    });

    it('should preserve all existing default config keys', () => {
      // Verify no existing keys were removed
      assert.equal(typeof DEFAULT_CONFIG.FAST_TICK_MS, 'number');
      assert.equal(typeof DEFAULT_CONFIG.PSI_CPU_WARN, 'number');
      assert.equal(typeof DEFAULT_CONFIG.ENABLE_PLUGINS, 'boolean');
      assert.equal(typeof DEFAULT_CONFIG.ENABLE_METRICS, 'boolean');
      // Verify new keys exist with correct types
      assert.equal(typeof DEFAULT_CONFIG.POLICY_DEFAULT_COOLDOWN_MS, 'number');
      assert.equal(typeof DEFAULT_CONFIG.POLICY_MAX_RULES, 'number');
    });

    it('should not affect scheduler behavior when disabled', () => {
      const config = makeConfig({ ENABLE_POLICY_ENGINE: false });
      const { scheduler, cpuHistory } = makeRealSubsystems(config);
      const result = scheduler.tick(
        { cpuPSI: { some: { avg10: 0 } }, memPSI: { some: { avg10: 0 } } },
        { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null }
      );
      assert.equal(result.stressLevel, 'NORMAL');
    });
  });

  describe('with real subsystems', () => {
    let engine, sources, scheduler, actuator, governor, config;

    beforeEach(async () => {
      config = makeConfig({ ENABLE_POLICY_ENGINE: true });
      const sys = makeRealSubsystems(config);
      scheduler = sys.scheduler;
      actuator = sys.actuator;
      governor = sys.governor;
      const metrics = getMetrics();
      engine = new PolicyEngine({
        actuator, governor, scheduler, config, metrics, ownBus: true,
      });
      sources = new EventSources({ engine, config });
      await engine.start();
    });

    afterEach(async () => {
      try { await engine.stop(); } catch (_) {}
      try { engine.destroy(); } catch (_) {}
      resetMetrics();
    });

    it('should start cleanly with real subsystems', () => {
      assert.equal(engine.isRunning, true);
      assert.equal(engine.ruleEngine.size, 0); // no policy file loaded
    });

    it('should execute setGovernor action against real GovernorManager', async () => {
      // Inject a rule that triggers on onTest
      const { normalizeRule } = require('../../policy-engine/rule-engine');
      engine.ruleEngine.setRules([
        normalizeRule({
          id: 'gov-test',
          when: { event: 'onTest' },
          action: { type: 'setGovernor', governor: 'performance', cores: 'foreground' },
        }, { cooldownMs: 0 }, 0),
      ]);
      engine.emit('onTest', {});
      await new Promise((r) => setImmediate(r));
      const recent = engine.policyLogger.recentEntries(1);
      assert.equal(recent.length, 1);
      assert.equal(recent[0].success, true);
      assert.equal(recent[0].action.type, 'setGovernor');
    });

    it('should execute setSchedulerMode action against real CONFIG', async () => {
      const { normalizeRule } = require('../../policy-engine/rule-engine');
      const origWarn = config.PSI_CPU_WARN;
      engine.ruleEngine.setRules([
        normalizeRule({
          id: 'mode-test',
          when: { event: 'onTest' },
          action: { type: 'setSchedulerMode', mode: 'aggressive' },
        }, { cooldownMs: 0 }, 0),
      ]);
      engine.emit('onTest', {});
      await new Promise((r) => setImmediate(r));
      assert.equal(config.PSI_CPU_WARN, origWarn * 0.5);
    });

    it('should restore scheduler thresholds on rollback', async () => {
      const { normalizeRule } = require('../../policy-engine/rule-engine');
      const origWarn = config.PSI_CPU_WARN;
      const origCrit = config.PSI_CPU_CRITICAL;
      // Trigger a profile where schedulerMode succeeds first, then the
      // invalid governor fails — the executor should roll back the
      // schedulerMode change, restoring CONFIG to the original values.
      engine.executor.setProfiles({
        broken: {
          schedulerMode: 'aggressive',     // will succeed (applied first)
          governor: 'invalid_governor_name', // will fail (triggers rollback)
          governorCores: 'foreground',
        },
      });
      engine.ruleEngine.setRules([
        normalizeRule({
          id: 'broken-profile',
          when: { event: 'onTest' },
          action: { type: 'applyProfile', profile: 'broken' },
        }, { cooldownMs: 0 }, 0),
      ]);
      engine.emit('onTest', {});
      // Let both sub-steps (schedulerMode + governor) complete
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const recent = engine.policyLogger.recentEntries(1);
      assert.equal(recent.length, 1);
      assert.equal(recent[0].success, false);
      assert.equal(recent[0].rollbackApplied, true);
      // CONFIG should be restored to original values
      assert.equal(config.PSI_CPU_WARN, origWarn);
      assert.equal(config.PSI_CPU_CRITICAL, origCrit);
    });

    it('should emit onStressChanged when scheduler transitions', async () => {
      // Disable hysteresis so transitions happen on the first tick
      config.ENABLE_HYSTERESIS = false;
      scheduler.setConfig(config);

      const events = [];
      engine.bus.on(EVENTS.ON_STRESS_CHANGED, (p) => events.push(p));

      // Tick with high pressure → CRITICAL (avgs: cpu=50, mem=0)
      scheduler.tick(
        { cpuPSI: { some: { avg10: 50 } }, memPSI: { some: { avg10: 0 } } },
        { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null }
      );
      sources.updatePressure(50, 0, scheduler.stressLevel);

      assert.ok(events.length >= 1, `expected at least 1 stress-changed event, got ${events.length}`);
      assert.equal(events[0].to, 'CRITICAL');
    });

    it('should expose engine status via getStatus()', () => {
      const status = engine.getStatus();
      assert.equal(status.running, true);
      assert.equal(typeof status.ruleCount, 'number');
      assert.equal(typeof status.uptimeSeconds, 'number');
      assert.equal(typeof status.executorStats, 'object');
      assert.equal(typeof status.loggerStats, 'object');
      assert.equal(Array.isArray(status.recentExecutions), true);
    });

    it('should track policy-specific metrics', async () => {
      const { normalizeRule } = require('../../policy-engine/rule-engine');
      engine.ruleEngine.setRules([
        normalizeRule({
          id: 'metric-test',
          when: { event: 'onTest' },
          action: { type: 'log', message: 'hello' },
        }, { cooldownMs: 0 }, 0),
      ]);
      const metrics = getMetrics();
      const before = metrics.snapshot().policy_actions_executed || 0;
      engine.emit('onTest', {});
      await new Promise((r) => setImmediate(r));
      const after = metrics.snapshot().policy_actions_executed || 0;
      assert.ok(after > before, 'policy_actions_executed should have incremented');
    });

    it('should never crash on malformed actions', async () => {
      const { normalizeRule } = require('../../policy-engine/rule-engine');
      engine.ruleEngine.setRules([
        normalizeRule({
          id: 'malformed1',
          when: { event: 'onTest' },
          action: { type: 'applyProfile' }, // missing profile
        }, { cooldownMs: 0 }, 0),
        normalizeRule({
          id: 'malformed2',
          when: { event: 'onTest' },
          action: { type: 'setGovernor' }, // missing governor
        }, { cooldownMs: 0 }, 0),
        normalizeRule({
          id: 'malformed3',
          when: { event: 'onTest' },
          action: { type: 'emitEvent' }, // missing event name
        }, { cooldownMs: 0 }, 0),
      ]);
      engine.emit('onTest', {});
      // Let all async actions complete
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(engine.isRunning, true); // still alive
      const recent = engine.policyLogger.recentEntries(10);
      assert.equal(recent.length, 3);
      for (const entry of recent) {
        assert.equal(entry.success, false);
      }
    });
  });

  describe('hot-reload isolation', () => {
    it('should not interfere with main config hot-reload', () => {
      // The daemon's setupHotReload() only updates HOT_RELOADABLE_FIELDS.
      // ENABLE_POLICY_ENGINE is intentionally NOT in that list (it
      // controls module loading and requires restart).
      const { HOT_RELOADABLE_FIELDS } = require('../../config');
      assert.equal(HOT_RELOADABLE_FIELDS.includes('ENABLE_POLICY_ENGINE'), false);
      // But the tunable sub-keys ARE hot-reloadable
      assert.equal(HOT_RELOADABLE_FIELDS.includes('POLICY_DEFAULT_COOLDOWN_MS'), true);
      assert.equal(HOT_RELOADABLE_FIELDS.includes('POLICY_MAX_RULES'), true);
    });
  });

  describe('backward compatibility', () => {
    it('should not break existing scheduler API', () => {
      const config = makeConfig({ ENABLE_POLICY_ENGINE: true });
      const { scheduler } = makeRealSubsystems(config);
      // All existing scheduler methods should still work
      assert.equal(typeof scheduler.tick, 'function');
      assert.equal(typeof scheduler.classifyProcesses, 'function');
      assert.equal(typeof scheduler.generateForegroundBoost, 'function');
      assert.equal(typeof scheduler.setConfig, 'function');
      assert.deepEqual(scheduler.foregroundCores, [0, 1, 2, 3].slice(-2));
      assert.deepEqual(scheduler.backgroundCores, [0, 1]);
    });

    it('should not break existing actuator API', () => {
      const config = makeConfig();
      const actuator = new Actuator(config);
      assert.equal(typeof actuator.pinToCores, 'function');
      assert.equal(typeof actuator.setNiceness, 'function');
      assert.equal(typeof actuator.setIoPriority, 'function');
      assert.equal(typeof actuator.setOomScoreAdj, 'function');
      assert.equal(typeof actuator.restoreProcess, 'function');
      assert.equal(typeof actuator.setConfig, 'function');
    });

    it('should not break existing plugin manager API', () => {
      const { PluginManager, resetPluginManager } = require('../../plugin-manager');
      const pm = new PluginManager();
      assert.equal(typeof pm.register, 'function');
      assert.equal(typeof pm.unregister, 'function');
      assert.equal(typeof pm.runDetection, 'function');
      assert.equal(typeof pm.initAll, 'function');
      assert.equal(typeof pm.destroyAll, 'function');
      resetPluginManager();
    });
  });
});
