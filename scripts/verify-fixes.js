'use strict';

/**
 * Regression tests for the bugs fixed in v2.1.1.
 *
 * Each test verifies that a previously-broken behavior now works.
 * Run with: node scripts/verify-fixes.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Verifying v2.1.1 bug fixes...\n');

// ── Fix #1: readBatteryStatus uses `status` (not `online`) on Battery node ───

test('Fix #1: readBatteryStatus reads `status` instead of non-existent `online` on Battery node', () => {
  // Require sensor.js BEFORE stubbing fs so the module load itself works.
  const sensorModule = require('../sensor');
  // sensor.validateSysPath only accepts /proc/ and /sys/ paths, so we
  // stub fs.readFileSync to serve our test data when readBatteryStatus
  // asks for the (path-validated) /sys/class/power_supply/BAT0/* files.
  const origReadFileSync = fs.readFileSync;
  const files = {
    '/sys/class/power_supply/BAT0/type': 'Battery',
    '/sys/class/power_supply/BAT0/capacity': '42',
    '/sys/class/power_supply/BAT0/status': 'Discharging',
    // NOTE: NO `online` file — this is what real hardware looks like.
  };
  fs.readFileSync = function (p, opts) {
    const key = String(p);
    if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
    // Fall through to the original for any other path (e.g. module loads).
    return origReadFileSync.call(this, p, opts);
  };
  try {
    const result = sensorModule.readBatteryStatus('/sys/class/power_supply/BAT0');
    assert.ok(result, 'readBatteryStatus returned null — bug NOT fixed');
    assert.strictEqual(result.onBattery, true, `expected onBattery=true, got ${result.onBattery}`);
    assert.strictEqual(result.capacity, 42, `expected capacity=42, got ${result.capacity}`);
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

test('Fix #1b: readBatteryStatus reports onBattery=false when status=Charging', () => {
  const sensorModule = require('../sensor');
  const origReadFileSync = fs.readFileSync;
  const files = {
    '/sys/class/power_supply/BAT0/type': 'Battery',
    '/sys/class/power_supply/BAT0/capacity': '75',
    '/sys/class/power_supply/BAT0/status': 'Charging',
  };
  fs.readFileSync = function (p, opts) {
    const key = String(p);
    if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
    return origReadFileSync.call(this, p, opts);
  };
  try {
    const result = sensorModule.readBatteryStatus('/sys/class/power_supply/BAT0');
    assert.ok(result, 'result is null');
    assert.strictEqual(result.onBattery, false);
    assert.strictEqual(result.capacity, 75);
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

// ── Fix #2: governor.setGovernor always captures originals ────────────────

test('Fix #2: setGovernor captures originals for cores touched by later calls', () => {
  const GovernorManager = require('../governor');
  const gm = new GovernorManager();
  gm.readGovernor = (core) => `gov-original-core-${core}`;
  gm._exec = () => {};

  const config = { DRY_RUN: true, GOVERNOR_USE_SUDO: false };

  gm.setGovernor([0], 'performance', config);
  assert.strictEqual(gm.getOriginalGovernors().size, 1, 'core 0 should be captured');

  // Second call on a NEW core (2). Before fix: capture was skipped.
  // After fix: core 2 is captured.
  gm.setGovernor([2], 'powersave', config);
  const originals = gm.getOriginalGovernors();
  assert.strictEqual(originals.size, 2, `expected 2 captured cores, got ${originals.size}`);
  assert.ok(originals.has(0), 'core 0 missing');
  assert.ok(originals.has(2), 'core 2 missing — bug NOT fixed');
  assert.strictEqual(originals.get(2), 'gov-original-core-2');
});

// ── Fix #3: rollback trackProcess wiring ───────────────────────────────────

test('Fix #3: daemon.js _executeBoost/Throttle call rollbackMgr.trackProcess', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('rollbackMgr.trackProcess('), 'trackProcess not wired in daemon.js');
  assert.ok(src.includes('_syncGovernorRollbackState'), 'governor rollback sync helper missing');
  const boostFnMatch = src.match(/function _executeBoost\(boost\) \{[\s\S]*?^\}/m);
  assert.ok(boostFnMatch, '_executeBoost not found');
  assert.ok(boostFnMatch[0].includes('rollbackMgr.trackProcess'), '_executeBoost missing trackProcess');
  const throttleFnMatch = src.match(/function _executeThrottle\(action\) \{[\s\S]*?^\}/m);
  assert.ok(throttleFnMatch, '_executeThrottle not found');
  assert.ok(throttleFnMatch[0].includes('rollbackMgr.trackProcess'), '_executeThrottle missing trackProcess');
});

// ── Fix #4: plugin runDetection results are consumed ──────────────────────

test('Fix #4: daemon.js consumes plugin runDetection results (not discarded)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('pluginDetections = pluginMgr.runDetection('),
    'runDetection return value not captured');
  assert.ok(src.includes('effectiveMediaPids'),
    'effectiveMediaPids merge logic missing');
  assert.ok(src.includes("actions.includes('PROTECT')"),
    'PROTECT action handling missing');
  assert.ok(src.includes("actions.includes('BOOST')"),
    'BOOST action handling missing');
  assert.ok(src.includes('procs, State.currentForegroundPid, effectiveMediaPids'),
    'classifyProcesses not using effectiveMediaPids');
});

// ── Fix #5: policy_evaluations counter increments by 1 ─────────────────────

test('Fix #5: policy_evaluations metric increments by 1, not cumulative stats.evaluations', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policy-engine', 'policy-engine.js'), 'utf8');
  assert.ok(!src.includes("counter('policy_evaluations').increment(this._ruleEngine.stats.evaluations)"),
    'old buggy cumulative increment still present');
  assert.ok(src.includes("counter('policy_evaluations').increment(1)"),
    'fix not applied');
});

// ── Fix #6: event-sources updateProcesses tracks PIDs ──────────────────────

testAsync('Fix #6: updateProcesses emits ON_PROCESS_STARTED per new PID (not per new name)', async () => {
  delete require.cache[require.resolve('../policy-engine/event-sources')];
  delete require.cache[require.resolve('../policy-engine/event-bus')];
  delete require.cache[require.resolve('../policy-engine/state-store')];

  const { EventBus, EVENTS } = require('../policy-engine/event-bus');
  const { StateStore } = require('../policy-engine/state-store');
  const { EventSources } = require('../policy-engine/event-sources');

  const bus = new EventBus();
  const state = new StateStore();
  const fakeEngine = { bus, stateStore: state };
  const config = { PSI_CPU_WARN: 8.0, PSI_MEM_WARN: 4.0 };
  const es = new EventSources({ engine: fakeEngine, config });

  const startedEvents = [];
  const exitedEvents = [];
  bus.on(EVENTS.ON_PROCESS_STARTED, (p) => startedEvents.push(p));
  bus.on(EVENTS.ON_PROCESS_EXITED, (p) => exitedEvents.push(p));

  // First scan: 2 chrome processes (same comm, different PIDs)
  es.updateProcesses([
    { pid: 100, ppid: 1, pcpu: 0, comm: 'chrome' },
    { pid: 101, ppid: 1, pcpu: 0, comm: 'chrome' },
  ]);

  // Second scan: NEW chrome process (PID 102, same comm).
  // Before fix: no event (because 'chrome' name was already known).
  // After fix: ON_PROCESS_STARTED emitted for PID 102.
  es.updateProcesses([
    { pid: 100, ppid: 1, pcpu: 0, comm: 'chrome' },
    { pid: 101, ppid: 1, pcpu: 0, comm: 'chrome' },
    { pid: 102, ppid: 1, pcpu: 0, comm: 'chrome' },
  ]);
  assert.strictEqual(startedEvents.length, 1,
    `expected 1 STARTED event for new PID, got ${startedEvents.length}`);
  assert.strictEqual(startedEvents[0].pid, 102,
    `expected STARTED pid=102, got ${startedEvents[0].pid}`);

  // Third scan: PID 101 exits. ON_PROCESS_EXITED should carry the PID.
  es.updateProcesses([
    { pid: 100, ppid: 1, pcpu: 0, comm: 'chrome' },
    { pid: 102, ppid: 1, pcpu: 0, comm: 'chrome' },
  ]);
  assert.strictEqual(exitedEvents.length, 1,
    `expected 1 EXITED event, got ${exitedEvents.length}`);
  assert.ok(exitedEvents[0].pid, 'EXITED event missing pid — bug NOT fixed');
  assert.strictEqual(exitedEvents[0].pid, 101,
    `expected EXITED pid=101, got ${exitedEvents[0].pid}`);
});

// ── Fix #7: Histogram circular buffer off-by-one ──────────────────────────

test('Fix #7: Histogram circular buffer overwrites index 0 first (not index 1)', () => {
  const { Histogram } = require('../metrics');
  const h2 = new Histogram('test2', '');
  // Fill the buffer with 0..999
  for (let i = 0; i < 1000; i++) h2.record(i);
  // Record one more — this should overwrite the OLDEST sample (value 0 at index 0).
  h2.record(9999);

  // h2.min returns the HISTORICAL min across all records (always 0 here),
  // so we can't use it. Instead use percentile(0) which inspects the
  // CURRENT buffer contents.
  //
  // After the fix: index 0 (which held 0) was overwritten with 9999,
  //   so the smallest sample in the buffer is now 1.
  //   sorted buffer = [1, 2, 3, ..., 999, 9999] → percentile(0) = 1.
  // Before the fix: index 0 still held 0 (the formula wrote 9999 to
  //   index 1 instead), so the smallest sample is still 0.
  //   sorted buffer = [0, 2, 3, ..., 999, 9999] → percentile(0) = 0.
  const bufferMin = h2.percentile(0);
  assert.strictEqual(bufferMin, 1,
    `expected bufferMin=1 after overwrite, got ${bufferMin} — bug NOT fixed (index 0 still holds the original sample 0)`);
});

// ── Fix #8: self-check checkPermissions doesn't write PID to cgroup.procs ─

test('Fix #8: self-check checkPermissions does NOT write PID to cgroup.procs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'self-check.js'), 'utf8');
  assert.ok(!src.includes("writeFileSync(path.join(testPath, 'cgroup.procs')"),
    'old buggy cgroup.procs write still present');
  assert.ok(src.includes("writeFileSync(path.join(testPath, 'cpu.weight')"),
    'cpu.weight test missing');
  assert.ok(src.includes('rmdirSync(testPath)'),
    'rmdirSync cleanup missing');
});

// ── Fix #9: bench.js require paths use ./ ──────────────────────────────────

test('Fix #9: bench.js uses ./ requires (not ../)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bench.js'), 'utf8');
  assert.ok(!src.includes("require('../logger')"),
    'old ../logger require still present');
  assert.ok(src.includes("require('./logger')"), './logger require missing');
  assert.ok(src.includes("require('./sensor')"), './sensor require missing');
  assert.ok(src.includes("require('./config')"), './config require missing');
});

// ── Fix #10: classifier Python pattern matches without \s ─────────────────

test('Fix #10: classifier matches "python3" without requiring whitespace', () => {
  const classifier = require('../classifier');
  classifier.clearCache();
  assert.strictEqual(classifier.classifyByComm('python3'), 'COMPILER',
    'python3 not classified as COMPILER — bug NOT fixed');
  classifier.clearCache();
  assert.strictEqual(classifier.classifyByComm('python'), 'COMPILER',
    'python not classified as COMPILER');
  classifier.clearCache();
  assert.strictEqual(classifier.classifyByComm('pip3'), 'COMPILER',
    'pip3 not classified as COMPILER');
});

// ── Fix #11: applyProfile foregroundBoost actually boosts ─────────────────

test('Fix #11: applyProfile with foregroundBoost=true actually invokes boostProcess', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policy-engine', 'action-executor.js'), 'utf8');
  assert.ok(!src.includes('foregroundBoost is informational only'),
    'old "informational only" comment still present');
  assert.ok(/foregroundBoost[^]*tryStep\(\{\s*type:\s*'boostProcess'/.test(src),
    'boostProcess tryStep not added under foregroundBoost branch');
});

// ── Fix #12: FOREGROUND_CORE_RESERVE schema works on single-core machines ─

test('Fix #12: FOREGROUND_CORE_RESERVE schema range is satisfiable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.ok(src.includes('Math.max(1, TOTAL_CORES - 1)'),
    'Math.max(1, TOTAL_CORES - 1) fix not present');
});

// ── Fix #13: actuator.restoreProcess always resets oom_score_adj if modified ─

test('Fix #13: actuator.restoreProcess resets oom_score_adj even if ENABLE_OOM_PROTECTION was hot-reloaded off', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'actuator.js'), 'utf8');
  assert.ok(!src.includes('if (this._config.ENABLE_OOM_PROTECTION) this.setOomScoreAdj(pid, 0)'),
    'old buggy ENABLE_OOM_PROTECTION check still in restoreProcess');
  assert.ok(src.includes('_modificationLog.filter'),
    '_modificationLog check missing in restoreProcess');
});

// ── Fix #14: plugins/browser.js unused import removed ─────────────────────

test('Fix #14: plugins/browser.js no longer imports isKnownMediaProcessName', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser.js'), 'utf8');
  assert.ok(!src.includes("require('../multimedia')"),
    'unused multimedia import still present');
});

// ─────────────────────────────────────────────────────────────────────────────
//  v2.1.2 second-pass fixes
// ─────────────────────────────────────────────────────────────────────────────

// ── Fix #15: scheduler uses instantaneous PSI when ENABLE_CPU_HISTORY is false

test('Fix #15: scheduler uses instantaneous PSI when ENABLE_CPU_HISTORY is false', () => {
  const { Scheduler } = require('../scheduler');
  const { CpuHistory } = require('../sensor');
  const { DEFAULT_CONFIG } = require('../config');

  // Config with CPU history DISABLED
  const config = { ...DEFAULT_CONFIG, ENABLE_CPU_HISTORY: false, ENABLE_HYSTERESIS: false };
  const topology = {
    logicalCount: 4, physicalCount: 4, smtEnabled: false, threadsPerCore: 1,
    numaNodes: [], isHybrid: false, pCores: [], eCores: [],
    isAMD: false, ccds: [], ccdCount: 0,
    logicalToPhysical: new Map(), threadSiblings: new Map(),
  };
  const cpuHistory = new CpuHistory(1);
  const scheduler = new Scheduler(config, topology, cpuHistory);

  // Feed high PSI — should trigger WARN even though cpuHistory is empty.
  // Before fix: cpuPressure = cpuHistory.cpuAvg = 0 (empty buffer) → stays NORMAL.
  // After fix: cpuPressure = cpuAvg10 = 25 → triggers CRITICAL.
  const result = scheduler.tick(
    { cpuPSI: { some: { avg10: 25.0 } }, memPSI: { some: { avg10: 1.0 } } },
    { foregroundPid: null, mediaPids: new Set(), onBattery: false, thermalTemp: null }
  );
  assert.ok(result.cpuPressure === 25,
    `expected cpuPressure=25 (instantaneous), got ${result.cpuPressure} — bug NOT fixed`);
  assert.ok(result.stressLevel === 'CRITICAL',
    `expected stressLevel=CRITICAL, got ${result.stressLevel}`);
});

// ── Fix #16: event-sources PSI_CPU_WARN=0 is respected (not treated as falsy)

test('Fix #16: event-sources updatePressure respects PSI_CPU_WARN=0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'policy-engine', 'event-sources.js'), 'utf8');
  // The old buggy code used `||`:
  //   this._cpuHighThreshold = this._config.PSI_CPU_WARN || this._cpuHighThreshold;
  // The new code uses typeof check.
  assert.ok(!src.includes('this._config.PSI_CPU_WARN || this._cpuHighThreshold'),
    'old buggy `||` pattern still present');
  assert.ok(src.includes("typeof this._config.PSI_CPU_WARN === 'number'"),
    'typeof check fix not present');
});

// ── Fix #17: logger _rotateIfNeeded sets _logStream=null before createWriteStream

test('Fix #17: logger _rotateIfNeeded nulls _logStream before reopening', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'logger.js'), 'utf8');
  // The fix adds `_logStream = null;` after end() and before the rename loop.
  assert.ok(/_logStream\.end\(\);[\s\S]*?_logStream = null;[\s\S]*?renameSync/.test(src),
    '_logStream = null not added between end() and rename loop');
});

// ── Fix #18: daemon governorMgr.restoreAll runs regardless of ENABLE_GOVERNOR_SWITCH

test('Fix #18: daemon restoreAll runs if governorMgr has captured originals (not gated by flag)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // Old buggy check: if (CONFIG && CONFIG.ENABLE_GOVERNOR_SWITCH && governorMgr)
  // New check: if (governorMgr && governorMgr.getOriginalGovernors().size > 0)
  assert.ok(!src.includes('CONFIG.ENABLE_GOVERNOR_SWITCH && governorMgr) {\n      governorMgr.restoreAll'),
    'old buggy ENABLE_GOVERNOR_SWITCH gate still in cleanup');
  assert.ok(src.includes('governorMgr.getOriginalGovernors().size > 0'),
    'getOriginalGovernors().size check missing');
});

// ── Fix #19: daemon closeFileLogging called with callback before exit

test('Fix #19: daemon closeFileLogging uses callback before process.exit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // The fix calls closeFileLogging(() => process.exit(exitCode))
  assert.ok(src.includes("closeFileLogging(() => {\n    process.exit(exitCode);\n  })"),
    'closeFileLogging callback pattern missing');
  // The safety net timeout
  assert.ok(src.includes("setTimeout(() => process.exit(exitCode), 2000).unref()"),
    'safety net timeout missing');
});

// ── Fix #20: multimedia _execPwTop no longer pretends to parse PIDs

test('Fix #20: multimedia _execPwTop acknowledges it cannot extract PIDs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'multimedia.js'), 'utf8');
  // Strip // comments to check actual code, not documentation
  const codeOnly = src.replace(/\/\/[^\n]*/g, '');
  // The old buggy code tried to parseInt(parts[0]) as a PID inside _execPwTop.
  // The new code explicitly returns empty with a debug log.
  const fnMatch = codeOnly.match(/async function _execPwTop\(\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(fnMatch, '_execPwTop function not found');
  const fnBody = fnMatch[1];
  assert.ok(!fnBody.includes('parseInt(parts[0]'),
    'old buggy parseInt(parts[0]) still in _execPwTop code');
  assert.ok(fnBody.includes('resolve(new Set())'),
    '_execPwTop should resolve with empty Set');
});

// ── Fix #21: rollback persists cgroupBase and uses it in recovery

test('Fix #21: rollback.js saves and restores cgroupBase', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'rollback.js'), 'utf8');
  // The fix adds cgroupBase to the state object and a setCgroupBase method
  assert.ok(src.includes('cgroupBase: null'),
    'cgroupBase field not added to state');
  assert.ok(src.includes('setCgroupBase(basePath)'),
    'setCgroupBase method not added');
  // The recovery uses config.CGROUP_ROOT as fallback
  assert.ok(src.includes("config && config.CGROUP_ROOT"),
    'config.CGROUP_ROOT fallback not added to recovery');
});

test('Fix #21b: daemon.js calls rollbackMgr.setCgroupBase after setupCgroups', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(src.includes('rollbackMgr.setCgroupBase(actuator.cgroupBasePath)'),
    'setCgroupBase wiring missing in daemon bootstrap');
});

// ── Fix #22: scheduler classifyProcesses dead code removed

test('Fix #22: scheduler.classifyProcesses no longer has dead newThrottled/pidToPpid', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.ok(!src.includes('const newThrottled = new Set()'),
    'dead newThrottled variable still present');
  assert.ok(!src.includes('const pidToPpid = new Map'),
    'dead pidToPpid variable still present');
});

// ── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Regression tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1500);
