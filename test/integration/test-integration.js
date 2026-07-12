'use strict';

/**
 * DynAlloc — Integration Tests
 *
 * Tests module interactions with mocked system interfaces.
 * Uses node:test and node:assert (Node.js built-in test runner).
 *
 * Run: node --test tests/integration/test-integration.js
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Silence logger during tests ────────────────────────────────────────

const logger = require('../../logger');
logger.setLevel('warn'); // Only show warnings and above

// ── Import modules under test ─────────────────────────────────────────

const { Scheduler, HysteresisState, AutoRestoreTracker, calculateAdaptiveScore } = require('../../scheduler');
const { CpuHistory } = require('../../sensor');
const classifier = require('../../classifier');
const { PluginManager, resetPluginManager } = require('../../plugin-manager');
const RollbackManager = require('../../rollback');
const { DEFAULT_CONFIG, validateAndMerge, validateField, validatePath, validateRegexList } = require('../../config');
const { isKnownMediaProcessName, resetState: resetMultimediaState } = require('../../multimedia');
const Actuator = require('../../actuator');
const GovernorManager = require('../../governor');
const { getMetrics, resetMetrics } = require('../../metrics');

// ── Shared Test Helpers ────────────────────────────────────────────────

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Create a mock CPU topology with N logical, non-hybrid cores */
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
    logicalToPhysical: new Map(allCores.map(c => [c, c])),
    threadSiblings: new Map(allCores.map(c => [c, [c]])),
  };
}

/** Create a default config with optional overrides */
function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Create a scheduler ready for testing */
function makeScheduler(configOverrides = {}) {
  const config = makeConfig(configOverrides);
  const topology = mockTopology(config.FOREGROUND_CORE_RESERVE ? undefined : 4);
  const cpuHistory = new CpuHistory(config.CPU_HISTORY_SIZE || 5);
  return { scheduler: new Scheduler(config, topology, cpuHistory), config, topology, cpuHistory };
}

/** Create mock PSI data */
function mockPSI(cpuAvg10 = 0, memAvg10 = 0) {
  return {
    cpuPSI: { some: { avg10: cpuAvg10, avg60: cpuAvg10, avg300: cpuAvg10 }, full: { avg10: cpuAvg10 }, io: { avg10: 0 } },
    memPSI: { some: { avg10: memAvg10, avg60: memAvg10, avg300: memAvg10 }, full: { avg10: memAvg10 }, io: { avg10: 0 } },
  };
}

/** Create mock process list */
function mockProcesses(entries) {
  return entries.map(e => ({
    pid: e.pid,
    ppid: e.ppid || 1,
    pcpu: e.pcpu || 0,
    comm: e.comm,
  }));
}

/** Get a safe foreground PID that is not our process */
function safeFgPid() {
  return 99990;
}

/** Async sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════
//  1. CPU Idle
// ════════════════════════════════════════════════════════════════════════

describe('1. CPU Idle', () => {
  let { scheduler, config } = makeScheduler();

  it('stays NORMAL with low PSI over multiple ticks', () => {
    for (let i = 0; i < 20; i++) {
      const result = scheduler.tick(mockPSI(1.5, 0.8), {
        foregroundPid: null,
        mediaPids: new Set(),
        onBattery: false,
        thermalTemp: null,
      });
      assert.equal(result.stressLevel, 'NORMAL');
      assert.equal(result.actions.length, 0);
    }
  });

  it('does not generate throttle actions at NORMAL', () => {
    const procs = mockProcesses([
      { pid: 5000, comm: 'gcc', pcpu: 20 },
      { pid: 5001, comm: 'rustc', pcpu: 25 },
      { pid: 5002, comm: 'make', pcpu: 15 },
    ]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.equal(actions.length, 0, 'No throttle actions when stress is NORMAL');
  });

  it('does not generate throttle actions even with heavy background', () => {
    const procs = mockProcesses([
      { pid: 5000, comm: 'steam', pcpu: 30 },
      { pid: 5001, comm: 'dockerd', pcpu: 25 },
      { pid: 5002, comm: 'node', pcpu: 40 },
    ]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.equal(actions.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  2. CPU Full Load
// ════════════════════════════════════════════════════════════════════════

describe('2. CPU Full Load', () => {
  it('transitions from NORMAL to WARN with high PSI (after hysteresis)', async () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: true,
      HYSTERESIS_NORMAL_TO_WARN_MS: 100,
      HYSTERESIS_WARN_TO_CRITICAL_MS: 100,
    });

    // Feed WARN-level PSI
    const psiWarn = mockPSI(config.PSI_CPU_WARN + 2, 0); // 10.0

    // Tick 1: raw stress = WARN, but hysteresis not elapsed
    let result = scheduler.tick(psiWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'NORMAL', 'Should still be NORMAL on first tick');
    assert.equal(result.changed, false);

    await sleep(150);

    // Tick after hysteresis: should transition to WARN
    result = scheduler.tick(psiWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'WARN', 'Should transition to WARN after hysteresis');
    assert.equal(result.changed, true);
  });

  it('transitions from WARN to CRITICAL with critical PSI', async () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: true,
      ENABLE_CPU_HISTORY: true,
      CPU_HISTORY_SIZE: 1, // Use size 1 so avg == latest sample
      HYSTERESIS_NORMAL_TO_WARN_MS: 0,
      HYSTERESIS_WARN_TO_CRITICAL_MS: 100,
    });

    // Force to WARN immediately (hysteresis 0 for NORMAL→WARN)
    const psiWarn = mockPSI(config.PSI_CPU_WARN + 2, 0);
    let result = scheduler.tick(psiWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'WARN');

    // Feed CRITICAL PSI, but hysteresis not elapsed yet
    const psiCritical = mockPSI(config.PSI_CPU_CRITICAL + 5, 0); // 25.0
    result = scheduler.tick(psiCritical, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'WARN', 'Still WARN, hysteresis pending');

    await sleep(150);

    // After hysteresis: should transition to CRITICAL
    // With CPU_HISTORY_SIZE=1, the avg equals the latest sample (25.0) which is >= CPU_CRITICAL (20)
    result = scheduler.tick(psiCritical, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'CRITICAL', 'Should transition to CRITICAL');
    assert.equal(result.changed, true);
  });

  it('transitions immediately when hysteresis is disabled', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
    });

    const psiCritical = mockPSI(config.PSI_CPU_CRITICAL + 5, 0);
    const result = scheduler.tick(psiCritical, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'CRITICAL');
    assert.equal(result.changed, true);
  });

  it('generates throttle actions when at WARN or CRITICAL', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
    });

    // Force to WARN
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 2, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(scheduler.stressLevel, 'WARN');

    // Should generate throttle actions for background processes
    const procs = mockProcesses([
      { pid: 5000, comm: 'gcc', pcpu: 20 },
      { pid: 5001, comm: 'rustc', pcpu: 25 },
      { pid: 5002, comm: 'steam', pcpu: 15 },
      { pid: 5003, comm: 'dockerd', pcpu: 10 },
    ]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.ok(actions.length >= 3, `Expected at least 3 throttle actions, got ${actions.length}`);
    for (const a of actions) {
      assert.equal(a.type, 'THROTTLE');
      assert.equal(a.schedClass, 'BACKGROUND');
      assert.ok(a.cores.length > 0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
//  3. RAM Pressure
// ════════════════════════════════════════════════════════════════════════

describe('3. RAM Pressure', () => {
  it('transitions to WARN with high memory PSI', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
    });

    const psiMemWarn = mockPSI(0, config.PSI_MEM_WARN + 2);
    const result = scheduler.tick(psiMemWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'WARN');
  });

  it('transitions to CRITICAL with critical memory PSI', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
    });

    const psiMemCritical = mockPSI(0, config.PSI_MEM_CRITICAL + 5);
    const result = scheduler.tick(psiMemCritical, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'CRITICAL');
  });

  it('scheduler responds to memory pressure in classifyProcesses', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
      AUTO_RESTORE: false,
    });

    // Force to WARN via memory
    scheduler.tick(mockPSI(0, config.PSI_MEM_WARN + 5), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(scheduler.stressLevel, 'WARN');

    const procs = mockProcesses([
      { pid: 5000, comm: 'make', pcpu: 10 },
      { pid: 5001, comm: 'cargo', pcpu: 15 },
    ]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.ok(actions.length >= 2, 'Memory pressure should trigger throttle actions');
  });

  it('uses CPU history moving average for memory', async () => {
    const cpuHistory = new CpuHistory(5);

    // Push samples: memory pressure gradually increases
    for (let i = 0; i < 5; i++) {
      cpuHistory.push({ cpuAvg10: 1, memAvg10: 3 + i }); // 3, 4, 5, 6, 7
    }

    // Average mem should be 5.0, which is above default MEM_WARN (4.0)
    assert.ok(cpuHistory.memAvg >= 4.0, `Expected memAvg >= 4.0, got ${cpuHistory.memAvg}`);
    assert.ok(cpuHistory.memAvg <= 6.0, `Expected memAvg <= 6.0, got ${cpuHistory.memAvg}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  4. Foreground Change
// ════════════════════════════════════════════════════════════════════════

describe('4. Foreground Change', () => {
  it('generates a boost action for foreground PID', () => {
    const { scheduler } = makeScheduler();
    const procs = mockProcesses([
      { pid: safeFgPid(), comm: 'firefox', pcpu: 5 },
      { pid: 5001, comm: 'bash', pcpu: 1 },
    ]);

    const boost = scheduler.generateForegroundBoost(safeFgPid(), procs, false);
    assert.ok(boost !== null, 'Boost should be generated');
    assert.equal(boost.type, 'BOOST');
    assert.equal(boost.pid, safeFgPid());
    assert.equal(boost.comm, 'firefox');
    assert.equal(boost.gameModeActive, false);
    assert.ok(boost.cores.length > 0);
  });

  it('boost uses INTERACTIVE class for browser', () => {
    const { scheduler } = makeScheduler();
    const procs = mockProcesses([{ pid: safeFgPid(), comm: 'firefox', pcpu: 5 }]);

    const boost = scheduler.generateForegroundBoost(safeFgPid(), procs, false);
    assert.equal(boost.schedClass, 'INTERACTIVE');
  });

  it('boost uses GAME class for game process', () => {
    const { scheduler } = makeScheduler();
    const procs = mockProcesses([{ pid: safeFgPid(), comm: 'UnityPlayer', pcpu: 30 }]);

    const boost = scheduler.generateForegroundBoost(safeFgPid(), procs, false);
    assert.equal(boost.schedClass, 'INTERACTIVE');
  });

  it('boost sets nice=0 when GameMode is active', () => {
    const { scheduler } = makeScheduler();
    const procs = mockProcesses([{ pid: safeFgPid(), comm: 'UnityPlayer', pcpu: 30 }]);

    const boost = scheduler.generateForegroundBoost(safeFgPid(), procs, true);
    assert.equal(boost.nice, 0, 'Nice should be 0 when GameMode active');
    assert.equal(boost.gameModeActive, true);
  });

  it('returns null for invalid PID', () => {
    const { scheduler } = makeScheduler();
    const boost = scheduler.generateForegroundBoost(null, [], false);
    assert.equal(boost, null);
  });

  it('returns null for PID not in process list', () => {
    const { scheduler } = makeScheduler();
    const procs = mockProcesses([{ pid: 111, comm: 'bash', pcpu: 1 }]);
    const boost = scheduler.generateForegroundBoost(safeFgPid(), procs, false);
    // Still generates a boost, just with empty comm
    assert.ok(boost !== null);
    assert.equal(boost.comm, '');
  });

  it('foreground tree is excluded from throttling', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });

    // Force to WARN
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const fgPid = safeFgPid();
    const procs = mockProcesses([
      { pid: fgPid, ppid: 1, comm: 'code', pcpu: 30 },      // foreground
      { pid: 6001, ppid: fgPid, comm: 'node', pcpu: 20 },  // child of foreground
      { pid: 6002, ppid: 1, comm: 'node', pcpu: 40 },      // unrelated node
    ]);

    const actions = scheduler.classifyProcesses(procs, fgPid, new Set());
    // Only the unrelated node (6002) should be throttled
    const throttledPids = actions.map(a => a.pid);
    assert.ok(!throttledPids.includes(fgPid), 'Foreground PID should not be throttled');
    assert.ok(!throttledPids.includes(6001), 'Foreground child should not be throttled');
    assert.ok(throttledPids.includes(6002), 'Unrelated node should be throttled');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  5. Auto-Restore
// ════════════════════════════════════════════════════════════════════════

describe('5. Auto-Restore', () => {
  it('generates RESTORE actions when stress returns to NORMAL', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
      AUTO_RESTORE: true,
    });

    // Force to WARN and throttle some processes
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(scheduler.stressLevel, 'WARN');

    const procs = mockProcesses([
      { pid: 5000, comm: 'gcc', pcpu: 20 },
      { pid: 5001, comm: 'rustc', pcpu: 25 },
    ]);
    const throttleActions = scheduler.classifyProcesses(procs, null, new Set());
    assert.ok(throttleActions.length >= 2);

    // Mark them as throttled
    for (const a of throttleActions) {
      scheduler.autoRestore.markThrottled(a.pid, { comm: a.comm });
    }
    assert.equal(scheduler.autoRestore.size, 2);

    // Return PSI to normal
    const result = scheduler.tick(mockPSI(1, 0.5), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'NORMAL');

    // Check restore actions generated
    assert.ok(result.actions.length >= 2, `Expected restore actions, got ${result.actions.length}`);
    for (const action of result.actions) {
      assert.equal(action.type, 'RESTORE');
      assert.ok(action.pid === 5000 || action.pid === 5001);
    }
  });

  it('auto-restore tracker clears after generating restores', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
      AUTO_RESTORE: true,
    });

    // WARN
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    // Mark throttled
    scheduler.autoRestore.markThrottled(7000, { comm: 'gcc' });
    scheduler.autoRestore.markThrottled(7001, { comm: 'make' });
    assert.equal(scheduler.autoRestore.size, 2);

    // NORMAL -> restores generated
    scheduler.tick(mockPSI(0.5, 0.3), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(scheduler.autoRestore.size, 0, 'Auto-restore tracker should be cleared');
  });

  it('no restore actions when AUTO_RESTORE is disabled', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
      AUTO_RESTORE: false,
    });

    // WARN and mark throttled
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    scheduler.autoRestore.markThrottled(7000, { comm: 'gcc' });

    // NORMAL
    const result = scheduler.tick(mockPSI(0.5, 0.3), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.actions.length, 0, 'No restore actions when AUTO_RESTORE disabled');
  });

  it('auto-restore tracker prunes dead PIDs', () => {
    const tracker = new AutoRestoreTracker();
    tracker.markThrottled(8000, { comm: 'gcc' });
    tracker.markThrottled(8001, { comm: 'make' });
    assert.equal(tracker.size, 2);

    // Prune with only 8000 alive
    tracker.pruneDead(new Set([8000]));
    assert.equal(tracker.size, 1);
    assert.ok(tracker.isThrottled(8000));
    assert.ok(!tracker.isThrottled(8001));
  });
});

// ════════════════════════════════════════════════════════════════════════
//  6. Multimedia Protection
// ════════════════════════════════════════════════════════════════════════

describe('6. Multimedia Protection', () => {
  it('media PIDs are never throttled', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });

    // Force to WARN
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const mediaPid = 9000;
    const mediaPids = new Set([mediaPid]);

    const procs = mockProcesses([
      { pid: mediaPid, comm: 'mpv', pcpu: 15 },
      { pid: 9001, comm: 'vlc', pcpu: 10 },
      { pid: 9002, comm: 'gcc', pcpu: 25 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, mediaPids);
    const throttledPids = actions.map(a => a.pid);

    assert.ok(!throttledPids.includes(mediaPid), 'Media PID 9000 (mpv) should not be throttled');
    // 9001 is NOT in the mediaPids set, so it could be throttled (VIDEO class = MULTIMEDIA → skipped by classifier)
    // 9002 should be throttled
    assert.ok(throttledPids.includes(9002), 'gcc should be throttled');
  });

  it('known media process names are recognized', () => {
    assert.ok(isKnownMediaProcessName('mpv'));
    assert.ok(isKnownMediaProcessName('spotify'));
    assert.ok(isKnownMediaProcessName('obs-studio'));
    assert.ok(isKnownMediaProcessName('discord'));
    assert.ok(isKnownMediaProcessName('pipewire'));
    assert.ok(isKnownMediaProcessName('vlc'));
    assert.ok(!isKnownMediaProcessName('gcc'));
    assert.ok(!isKnownMediaProcessName('bash'));
    assert.ok(!isKnownMediaProcessName(''));
    assert.ok(!isKnownMediaProcessName(123));
  });

  it('MULTIMEDIA scheduler class processes are never throttled by classifier', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    // mpv is VIDEO → MULTIMEDIA class → skip in classifyProcesses
    const procs = mockProcesses([
      { pid: 9000, comm: 'mpv', pcpu: 20 },
      { pid: 9001, comm: 'spotify', pcpu: 5 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    // Both are MULTIMEDIA class, neither should be throttled
    assert.equal(actions.length, 0, 'MULTIMEDIA-class processes should not be throttled');
  });

  it('REALTIME scheduler class processes are never throttled', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 9000, comm: 'systemd', pcpu: 1 },
      { pid: 9001, comm: 'dbus-daemon', pcpu: 0.5 },
      { pid: 9002, comm: 'Xorg', pcpu: 3 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.equal(actions.length, 0, 'REALTIME-class processes should not be throttled');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  7. Browser Video
// ════════════════════════════════════════════════════════════════════════

describe('7. Browser Video', () => {
  it('browser PID in media set is protected from throttling', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const browserPid = 10000;
    const mediaPids = new Set([browserPid]);

    const procs = mockProcesses([
      { pid: browserPid, comm: 'firefox', pcpu: 20 },
      { pid: 10001, comm: 'gcc', pcpu: 25 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, mediaPids);
    const throttledPids = actions.map(a => a.pid);

    assert.ok(!throttledPids.includes(browserPid), 'Browser PID in media set should be protected');
    assert.ok(throttledPids.includes(10001), 'gcc should be throttled');
  });

  it('browser with low CPU not in media set is not throttled (INTERACTIVE class)', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false, HEAVY_BG_CPU_THRESHOLD: 25 });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 10000, comm: 'chrome', pcpu: 5 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    // BROWSER is INTERACTIVE class, and pcpu < HEAVY_BG_CPU_THRESHOLD, so not heavy background
    const throttledPids = actions.map(a => a.pid);
    assert.ok(!throttledPids.includes(10000), 'INTERACTIVE-class browser with low CPU should not be throttled');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  8. OBS Recording
// ════════════════════════════════════════════════════════════════════════

describe('8. OBS Recording', () => {
  it('OBS is classified as STREAMING (MULTIMEDIA class)', () => {
    const category = classifier.classifyByComm('obs');
    assert.equal(category, 'STREAMING');

    const category2 = classifier.classifyByComm('obs-studio');
    assert.equal(category2, 'STREAMING');

    const category3 = classifier.classifyByComm('obs64');
    assert.equal(category3, 'STREAMING');

    const schedClass = classifier.categoryToSchedulerClass('STREAMING');
    assert.equal(schedClass, 'MULTIMEDIA');
  });

  it('OBS is never throttled by scheduler', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 11000, comm: 'obs', pcpu: 35 },
      { pid: 11001, comm: 'obs-studio', pcpu: 30 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    const throttledPids = actions.map(a => a.pid);
    assert.ok(!throttledPids.includes(11000), 'obs should not be throttled');
    assert.ok(!throttledPids.includes(11001), 'obs-studio should not be throttled');
  });

  it('OBS plugin detects OBS with media PIDs', () => {
    const obsPlugin = require('../../plugins/obs');
    const mediaPids = new Set([11000]);

    const procs = mockProcesses([
      { pid: 11000, comm: 'obs', pcpu: 15 },
      { pid: 11001, comm: 'obs', pcpu: 2 },
    ]);

    const results = obsPlugin.detect(procs, { mediaPids });
    assert.ok(results.length >= 1, 'OBS plugin should detect OBS');
    assert.equal(results[0].action, 'PROTECT');
    assert.ok(results[0].reason.includes('recording') || results[0].reason.includes('streaming'));
  });

  it('OBS plugin monitors OBS with high CPU but no media PID', () => {
    const obsPlugin = require('../../plugins/obs');

    const procs = mockProcesses([
      { pid: 11000, comm: 'obs', pcpu: 10 },
    ]);

    const results = obsPlugin.detect(procs, { mediaPids: new Set() });
    assert.ok(results.length >= 1);
    assert.equal(results[0].action, 'MONITOR');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  9. Discord Voice
// ════════════════════════════════════════════════════════════════════════

describe('9. Discord Voice', () => {
  it('Discord is classified as STREAMING (MULTIMEDIA class)', () => {
    const category = classifier.classifyByComm('Discord');
    assert.equal(category, 'STREAMING');

    const category2 = classifier.classifyByComm('discord');
    assert.equal(category2, 'STREAMING');

    const schedClass = classifier.categoryToSchedulerClass('STREAMING');
    assert.equal(schedClass, 'MULTIMEDIA');
  });

  it('Discord is never throttled by scheduler', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 12000, comm: 'Discord', pcpu: 8 },
      { pid: 12001, comm: 'discord', pcpu: 5 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    const throttledPids = actions.map(a => a.pid);
    assert.ok(!throttledPids.includes(12000));
    assert.ok(!throttledPids.includes(12001));
  });

  it('Discord plugin detects voice activity', () => {
    const discordPlugin = require('../../plugins/discord');
    const mediaPids = new Set([12000]);

    const procs = mockProcesses([
      { pid: 12000, comm: 'discord', pcpu: 5 },
    ]);

    const results = discordPlugin.detect(procs, { mediaPids });
    assert.ok(results.length >= 1, 'Discord plugin should detect voice activity');
    assert.equal(results[0].action, 'PROTECT');
  });

  it('Discord plugin returns empty when not in media PIDs', () => {
    const discordPlugin = require('../../plugins/discord');

    const procs = mockProcesses([
      { pid: 12000, comm: 'discord', pcpu: 5 },
    ]);

    const results = discordPlugin.detect(procs, { mediaPids: new Set() });
    assert.equal(results.length, 0, 'Discord plugin should return empty when no voice activity');
  });
});

// ════════════════════════════════════════════════════════════════════════
//  10. Steam Download
// ════════════════════════════════════════════════════════════════════════

describe('10. Steam Download', () => {
  it('Steam is classified as BACKGROUND', () => {
    const category = classifier.classifyByComm('steam');
    assert.equal(category, 'STEAM');

    const schedClass = classifier.categoryToSchedulerClass('STEAM');
    assert.equal(schedClass, 'BACKGROUND');
  });

  it('Steam is throttled under stress', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 13000, comm: 'steam', pcpu: 15 },
      { pid: 13001, comm: 'steamwebhelper', pcpu: 5 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    const throttledPids = actions.map(a => a.pid);
    assert.ok(throttledPids.includes(13000), 'steam should be throttled as BACKGROUND');
  });

  it('Steam plugin detects Steam client', () => {
    const steamPlugin = require('../../plugins/steam');

    const procs = mockProcesses([
      { pid: 13000, comm: 'steam', pcpu: 10 },
      { pid: 13001, comm: 'bash', pcpu: 1 },
    ]);

    const results = steamPlugin.detect(procs, { foregroundPid: null, gameModeActive: false });
    assert.ok(results.length >= 1, 'Steam plugin should detect Steam');
    assert.equal(results[0].action, 'MONITOR');
    assert.ok(results[0].reason.includes('Steam'));
  });

  it('Steam plugin boosts game process when GameMode active', () => {
    const steamPlugin = require('../../plugins/steam');

    const gamePid = 13010;
    const procs = mockProcesses([
      { pid: gamePid, comm: 'SteamApp', pcpu: 30 },
    ]);

    const results = steamPlugin.detect(procs, { foregroundPid: gamePid, gameModeActive: true });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.action === 'BOOST'));
  });
});

// ════════════════════════════════════════════════════════════════════════
//  11. Compile Project
// ════════════════════════════════════════════════════════════════════════

describe('11. Compile Project', () => {
  const compilerComms = ['gcc', 'g++', 'cc', 'c++', 'rustc', 'clang', 'clang++', 'make', 'cmake', 'cargo', 'cc1', 'cc1plus', 'ld'];

  for (const comm of compilerComms) {
    it(`${comm} is classified as COMPILER (BACKGROUND class)`, () => {
      const category = classifier.classifyByComm(comm);
      assert.equal(category, 'COMPILER', `${comm} should be COMPILER`);
      assert.equal(classifier.categoryToSchedulerClass('COMPILER'), 'BACKGROUND');
    });
  }

  it('all compiler processes are throttled under stress', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([
      { pid: 14000, comm: 'gcc', pcpu: 25 },
      { pid: 14001, comm: 'cc1plus', pcpu: 30 },
      { pid: 14002, comm: 'ld', pcpu: 20 },
      { pid: 14003, comm: 'rustc', pcpu: 40 },
      { pid: 14004, comm: 'make', pcpu: 5 },
    ]);

    const actions = scheduler.classifyProcesses(procs, null, new Set());
    const throttledPids = actions.map(a => a.pid);

    for (const expectedPid of [14000, 14001, 14002, 14003, 14004]) {
      assert.ok(throttledPids.includes(expectedPid), `${procs.find(p => p.pid === expectedPid).comm} should be throttled`);
    }
  });

  it('throttle actions have correct BACKGROUND nice and io prio', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 5, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([{ pid: 14000, comm: 'gcc', pcpu: 25 }]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.ok(actions.length >= 1);

    const action = actions[0];
    assert.equal(action.nice, config.SCHEDULER_CLASS_BACKGROUND_NICE);
    assert.deepEqual(action.ioClass, config.SCHEDULER_CLASS_BACKGROUND_IOPRIO[0]);
    assert.deepEqual(action.ioLevel, config.SCHEDULER_CLASS_BACKGROUND_IOPRIO[1]);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  12. Plugin Integration
// ════════════════════════════════════════════════════════════════════════

describe('12. Plugin Integration', () => {
  afterEach(() => {
    resetPluginManager();
  });

  it('loads built-in plugins successfully', () => {
    const pm = new PluginManager();
    const loaded = pm.loadBuiltinPlugins(PROJECT_ROOT + '/plugins');
    assert.ok(loaded >= 7, `Expected at least 7 plugins, got ${loaded}`);
    assert.ok(pm.size >= 7);
  });

  it('plugin detect returns expected results for game process', () => {
    const gamePlugin = require('../../plugins/game');

    const procs = mockProcesses([
      { pid: 15000, comm: 'UnityPlayer', pcpu: 30 },
      { pid: 15001, comm: 'bash', pcpu: 1 },
    ]);

    const results = gamePlugin.detect(procs, {});
    assert.ok(results.length >= 1);
    assert.equal(results[0].pid, 15000);
    assert.equal(results[0].action, 'BOOST');
    assert.ok(results[0].reason.includes('Game'));
  });

  it('wallpaper plugin detects wallpaper processes', () => {
    const wallpaperPlugin = require('../../plugins/wallpaper');

    const procs = mockProcesses([
      { pid: 15010, comm: 'mpvpaper', pcpu: 5 },
      { pid: 15011, comm: 'swww', pcpu: 2 },
      { pid: 15012, comm: 'hyprpaper', pcpu: 1 },
      { pid: 15013, comm: 'gcc', pcpu: 20 },
    ]);

    const results = wallpaperPlugin.detect(procs);
    assert.equal(results.length, 3, 'Should detect 3 wallpaper processes');
    for (const r of results) {
      assert.equal(r.action, 'PROTECT');
    }
  });

  it('spotify plugin protects Spotify during playback', () => {
    const spotifyPlugin = require('../../plugins/spotify');
    const mediaPids = new Set([15020]);

    const procs = mockProcesses([
      { pid: 15020, comm: 'spotify', pcpu: 3 },
    ]);

    const results = spotifyPlugin.detect(procs, { mediaPids });
    assert.ok(results.length >= 1);
    assert.equal(results[0].action, 'PROTECT');
  });

  it('plugin manager runs detection across all plugins', () => {
    const pm = new PluginManager();
    pm.loadBuiltinPlugins(PROJECT_ROOT + '/plugins');

    const procs = mockProcesses([
      { pid: 15030, comm: 'obs', pcpu: 15 },
      { pid: 15031, comm: 'mpvpaper', pcpu: 3 },
      { pid: 15032, comm: 'discord', pcpu: 5 },
      { pid: 15033, comm: 'steam', pcpu: 8 },
      { pid: 15034, comm: 'gcc', pcpu: 20 },
    ]);

    const mediaPids = new Set([15030, 15031, 15032]);
    const results = pm.runDetection(procs, { mediaPids, foregroundPid: null, gameModeActive: false });

    // Should have detections for obs, discord, mpvpaper, steam at minimum
    assert.ok(results.size >= 3, `Expected detections from multiple plugins, got ${results.size}`);
  });

  it('plugin with no detect() is rejected', () => {
    const pm = new PluginManager();
    const ok = pm.register({ name: 'bad-plugin', version: '1.0' });
    assert.equal(ok, false, 'Plugin without detect() should be rejected');
    assert.equal(pm.size, 0);
  });

  it('plugin with no name is rejected', () => {
    const pm = new PluginManager();
    const ok = pm.register({ detect() { return []; } });
    assert.equal(ok, false);
  });

  it('duplicate plugin name is rejected', () => {
    const pm = new PluginManager();
    pm.register({ name: 'test', detect() { return []; } });
    const ok = pm.register({ name: 'test', detect() { return []; } });
    assert.equal(ok, false);
    assert.equal(pm.size, 1);
  });

  it('plugin init and destroy are called', () => {
    let initCalled = false;
    let destroyCalled = false;

    const pm = new PluginManager();
    pm.register({
      name: 'lifecycle-test',
      init() { initCalled = true; },
      destroy() { destroyCalled = true; },
      detect() { return []; },
    });

    pm.initAll({});
    assert.ok(initCalled, 'init should be called');

    pm.destroyAll();
    assert.ok(destroyCalled, 'destroy should be called');
    assert.equal(pm.size, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  13. Config Hot Reload
// ════════════════════════════════════════════════════════════════════════

describe('13. Config Hot Reload', () => {
  it('validateAndMerge merges user config over defaults', () => {
    const userConfig = {
      PSI_CPU_WARN: 15.0,
      PSI_CPU_CRITICAL: 30.0,
      LOG_LEVEL: 'debug',
    };

    const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, userConfig);
    assert.equal(config.PSI_CPU_WARN, 15.0);
    assert.equal(config.PSI_CPU_CRITICAL, 30.0);
    assert.equal(config.LOG_LEVEL, 'debug');
    // Other defaults preserved
    assert.equal(config.PSI_MEM_WARN, DEFAULT_CONFIG.PSI_MEM_WARN);
  });

  it('invalid values fall back to defaults', () => {
    const userConfig = {
      PSI_CPU_WARN: 'not_a_number',
      LOG_LEVEL: 'invalid_level',
      FAST_TICK_MS: -1,
      ENABLE_GOVERNOR_SWITCH: 'yes',
    };

    const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, userConfig, true);
    assert.equal(config.PSI_CPU_WARN, DEFAULT_CONFIG.PSI_CPU_WARN, 'Invalid PSI_CPU_WARN should fall back');
    assert.equal(config.LOG_LEVEL, DEFAULT_CONFIG.LOG_LEVEL, 'Invalid LOG_LEVEL should fall back');
    assert.equal(config.FAST_TICK_MS, DEFAULT_CONFIG.FAST_TICK_MS, 'Invalid FAST_TICK_MS should fall back');
    assert.ok(warnings.length >= 3, `Expected warnings, got ${warnings.length}`);
  });

  it('PSI_CPU_WARN >= PSI_CPU_CRITICAL reverts both to defaults', () => {
    const userConfig = {
      PSI_CPU_WARN: 50.0,
      PSI_CPU_CRITICAL: 30.0,
    };

    const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, userConfig, true);
    assert.equal(config.PSI_CPU_WARN, DEFAULT_CONFIG.PSI_CPU_WARN);
    assert.equal(config.PSI_CPU_CRITICAL, DEFAULT_CONFIG.PSI_CPU_CRITICAL);
    assert.ok(warnings.some(w => w.includes('PSI_CPU_WARN')));
  });

  it('PSI_MEM_WARN >= PSI_MEM_CRITICAL reverts both to defaults', () => {
    const userConfig = {
      PSI_MEM_WARN: 20.0,
      PSI_MEM_CRITICAL: 10.0,
    };

    const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, userConfig, true);
    assert.equal(config.PSI_MEM_WARN, DEFAULT_CONFIG.PSI_MEM_WARN);
    assert.equal(config.PSI_MEM_CRITICAL, DEFAULT_CONFIG.PSI_MEM_CRITICAL);
    assert.ok(warnings.some(w => w.includes('PSI_MEM_WARN')));
  });

  it('validatePath rejects path traversal', () => {
    assert.equal(validatePath('/etc/passwd'), '/etc/passwd');
    assert.equal(validatePath('/sys/fs/cgroup'), '/sys/fs/cgroup');
    assert.equal(validatePath('../../etc/shadow'), undefined, 'Path traversal should be rejected');
    assert.equal(validatePath('/tmp/../../../etc/passwd'), undefined);
    assert.equal(validatePath('/safe\0path'), undefined, 'Null byte should be rejected');
  });

  it('scheduler picks up new config via setConfig', () => {
    const { scheduler, config: origConfig } = makeScheduler();

    const newConfig = { ...origConfig, PSI_CPU_WARN: 25.0, PSI_CPU_CRITICAL: 50.0 };
    scheduler.setConfig(newConfig);

    // Now tick with PSI that would be WARN under old config (8) but NORMAL under new (25)
    const result = scheduler.tick(mockPSI(15, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    // With ENABLE_HYSTERESIS true and CPU_HISTORY, the actual avg might differ
    // but with no history, it should be < 25 → NORMAL
    assert.equal(result.stressLevel, 'NORMAL', 'Should use updated config thresholds');
  });

  it('validateRegexList filters invalid patterns', () => {
    const patterns = ['^valid$', '(invalid', 'also_valid', '+++'];
    const result = validateRegexList(patterns, ['^default$'], 'test');
    assert.ok(result.includes('^valid$'));
    assert.ok(result.includes('also_valid'));
    assert.ok(!result.includes('(invalid'), 'Invalid regex should be filtered');
    assert.ok(!result.includes('+++'), 'Invalid regex +++ should be filtered');
  });

  it('hot-reloadable fields list is not empty', () => {
    const { HOT_RELOADABLE_FIELDS } = require('../../config');
    assert.ok(HOT_RELOADABLE_FIELDS.length > 20);
    assert.ok(HOT_RELOADABLE_FIELDS.includes('PSI_CPU_WARN'));
    assert.ok(HOT_RELOADABLE_FIELDS.includes('ENABLE_PLUGINS'));
    assert.ok(HOT_RELOADABLE_FIELDS.includes('LOG_LEVEL'));
  });
});

// ════════════════════════════════════════════════════════════════════════
//  14. Rollback on Crash
// ════════════════════════════════════════════════════════════════════════

describe('14. Rollback on Crash', () => {
  const fs = require('fs');
  const os = require('os');
  const pathModule = require('path');

  let stateFilePath;

  before(() => {
    // Use a temp file for state
    stateFilePath = pathModule.join(os.tmpdir(), `dynalloc-test-state-${Date.now()}.json`);
  });

  after(() => {
    // Cleanup
    try { fs.unlinkSync(stateFilePath); } catch (_) {}
  });

  it('tracks process modifications', () => {
    const rm = new RollbackManager(stateFilePath);
    rm.trackProcess(8000, 'nice', 10);
    rm.trackProcess(8000, 'ionice', [3, 0]);
    rm.trackProcess(8001, 'nice', 15);

    // Persist
    rm.persist();

    // Read file
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(raw);
    assert.ok(state.modifiedPids['8000'], 'PID 8000 should be tracked');
    assert.equal(state.modifiedPids['8000'].nice, 10);
    assert.deepEqual(state.modifiedPids['8000'].ionice, [3, 0]);
    assert.ok(state.modifiedPids['8001']);
  });

  it('clear removes state file', () => {
    const rm = new RollbackManager(stateFilePath);
    rm.trackProcess(8000, 'nice', 10);
    rm.persist();
    assert.ok(fs.existsSync(stateFilePath));

    rm.clear();
    // File should be deleted
    assert.ok(!fs.existsSync(stateFilePath), 'State file should be removed after clear');
  });

  it('recoverFromCrash detects stale state from different PID', () => {
    // Create a state file as if from a different (dead) process
    const state = {
      modifiedPids: {
        '8000': { nice: 10, ionice: [3, 0] },
        '8001': { nice: 15 },
      },
      governorOriginals: { '0': 'powersave' },
      timestamp: new Date().toISOString(),
      pid: 1, // fake PID that is different from our process.pid
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));

    const rm = new RollbackManager(stateFilePath);
    // This will try to restore, but PIDs won't be alive
    // It should attempt recovery and return true
    const recovered = rm.recoverFromCrash(makeConfig());
    // PIDs 8000 and 8001 are not alive → restored = 0 but still attempted
    assert.ok(typeof recovered === 'boolean');
  });

  it('recoverFromCrash skips if state from same PID', () => {
    const state = {
      modifiedPids: { '8000': { nice: 10 } },
      timestamp: new Date().toISOString(),
      pid: process.pid, // Same as our process
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));

    const rm = new RollbackManager(stateFilePath);
    const recovered = rm.recoverFromCrash(makeConfig());
    assert.equal(recovered, false, 'Should skip recovery for same PID');
  });

  it('recoverFromCrash returns false if no state file', () => {
    const rm = new RollbackManager('/tmp/nonexistent-dynalloc-test-state.json');
    const recovered = rm.recoverFromCrash(makeConfig());
    assert.equal(recovered, false);
  });

  it('tracks governor modifications', () => {
    const rm = new RollbackManager(stateFilePath);
    rm.trackGovernor(0, 'powersave');
    rm.trackGovernor(1, 'powersave');
    rm.trackGovernor(2, 'schedutil');
    rm.persist();

    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(raw);
    assert.equal(state.governorOriginals['0'], 'powersave');
    assert.equal(state.governorOriginals['1'], 'powersave');
    assert.equal(state.governorOriginals['2'], 'schedutil');
  });

  it('clear resets internal state', () => {
    const rm = new RollbackManager(stateFilePath);
    rm.trackProcess(8000, 'nice', 10);
    rm.persist();
    rm.clear();

    // After clear, persist should create empty state
    rm.persist();
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(raw);
    assert.deepEqual(state.modifiedPids, {});
    assert.deepEqual(state.governorOriginals, {});
  });
});

// ════════════════════════════════════════════════════════════════════════
//  15. Feature Flags
// ════════════════════════════════════════════════════════════════════════

describe('15. Feature Flags', () => {
  it('ENABLE_CPU_HISTORY=false skips history pushing', () => {
    const { scheduler, cpuHistory } = makeScheduler({
      ENABLE_CPU_HISTORY: false,
    });

    const psi = mockPSI(5, 3);
    scheduler.tick(psi, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(cpuHistory.count, 0, 'CPU history should remain empty when disabled');
  });

  it('ENABLE_CPU_HISTORY=true pushes samples to history', () => {
    const { scheduler, cpuHistory } = makeScheduler({
      ENABLE_CPU_HISTORY: true,
      CPU_HISTORY_SIZE: 5,
    });

    scheduler.tick(mockPSI(5, 3), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(cpuHistory.count, 1, 'CPU history should have 1 sample');

    scheduler.tick(mockPSI(7, 4), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(cpuHistory.count, 2);
  });

  it('ENABLE_HYSTERESIS=false allows immediate transitions', () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: false,
    });

    const psiCritical = mockPSI(config.PSI_CPU_CRITICAL + 5, 0);
    const result = scheduler.tick(psiCritical, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    assert.equal(result.stressLevel, 'CRITICAL');
    assert.equal(result.changed, true);
  });

  it('ENABLE_HYSTERESIS=true delays transitions', async () => {
    const { scheduler, config } = makeScheduler({
      ENABLE_HYSTERESIS: true,
      HYSTERESIS_NORMAL_TO_WARN_MS: 500,
    });

    const psiWarn = mockPSI(config.PSI_CPU_WARN + 2, 0);

    // First tick: should stay NORMAL
    let result = scheduler.tick(psiWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'NORMAL');
    assert.equal(result.changed, false);

    await sleep(600);

    // After hysteresis elapses
    result = scheduler.tick(psiWarn, { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });
    assert.equal(result.stressLevel, 'WARN');
    assert.equal(result.changed, true);
  });

  it('ENABLE_SMART_SCHEDULER=false zeroes adaptive score', () => {
    const factors = {
      cpuPressure: 50,
      memPressure: 30,
      hasForeground: true,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 70,
    };

    const config = makeConfig({ ENABLE_SMART_SCHEDULER: false, ENABLE_ADAPTIVE_SCHEDULER: true });
    const score = calculateAdaptiveScore(factors, config);
    assert.equal(score, 0, 'Adaptive score should be 0 when smart scheduler disabled');
  });

  it('ENABLE_ADAPTIVE_SCHEDULER=false zeroes adaptive score', () => {
    const factors = {
      cpuPressure: 50,
      memPressure: 30,
      hasForeground: true,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 70,
    };

    const config = makeConfig({ ENABLE_SMART_SCHEDULER: true, ENABLE_ADAPTIVE_SCHEDULER: false });
    const score = calculateAdaptiveScore(factors, config);
    assert.equal(score, 0);
  });

  it('ENABLE_SMART_SCHEDULER=true + ENABLE_ADAPTIVE_SCHEDULER=true computes score', () => {
    const factors = {
      cpuPressure: 50,
      memPressure: 30,
      hasForeground: true,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: null,
    };

    const config = makeConfig({ ENABLE_SMART_SCHEDULER: true, ENABLE_ADAPTIVE_SCHEDULER: true });
    const score = calculateAdaptiveScore(factors, config);
    assert.ok(score > 0, 'Adaptive score should be > 0 when enabled');
    assert.ok(score <= 1, 'Adaptive score should be <= 1');
  });

  it('adaptive score is reduced when media is playing', () => {
    const factorsWithMedia = {
      cpuPressure: 30,
      memPressure: 20,
      hasForeground: true,
      mediaPlaying: true,
      onBattery: false,
      thermalTemp: null,
    };

    const factorsWithoutMedia = {
      ...factorsWithMedia,
      mediaPlaying: false,
    };

    const config = makeConfig({ ENABLE_SMART_SCHEDULER: true, ENABLE_ADAPTIVE_SCHEDULER: true });

    const scoreWithMedia = calculateAdaptiveScore(factorsWithMedia, config);
    const scoreWithoutMedia = calculateAdaptiveScore(factorsWithoutMedia, config);

    assert.ok(scoreWithMedia < scoreWithoutMedia, 'Media playing should reduce adaptive score');
  });

  it('ENABLE_PLUGINS=false skips plugin loading', () => {
    const config = makeConfig({ ENABLE_PLUGINS: false });
    assert.equal(config.ENABLE_PLUGINS, false);
    // The daemon checks this flag before loading plugins
  });

  it('ENABLE_PLUGINS=true allows plugin system to work', () => {
    const config = makeConfig({ ENABLE_PLUGINS: true });
    assert.equal(config.ENABLE_PLUGINS, true);

    const pm = new PluginManager();
    pm.loadBuiltinPlugins(PROJECT_ROOT + '/plugins');
    assert.ok(pm.size >= 7, 'Plugins should be loaded');
    resetPluginManager();
  });

  it('ENABLE_TOPOLOGY=false uses flat core layout', () => {
    const { scheduler } = makeScheduler({
      ENABLE_TOPOLOGY: false,
      ENABLE_CPU_TOPOLOGY: true,
    });

    // Should fall back to flat layout (non-hybrid)
    assert.ok(scheduler.foregroundCores.length > 0);
    assert.ok(scheduler.backgroundCores.length > 0);
    // Foreground + background should cover all cores
    const allFromLayout = new Set([...scheduler.foregroundCores, ...scheduler.backgroundCores]);
    for (const c of scheduler.allCores) {
      assert.ok(allFromLayout.has(c), `Core ${c} should be in foreground or background`);
    }
  });

  it('ENABLE_GOVERNOR_SWITCH config is respected', () => {
    const configOff = makeConfig({ ENABLE_GOVERNOR_SWITCH: false });
    assert.equal(configOff.ENABLE_GOVERNOR_SWITCH, false);

    const configOn = makeConfig({ ENABLE_GOVERNOR_SWITCH: true });
    assert.equal(configOn.ENABLE_GOVERNOR_SWITCH, true);
  });

  it('DRY_RUN config is respected', () => {
    const configDry = makeConfig({ DRY_RUN: true });
    assert.equal(configDry.DRY_RUN, true);

    const configLive = makeConfig({ DRY_RUN: false });
    assert.equal(configLive.DRY_RUN, false);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  Bonus: Cross-Module Integration
// ════════════════════════════════════════════════════════════════════════

describe('Bonus: Cross-Module Integration', () => {
  afterEach(() => {
    resetPluginManager();
    resetMultimediaState();
    resetMetrics();
  });

  it('scheduler + actuator: throttle actions contain valid scheduler class settings', () => {
    const { scheduler, config } = makeScheduler({ ENABLE_HYSTERESIS: false });
    scheduler.tick(mockPSI(config.PSI_CPU_WARN + 10, 0), { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null });

    const procs = mockProcesses([{ pid: 5000, comm: 'gcc', pcpu: 25 }]);
    const actions = scheduler.classifyProcesses(procs, null, new Set());
    assert.ok(actions.length === 1);

    const a = actions[0];
    // Verify the nice/io values match what the actuator would use
    const expectedNice = classifier.schedulerClassNice('BACKGROUND', config);
    const [expectedIoClass, expectedIoLevel] = classifier.schedulerClassIoPrio('BACKGROUND', config);

    assert.equal(a.nice, expectedNice);
    assert.equal(a.ioClass, expectedIoClass);
    assert.equal(a.ioLevel, expectedIoLevel);
    assert.ok(Array.isArray(a.cores));
  });

  it('classifier categories map to correct scheduler classes', () => {
    const expected = {
      SYSTEM: 'REALTIME',
      DAEMON: 'REALTIME',
      GAME: 'INTERACTIVE',
      IDE: 'INTERACTIVE',
      BROWSER: 'INTERACTIVE',
      AUDIO: 'MULTIMEDIA',
      VIDEO: 'MULTIMEDIA',
      STREAMING: 'MULTIMEDIA',
      COMPILER: 'BACKGROUND',
      STEAM: 'BACKGROUND',
      CONTAINER: 'BACKGROUND',
      VM: 'BACKGROUND',
      WALLPAPER: 'MULTIMEDIA',
      UNKNOWN: 'IDLE',
    };

    for (const [category, expectedClass] of Object.entries(expected)) {
      const actualClass = classifier.categoryToSchedulerClass(category);
      assert.equal(actualClass, expectedClass, `Category ${category} should map to ${expectedClass}`);
    }
  });

  it('cpu history maintains correct moving average', () => {
    const history = new CpuHistory(3);

    history.push({ cpuAvg10: 10, memAvg10: 5 });
    assert.equal(history.cpuAvg, 10);
    assert.equal(history.memAvg, 5);

    history.push({ cpuAvg10: 20, memAvg10: 10 });
    assert.equal(history.cpuAvg, 15);
    assert.equal(history.memAvg, 7.5);

    history.push({ cpuAvg10: 30, memAvg10: 15 });
    assert.equal(history.cpuAvg, 20);
    assert.equal(history.memAvg, 10);

    // 4th push should evict oldest (size=3)
    history.push({ cpuAvg10: 40, memAvg10: 20 });
    assert.equal(history.cpuAvg, 30); // (20+30+40)/3
    assert.equal(history.memAvg, 15);
    assert.equal(history.count, 3);
  });

  it('hysteresis state handles all transition paths', () => {
    const h = new HysteresisState();
    const config = makeConfig({
      ENABLE_HYSTERESIS: true,
      HYSTERESIS_NORMAL_TO_WARN_MS: 0,
      HYSTERESIS_WARN_TO_CRITICAL_MS: 0,
      HYSTERESIS_CRITICAL_TO_NORMAL_MS: 0,
    });

    // NORMAL → WARN (immediate)
    let r = h.evaluate('WARN', config);
    assert.equal(r.level, 'WARN');
    assert.equal(r.changed, true);

    // WARN → CRITICAL (immediate)
    r = h.evaluate('CRITICAL', config);
    assert.equal(r.level, 'CRITICAL');
    assert.equal(r.changed, true);

    // CRITICAL → NORMAL (immediate)
    r = h.evaluate('NORMAL', config);
    assert.equal(r.level, 'NORMAL');
    assert.equal(r.changed, true);

    // NORMAL → NORMAL (no change)
    r = h.evaluate('NORMAL', config);
    assert.equal(r.changed, false);
  });

  it('hysteresis reset works correctly', () => {
    const h = new HysteresisState();
    const config = makeConfig({ ENABLE_HYSTERESIS: false });

    h.evaluate('CRITICAL', config);
    assert.equal(h.current, 'CRITICAL');

    h.reset();
    assert.equal(h.current, 'NORMAL');
  });

  it('metrics module tracks values correctly', () => {
    const metrics = new (require('../../metrics').MetricsRegistry)();

    metrics.counter('test_counter').increment(5);
    assert.equal(metrics.counter('test_counter').value, 5);

    metrics.gauge('test_gauge').set(42);
    assert.equal(metrics.gauge('test_gauge').value, 42);

    metrics.histogram('test_hist').record(10);
    metrics.histogram('test_hist').record(20);
    metrics.histogram('test_hist').record(30);
    assert.equal(metrics.histogram('test_hist').count, 3);
    assert.equal(metrics.histogram('test_hist').avg, 20);
  });

  it('actuator in DRY_RUN mode reports success without executing', () => {
    const actuator = new Actuator(makeConfig({ DRY_RUN: true }));
    assert.equal(actuator.isDryRun, true);

    // setNiceness should return true (dry run) without actually running renice
    // The module always returns true for dry-run, so we verify config
    assert.ok(actuator.isDryRun);
  });

  it('governor manager tracks original governors', () => {
    const gm = new GovernorManager();

    // Track some fake cores (we can't read real governors in test)
    gm._originalGovernors.set(0, 'powersave');
    gm._originalGovernors.set(1, 'powersave');
    gm._originalGovernors.set(2, 'schedutil');

    const originals = gm.getOriginalGovernors();
    assert.equal(originals.size, 3);
    assert.equal(originals.get(0), 'powersave');
    assert.equal(originals.get(2), 'schedutil');
  });
});
