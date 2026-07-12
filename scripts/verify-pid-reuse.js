'use strict';

/**
 * Regression tests for v2.1.5 PID reuse protection.
 *
 * Tests cover:
 *   - getPidStartTime() reads /proc/<pid>/stat correctly
 *   - getPidStartTime() handles edge cases (dead PID, malformed stat, comm with parens)
 *   - trackProcess() captures startTime on first track
 *   - recoverFromCrash() skips PIDs with mismatched start-time (PID reuse scenario)
 *   - recoverFromCrash() restores PIDs with matching start-time (normal recovery)
 *   - recoverFromCrash() handles state files from older versions (no startTime field)
 *
 * Run with: node scripts/verify-pid-reuse.js
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

console.log('Verifying v2.1.5 PID reuse protection...\n');

// ── Helper: stub /proc/<pid>/stat for testing ────────────────────────────

function stubProcStat(sensorModule, pidStatMap) {
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, opts) {
    const key = String(p);
    // Handle /proc/<pid>/stat
    const match = key.match(/^\/proc\/(\d+)\/stat$/);
    if (match) {
      const pid = parseInt(match[1], 10);
      if (Object.prototype.hasOwnProperty.call(pidStatMap, pid)) {
        return pidStatMap[pid];
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
    return origReadFileSync.call(this, p, opts);
  };
  return () => {
    fs.readFileSync = origReadFileSync;
  };
}

// ── Helper: capture logger output via setLogHook ──────────────────────────
// logger.js destructures `info`/`warn` at module load, so overriding
// logger.info doesn't work. But logger.js has setLogHook() which fires
// on every log call — we use that to capture messages.

function captureLogs() {
  const logger = require('../logger');
  const messages = [];
  const hook = (level, timestamp, args) => {
    messages.push({ level, message: args.join(' ') });
  };
  logger.setLogHook(hook);
  return {
    messages,
    info: () => messages.filter((m) => m.level === 'info').map((m) => m.message),
    warn: () => messages.filter((m) => m.level === 'warn').map((m) => m.message),
    restore: () => logger.setLogHook(null),
  };
}

// ── Test: getPidStartTime() ─────────────────────────────────────────────

test('Fix #30a: getPidStartTime() returns the start-time field from /proc/<pid>/stat', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');

  // Real /proc/self/stat — should return a positive number
  const st = sensor.getPidStartTime(process.pid);
  assert.ok(typeof st === 'number', `expected number, got ${typeof st}`);
  assert.ok(st > 0, `expected positive number, got ${st}`);
});

test('Fix #30b: getPidStartTime() returns null for dead PID', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  // PID 2147483647 is extremely unlikely to exist
  const st = sensor.getPidStartTime(2147483647);
  assert.strictEqual(st, null, `expected null for dead PID, got ${st}`);
});

test('Fix #30c: getPidStartTime() returns null for invalid PID', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  assert.strictEqual(sensor.getPidStartTime(-1), null);
  assert.strictEqual(sensor.getPidStartTime(0), null);
  assert.strictEqual(sensor.getPidStartTime(NaN), null);
  assert.strictEqual(sensor.getPidStartTime('abc'), null);
  assert.strictEqual(sensor.getPidStartTime(null), null);
  assert.strictEqual(sensor.getPidStartTime(undefined), null);
});

test('Fix #30d: getPidStartTime() parses stat with comm containing parens', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');

  // Some process names contain parens, e.g. "chrome (renderer)".
  // The parser must find the LAST ')' to skip past the comm field safely.
  const fakeStat = '12345 (chrome (renderer)) S 1 12345 12345 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 99999 999999 100 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n';
  const restore = stubProcStat(sensor, { 12345: fakeStat });
  try {
    const st = sensor.getPidStartTime(12345);
    assert.strictEqual(st, 99999, `expected 99999, got ${st}`);
  } finally {
    restore();
  }
});

test('Fix #30e: getPidStartTime() returns null for malformed stat (no closing paren)', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  const fakeStat = '12345 chrome-no-parens S 1 12345 12345 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 99999\n';
  const restore = stubProcStat(sensor, { 12345: fakeStat });
  try {
    const st = sensor.getPidStartTime(12345);
    assert.strictEqual(st, null, `expected null for malformed stat, got ${st}`);
  } finally {
    restore();
  }
});

test('Fix #30f: getPidStartTime() returns null when /proc not mounted', () => {
  delete require.cache[require.resolve('../sensor')];
  const sensor = require('../sensor');
  // Stub readFileSync to throw ENOENT for /proc paths
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, opts) {
    if (String(p).startsWith('/proc/')) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return origReadFileSync.call(this, p, opts);
  };
  try {
    const st = sensor.getPidStartTime(process.pid);
    assert.strictEqual(st, null, 'expected null when /proc unavailable');
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

// ── Test: trackProcess() captures startTime ──────────────────────────────

test('Fix #31a: trackProcess() captures startTime on first track', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const mgr = new RollbackManager('/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json');

  // trackProcess on a real PID (this process) — should capture start-time
  mgr.trackProcess(process.pid, 'nice', 10);

  const state = mgr._state;
  assert.ok(state.modifiedPids[process.pid], 'PID entry should exist');
  assert.ok(typeof state.modifiedPids[process.pid].startTime === 'number',
    `startTime should be a number, got ${typeof state.modifiedPids[process.pid].startTime}`);
  assert.strictEqual(state.modifiedPids[process.pid].nice, 10);

  // Cleanup
  try { fs.unlinkSync(mgr.stateFilePath); } catch (_) { /* noop */ }
});

test('Fix #31b: trackProcess() captures startTime only once (subsequent tracks dont overwrite)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const mgr = new RollbackManager('/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json');

  mgr.trackProcess(process.pid, 'nice', 10);
  const firstStartTime = mgr._state.modifiedPids[process.pid].startTime;

  // Track another property — startTime should NOT be re-read
  mgr.trackProcess(process.pid, 'ionice', [3, 0]);
  const secondStartTime = mgr._state.modifiedPids[process.pid].startTime;

  assert.strictEqual(firstStartTime, secondStartTime,
    'startTime should not change on subsequent trackProcess calls');
  assert.ok(mgr._state.modifiedPids[process.pid].ionice,
    'ionice should be tracked');
});

// ── Test: recoverFromCrash() validates start-time ────────────────────────

test('Fix #32a: recoverFromCrash() skips PID with mismatched start-time (PID reuse)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json';

  // Write a state file that claims to have modified this process's PID,
  // but with a WRONG start-time (simulating PID reuse: original process
  // exited, this process took the same PID).
  const fakeState = {
    modifiedPids: {
      [process.pid]: {
        startTime: 1, // intentionally wrong — will not match current
        nice: 10,
        ionice: [3, 0],
      },
    },
    governorOriginals: {},
    cgroupBase: null,
    timestamp: new Date().toISOString(),
    pid: 99999, // different from current process — triggers recovery path
  };
  fs.writeFileSync(statePath, JSON.stringify(fakeState));

  // Capture logger output via setLogHook
  const logCap = captureLogs();

  try {
    const mgr = new RollbackManager(statePath);
    mgr.recoverFromCrash({ CGROUP_ROOT: '/sys/fs/cgroup' });

    const infoMsgs = logCap.info();
    const warnMsgs = logCap.warn();

    // Should log that 1 PID was skipped due to PID reuse
    const skipMsg = infoMsgs.find((m) => m.includes('PID reuse') || m.includes('skipped'));
    assert.ok(skipMsg, 'expected skip log message for PID reuse');
    assert.ok(skipMsg.includes('1 PID'),
      `expected "1 PID(s) skipped", got: ${skipMsg}`);

    // Should log 0 restored
    const restoreMsg = infoMsgs.find((m) => m.includes('dikembalikan'));
    assert.ok(restoreMsg, 'expected restore log message');
    assert.ok(restoreMsg.includes('0 proses'),
      `expected "0 proses dikembalikan" for PID reuse, got: ${restoreMsg}`);

    // Should have a warning about the mismatch
    const mismatchWarn = warnMsgs.find((m) => m.includes('start-time mismatch'));
    assert.ok(mismatchWarn, 'expected start-time mismatch warning');
  } finally {
    logCap.restore();
    try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
  }
});

test('Fix #32b: recoverFromCrash() restores PID with matching start-time (normal recovery)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const sensor = require('../sensor');
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json';

  // Capture the REAL start-time of this process
  const realStartTime = sensor.getPidStartTime(process.pid);
  assert.ok(typeof realStartTime === 'number', 'precondition: must be able to read start-time');

  // Write a state file with the CORRECT start-time — should trigger restore
  const fakeState = {
    modifiedPids: {
      [process.pid]: {
        startTime: realStartTime,
        nice: 10,
      },
    },
    governorOriginals: {},
    cgroupBase: null,
    timestamp: new Date().toISOString(),
    pid: 99999, // different from current — triggers recovery path
  };
  fs.writeFileSync(statePath, JSON.stringify(fakeState));

  // Capture logger output via setLogHook
  const logCap = captureLogs();

  try {
    const mgr = new RollbackManager(statePath);
    mgr.recoverFromCrash({ CGROUP_ROOT: '/sys/fs/cgroup' });

    const infoMsgs = logCap.info();

    // Check that the recovery completed with 1 restored process
    const restoreMsg = infoMsgs.find((m) => m.includes('dikembalikan'));
    assert.ok(restoreMsg, 'expected "dikembalikan" log message');
    assert.ok(restoreMsg.includes('1 proses'),
      `expected "1 proses dikembalikan", got: ${restoreMsg}`);

    // The state file should be cleared after recovery
    assert.ok(!fs.existsSync(statePath),
      'state file should be deleted after successful recovery');
  } finally {
    logCap.restore();
    try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
  }
});

test('Fix #32c: recoverFromCrash() handles state file without startTime (backward compat)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json';

  // State file from an OLD daemon version (no startTime field) — should
  // fall back to old behavior: restore without identity check.
  const fakeState = {
    modifiedPids: {
      [process.pid]: {
        nice: 10,
        // No startTime field — backward compat
      },
    },
    governorOriginals: {},
    cgroupBase: null,
    timestamp: new Date().toISOString(),
    pid: 99999,
  };
  fs.writeFileSync(statePath, JSON.stringify(fakeState));

  // Capture logger output via setLogHook
  const logCap = captureLogs();

  try {
    const mgr = new RollbackManager(statePath);
    mgr.recoverFromCrash({ CGROUP_ROOT: '/sys/fs/cgroup' });

    const infoMsgs = logCap.info();

    // Should restore 1 process (backward compat — no startTime = restore)
    const restoreMsg = infoMsgs.find((m) => m.includes('dikembalikan'));
    assert.ok(restoreMsg, 'expected "dikembalikan" log message');
    assert.ok(restoreMsg.includes('1 proses'),
      `expected "1 proses dikembalikan" for backward-compat, got: ${restoreMsg}`);
  } finally {
    logCap.restore();
    try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
  }
});

test('Fix #32d: recoverFromCrash() skips PID when current start-time cannot be read', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const sensor = require('../sensor');
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-' + process.pid + '.json';

  // Capture real start-time
  const realStartTime = sensor.getPidStartTime(process.pid);

  const fakeState = {
    modifiedPids: {
      [process.pid]: {
        startTime: realStartTime,
        nice: 10,
      },
    },
    governorOriginals: {},
    cgroupBase: null,
    timestamp: new Date().toISOString(),
    pid: 99999,
  };
  fs.writeFileSync(statePath, JSON.stringify(fakeState));

  // Stub readFileSync to fail for /proc/<pid>/stat
  // (simulates /proc not mounted or PID disappeared between liveness check and stat read)
  const origRead = fs.readFileSync;
  fs.readFileSync = function (p, opts) {
    if (String(p).startsWith('/proc/') && String(p).endsWith('/stat')) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return origRead.call(this, p, opts);
  };

  // Capture logger output via setLogHook
  const logCap = captureLogs();

  try {
    const mgr = new RollbackManager(statePath);
    mgr.recoverFromCrash({ CGROUP_ROOT: '/sys/fs/cgroup' });

    const infoMsgs = logCap.info();

    // Should skip the PID conservatively (0 restored)
    const restoreMsg = infoMsgs.find((m) => m.includes('dikembalikan'));
    assert.ok(restoreMsg, 'expected restore log message');
    assert.ok(restoreMsg.includes('0 proses'),
      `expected "0 proses dikembalikan" when start-time cannot be read, got: ${restoreMsg}`);
  } finally {
    fs.readFileSync = origRead;
    logCap.restore();
    try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
  }
});

// ── Test: end-to-end PID reuse scenario ──────────────────────────────────

test('Fix #33: end-to-end PID reuse scenario — track, crash, PID reused, recover (skip)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const sensor = require('../sensor');
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-e2e-' + process.pid + '.json';

  // Step 1: track a modification on this process
  const mgr1 = new RollbackManager(statePath);
  mgr1.trackProcess(process.pid, 'nice', 10);
  mgr1.persist();

  // Verify the state file was written with startTime
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(saved.modifiedPids[process.pid], 'saved state should have PID entry');
  assert.ok(typeof saved.modifiedPids[process.pid].startTime === 'number',
    'saved state should have startTime');

  // Step 2: simulate PID reuse by corrupting the start-time in the state file
  // (in real life, the original process exits and a new process takes the PID,
  // which would have a different start-time)
  saved.modifiedPids[process.pid].startTime = saved.modifiedPids[process.pid].startTime + 99999;
  saved.pid = 99999; // pretend it's from a different (crashed) daemon
  fs.writeFileSync(statePath, JSON.stringify(saved));

  // Step 3: recover — should detect the mismatch and skip
  const logCap = captureLogs();

  try {
    const mgr2 = new RollbackManager(statePath);
    mgr2.recoverFromCrash({ CGROUP_ROOT: '/sys/fs/cgroup' });

    const infoMsgs = logCap.info();

    // Should detect PID reuse and skip (0 restored)
    const restoreMsg = infoMsgs.find((m) => m.includes('dikembalikan'));
    assert.ok(restoreMsg, 'expected restore log message');
    assert.ok(restoreMsg.includes('0 proses'),
      `expected "0 proses dikembalikan" for PID reuse, got: ${restoreMsg}`);

    const skipMsg = infoMsgs.find((m) => m.includes('PID reuse'));
    assert.ok(skipMsg, 'expected PID reuse skip log message');
  } finally {
    logCap.restore();
    try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
  }
});

// ── Test: persist includes startTime ─────────────────────────────────────

test('Fix #34: persist() writes startTime to state file', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-persist-' + process.pid + '.json';

  const mgr = new RollbackManager(statePath);
  mgr.trackProcess(process.pid, 'nice', 10);
  mgr.persist();

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(saved.modifiedPids[process.pid],
    'PID entry should be in saved state');
  assert.ok(typeof saved.modifiedPids[process.pid].startTime === 'number',
    `startTime should be a number in saved state, got ${typeof saved.modifiedPids[process.pid].startTime}`);

  try { fs.unlinkSync(statePath); } catch (_) { /* noop */ }
});

// ── Test: clear() resets state including startTime fields ────────────────

test('Fix #35: clear() resets state to clean (no leftover startTime)', () => {
  delete require.cache[require.resolve('../sensor')];
  delete require.cache[require.resolve('../rollback')];
  const RollbackManager = require('../rollback');
  const statePath = '/tmp/dynalloc-test-pid-reuse-clear-' + process.pid + '.json';

  const mgr = new RollbackManager(statePath);
  mgr.trackProcess(process.pid, 'nice', 10);
  assert.ok(mgr._state.modifiedPids[process.pid],
    'precondition: PID entry exists');

  mgr.clear();
  assert.strictEqual(Object.keys(mgr._state.modifiedPids).length, 0,
    'modifiedPids should be empty after clear');
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PID reuse protection tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
