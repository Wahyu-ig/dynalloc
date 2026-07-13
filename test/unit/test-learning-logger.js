'use strict';

/**
 * DynAlloc — LearningLogger Unit Tests (v1.1.0)
 * ==============================================
 *
 * Comprehensive unit tests for learning-logger.js covering:
 *   - Construction & defaults
 *   - Normal behavior (logAction for boost/throttle)
 *   - Invalid input (non-string action, null/undefined context)
 *   - Edge cases (missing fields, empty context)
 *   - Error handling (write failures, directory creation failures)
 *   - File persistence (JSON-line format, append-only, re-read)
 *   - readEntries() — empty file, missing file, malformed lines
 *   - suggestRules() — below threshold, above threshold, boost/throttle sorting
 *   - clear() — file removal, idempotency, missing file
 *   - Getters (logFile, entryCount)
 *
 * Run: node --test test/unit/test-learning-logger.js
 */

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Silence the main logger during tests
const logger = require('../../logger');
logger.setLevel('fatal');

// Suppress console
const origConsoleError = console.error;
const origConsoleWarn = console.warn;
const origConsoleLog = console.log;
before(() => {
  console.error = mock.fn();
  console.warn = mock.fn();
  console.log = mock.fn();
});
after(() => {
  console.error = origConsoleError;
  console.warn = origConsoleWarn;
  console.log = origConsoleLog;
});

// ── Module under test ──────────────────────────────────────────────────

const { LearningLogger } = require('../../learning-logger');

// ── Test helpers ───────────────────────────────────────────────────────
//
// IMPORTANT: node:test runs tests inside a `describe` block in parallel.
// We therefore must NOT share module-level mutable state (like a tmpDir
// path) across tests. Each test creates its own unique tmpdir via
// `freshDir()` and is responsible for cleaning it up.

let _dirCounter = 0;

function freshDir() {
  _dirCounter++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dynalloc-learn-${_dirCounter}-${process.pid}-`));
  return dir;
}

function makeConfig(overrides = {}) {
  const dir = freshDir();
  return {
    ENABLE_LEARNING_MODE: true,
    LEARNING_LOG_FILE: path.join(dir, 'learn.log'),
    LEARNING_MIN_ENTRIES: 50,
    _tmpDir: dir, // keep a reference for cleanup
    ...overrides,
  };
}

function cleanup(cfg) {
  if (cfg && cfg._tmpDir) {
    try { fs.rmSync(cfg._tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function makeContext(overrides = {}) {
  return {
    pid: 12345,
    comm: 'firefox',
    category: 'BROWSER',
    schedClass: 'INTERACTIVE',
    stressLevel: 'WARN',
    cpuPressure: 12.5,
    foregroundPid: 12345,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger construction', () => {
  it('uses provided log file path', () => {
    const cfg = makeConfig({ LEARNING_LOG_FILE: '/tmp/custom-learn.log' });
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.logFile, '/tmp/custom-learn.log');
    cleanup(cfg);
  });

  it('falls back to default path when LEARNING_LOG_FILE is null', () => {
    const ll = new LearningLogger({
      ENABLE_LEARNING_MODE: true,
      LEARNING_LOG_FILE: null,
      LEARNING_MIN_ENTRIES: 50,
    });
    const expected = path.join(os.homedir() || '', '.config', 'dynalloc', 'learn.log');
    assert.strictEqual(ll.logFile, expected);
  });

  it('falls back to default path when LEARNING_LOG_FILE is undefined', () => {
    const ll = new LearningLogger({
      ENABLE_LEARNING_MODE: true,
      LEARNING_MIN_ENTRIES: 50,
    });
    assert.ok(typeof ll.logFile === 'string');
    assert.ok(ll.logFile.endsWith('learn.log'));
  });

  it('uses provided LEARNING_MIN_ENTRIES', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 100 });
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('falls back to default min entries when not specified', () => {
    const cfg = makeConfig();
    delete cfg.LEARNING_MIN_ENTRIES;
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('starts with zero entry count', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. NORMAL BEHAVIOR — logAction()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.logAction() normal behavior', () => {
  it('writes a JSON line for a boost action', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    assert.ok(fs.existsSync(ll.logFile));
    const lines = fs.readFileSync(ll.logFile, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.action, 'boost');
    assert.strictEqual(entry.pid, 12345);
    assert.strictEqual(entry.comm, 'firefox');
    assert.strictEqual(entry.category, 'BROWSER');
    assert.strictEqual(entry.schedClass, 'INTERACTIVE');
    assert.strictEqual(entry.stressLevel, 'WARN');
    assert.strictEqual(entry.cpuPressure, 12.5);
    assert.strictEqual(entry.foregroundPid, 12345);
    assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 0);
    cleanup(cfg);
  });

  it('writes a JSON line for a throttle action', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('throttle', makeContext({ comm: 'compile-job', category: 'COMPILER' }));
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.action, 'throttle');
    assert.strictEqual(entry.comm, 'compile-job');
    assert.strictEqual(entry.category, 'COMPILER');
    cleanup(cfg);
  });

  it('appends entries (does not overwrite)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext({ pid: 1, comm: 'a' }));
    ll.logAction('throttle', makeContext({ pid: 2, comm: 'b' }));
    ll.logAction('boost', makeContext({ pid: 3, comm: 'c' }));
    const lines = fs.readFileSync(ll.logFile, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(JSON.parse(lines[0]).pid, 1);
    assert.strictEqual(JSON.parse(lines[1]).pid, 2);
    assert.strictEqual(JSON.parse(lines[2]).pid, 3);
    cleanup(cfg);
  });

  it('increments entryCount for each write', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.entryCount, 0);
    ll.logAction('boost', makeContext());
    assert.strictEqual(ll.entryCount, 1);
    ll.logAction('throttle', makeContext());
    assert.strictEqual(ll.entryCount, 2);
    cleanup(cfg);
  });

  it('creates the parent directory if it does not exist', () => {
    const cfg = makeConfig();
    const nestedDir = path.join(cfg._tmpDir, 'a', 'b', 'c');
    const logPath = path.join(nestedDir, 'learn.log');
    cfg.LEARNING_LOG_FILE = logPath;
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    assert.ok(fs.existsSync(nestedDir));
    assert.ok(fs.existsSync(logPath));
    cleanup(cfg);
  });

  it('writes entries in chronological append order', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const comms = ['alpha', 'beta', 'gamma', 'delta'];
    for (const c of comms) {
      ll.logAction('boost', makeContext({ comm: c }));
    }
    const lines = fs.readFileSync(ll.logFile, 'utf8').trim().split('\n');
    assert.deepStrictEqual(lines.map((l) => JSON.parse(l).comm), comms);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. INVALID INPUT — logAction()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.logAction() invalid input', () => {
  it('does nothing when ENABLE_LEARNING_MODE is false', () => {
    const cfg = makeConfig({ ENABLE_LEARNING_MODE: false });
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    assert.strictEqual(ll.entryCount, 0);
    assert.ok(!fs.existsSync(ll.logFile));
    cleanup(cfg);
  });

  it('does nothing when action is not a string', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction(null, makeContext());
    ll.logAction(undefined, makeContext());
    ll.logAction(123, makeContext());
    ll.logAction({}, makeContext());
    ll.logAction([], makeContext());
    assert.strictEqual(ll.entryCount, 0);
    assert.ok(!fs.existsSync(ll.logFile));
    cleanup(cfg);
  });

  it('does nothing when context is null', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', null);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('does nothing when context is undefined', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', undefined);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('does nothing when context is a falsy primitive (0, false, empty string)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', 0);
    ll.logAction('boost', false);
    ll.logAction('boost', '');
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('handles truthy primitive contexts (writes a default-shape entry)', () => {
    // Note: the implementation only guards with `!context`, so truthy
    // primitives slip through. Property access on a string returns
    // undefined, which becomes the default values. This test pins the
    // current behavior; if the implementation tightens, update both.
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', 'firefox');
    ll.logAction('boost', 12345);
    ll.logAction('boost', true);
    // The implementation tries to read properties from the primitive,
    // which return undefined; the entry ends up with default values.
    assert.strictEqual(ll.entryCount, 3);
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 3);
    for (const e of entries) {
      assert.strictEqual(e.action, 'boost');
      assert.strictEqual(e.pid, null);
      assert.strictEqual(e.comm, '');
    }
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. EDGE CASES — logAction()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.logAction() edge cases', () => {
  it('handles empty context object (uses defaults)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', {});
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.action, 'boost');
    assert.strictEqual(entry.pid, null);
    assert.strictEqual(entry.comm, '');
    assert.strictEqual(entry.category, '');
    assert.strictEqual(entry.cpuPressure, 0);
    assert.strictEqual(entry.foregroundPid, null);
    cleanup(cfg);
  });

  it('handles context with partial fields', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', { pid: 999, comm: 'foo' });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.pid, 999);
    assert.strictEqual(entry.comm, 'foo');
    assert.strictEqual(entry.category, '');
    assert.strictEqual(entry.schedClass, '');
    assert.strictEqual(entry.stressLevel, '');
    assert.strictEqual(entry.cpuPressure, 0);
    cleanup(cfg);
  });

  it('handles non-numeric pid in context (truthy string passes through)', () => {
    // The implementation uses `context.pid || null`. A non-empty string
    // is truthy, so it passes through unchanged.
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', { pid: 'not-a-number', comm: 'foo' });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    // Pin current behavior: truthy non-numeric pid is preserved as-is.
    assert.strictEqual(entry.pid, 'not-a-number');
    assert.strictEqual(entry.comm, 'foo');
    cleanup(cfg);
  });

  it('handles non-numeric cpuPressure in context (truthy passes through)', () => {
    // Same: `context.cpuPressure || 0` lets truthy non-numeric values through.
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', { comm: 'foo', cpuPressure: 'high' });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.cpuPressure, 'high');
    cleanup(cfg);
  });

  it('handles zero pid in context', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', { pid: 0, comm: 'foo' });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    // 0 is falsy, so the `|| null` path takes effect
    assert.strictEqual(entry.pid, null);
    assert.strictEqual(entry.comm, 'foo');
    cleanup(cfg);
  });

  it('writes a valid ISO timestamp', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const before = Date.now();
    ll.logAction('boost', makeContext());
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    const ts = new Date(entry.timestamp).getTime();
    assert.ok(ts >= before - 1000);
    assert.ok(ts <= Date.now() + 1000);
    cleanup(cfg);
  });

  it('handles very long comm names', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const longComm = 'x'.repeat(500);
    ll.logAction('boost', { comm: longComm });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.comm.length, 500);
    cleanup(cfg);
  });

  it('handles comm with special characters', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const weird = 'process "with" \\slashes\\ and \n newlines \t tabs';
    ll.logAction('boost', { comm: weird });
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.comm, weird);
    cleanup(cfg);
  });

  it('handles empty string action', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    // Empty string IS a string, so the gate passes — but produces a
    // weird entry. The current implementation allows this; verify the
    // behavior is at least consistent.
    ll.logAction('', makeContext());
    assert.strictEqual(ll.entryCount, 1);
    const entry = JSON.parse(fs.readFileSync(ll.logFile, 'utf8').trim());
    assert.strictEqual(entry.action, '');
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. ERROR HANDLING — logAction()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.logAction() error handling', () => {
  it('survives appendFileSync throwing (read-only parent dir)', () => {
    const cfg = makeConfig();
    const roDir = path.join(cfg._tmpDir, 'readonly');
    fs.mkdirSync(roDir, { mode: 0o500 });
    const logPath = path.join(roDir, 'learn.log');
    cfg.LEARNING_LOG_FILE = logPath;
    const ll = new LearningLogger(cfg);
    // Should not throw
    ll.logAction('boost', makeContext());
    // entryCount was incremented even though write failed (current
    // implementation increments after the write succeeds — so 0 here)
    assert.strictEqual(ll.entryCount, 0);
    assert.ok(!fs.existsSync(logPath));
    cleanup(cfg);
  });

  it('survives appendFileSync throwing (no permission)', () => {
    // Skip on root — root bypasses file permissions
    if (process.getuid && process.getuid() === 0) return;
    const cfg = makeConfig();
    const roFile = path.join(cfg._tmpDir, 'readonly.log');
    fs.writeFileSync(roFile, '', { mode: 0o400 });
    cfg.LEARNING_LOG_FILE = roFile;
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    // Write failed silently; entryCount stays at 0
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('survives mkdirSync throwing (parent is a file)', () => {
    const cfg = makeConfig();
    const filePath = path.join(cfg._tmpDir, 'blocking-file');
    fs.writeFileSync(filePath, 'im a file');
    const logPath = path.join(filePath, 'learn.log'); // invalid: parent is a file
    cfg.LEARNING_LOG_FILE = logPath;
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    // No throw, no file written
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. FILE PERSISTENCE — readEntries()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.readEntries()', () => {
  it('returns empty array when log file does not exist', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const entries = ll.readEntries();
    assert.deepStrictEqual(entries, []);
    cleanup(cfg);
  });

  it('returns empty array when log file is empty', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    fs.writeFileSync(ll.logFile, '');
    assert.deepStrictEqual(ll.readEntries(), []);
    cleanup(cfg);
  });

  it('returns empty array when log file contains only whitespace', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    fs.writeFileSync(ll.logFile, '   \n\n  \n');
    assert.deepStrictEqual(ll.readEntries(), []);
    cleanup(cfg);
  });

  it('returns all entries for a multi-line log', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext({ pid: 1, comm: 'a' }));
    ll.logAction('throttle', makeContext({ pid: 2, comm: 'b' }));
    ll.logAction('boost', makeContext({ pid: 3, comm: 'c' }));
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].pid, 1);
    assert.strictEqual(entries[1].pid, 2);
    assert.strictEqual(entries[2].pid, 3);
    cleanup(cfg);
  });

  it('skips malformed JSON lines without failing', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    fs.writeFileSync(ll.logFile, [
      JSON.stringify({ action: 'boost', pid: 1, comm: 'a' }),
      'this is not json',
      JSON.stringify({ action: 'throttle', pid: 2, comm: 'b' }),
      '{ broken',
      JSON.stringify({ action: 'boost', pid: 3, comm: 'c' }),
    ].join('\n'));
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].pid, 1);
    assert.strictEqual(entries[1].pid, 2);
    assert.strictEqual(entries[2].pid, 3);
    cleanup(cfg);
  });

  it('handles a log file with a trailing blank line', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    fs.writeFileSync(ll.logFile,
      JSON.stringify({ action: 'boost', pid: 1 }) + '\n\n');
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 1);
    cleanup(cfg);
  });

  it('preserves all fields when re-reading', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    const ctx = makeContext({
      pid: 4242,
      comm: 'rustc',
      category: 'COMPILER',
      schedClass: 'BACKGROUND',
      stressLevel: 'CRITICAL',
      cpuPressure: 87.3,
      foregroundPid: 9999,
    });
    ll.logAction('boost', ctx);
    const [entry] = ll.readEntries();
    assert.strictEqual(entry.pid, 4242);
    assert.strictEqual(entry.comm, 'rustc');
    assert.strictEqual(entry.category, 'COMPILER');
    assert.strictEqual(entry.schedClass, 'BACKGROUND');
    assert.strictEqual(entry.stressLevel, 'CRITICAL');
    assert.strictEqual(entry.cpuPressure, 87.3);
    assert.strictEqual(entry.foregroundPid, 9999);
    cleanup(cfg);
  });

  it('handles a log file containing only malformed lines', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    fs.writeFileSync(ll.logFile, 'foo\nbar\nbaz\n');
    assert.deepStrictEqual(ll.readEntries(), []);
    cleanup(cfg);
  });

  it('returns a fresh array (does not share state)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    const a = ll.readEntries();
    const b = ll.readEntries();
    assert.notStrictEqual(a, b);
    assert.strictEqual(a.length, b.length);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. RULE SUGGESTION — suggestRules()
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.suggestRules()', () => {
  it('returns enough:false when below threshold', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 50 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 10; i++) {
      ll.logAction('boost', makeContext({ comm: 'firefox' }));
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, false);
    assert.strictEqual(result.current, 10);
    assert.strictEqual(result.needed, 50);
    assert.deepStrictEqual(result.suggestions, []);
    cleanup(cfg);
  });

  it('returns enough:true when at or above threshold', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 10 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 10; i++) {
      ll.logAction('boost', makeContext({ comm: 'firefox' }));
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    assert.strictEqual(result.current, 10);
    assert.strictEqual(result.needed, 10);
    cleanup(cfg);
  });

  it('suggests a boost rule for processes boosted >=5 times', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 6; i++) {
      ll.logAction('boost', makeContext({ comm: 'firefox', pid: 1000 + i }));
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    assert.ok(result.suggestions.length >= 1);
    const boostSuggestion = result.suggestions.find((s) => s.type === 'boost');
    assert.ok(boostSuggestion, 'expected a boost suggestion');
    assert.strictEqual(boostSuggestion.comm, 'firefox');
    assert.strictEqual(boostSuggestion.count, 6);
    assert.strictEqual(boostSuggestion.rule.id, 'auto-boost-firefox');
    assert.strictEqual(boostSuggestion.rule.action.type, 'boostProcess');
    assert.strictEqual(boostSuggestion.rule.action.pid, 'foreground');
    assert.strictEqual(boostSuggestion.rule.when.event, 'onForegroundChanged');
    assert.strictEqual(boostSuggestion.rule.match['foreground.comm'], 'firefox');
    cleanup(cfg);
  });

  it('suggests a throttle rule for processes throttled >=5 times', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 5; i++) {
      ll.logAction('throttle', makeContext({ comm: 'compile-job', pid: 2000 + i }));
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    const throttleSuggestion = result.suggestions.find((s) => s.type === 'throttle');
    assert.ok(throttleSuggestion, 'expected a throttle suggestion');
    assert.strictEqual(throttleSuggestion.comm, 'compile-job');
    assert.strictEqual(throttleSuggestion.count, 5);
    assert.strictEqual(throttleSuggestion.rule.id, 'auto-throttle-compile-job');
    assert.strictEqual(throttleSuggestion.rule.action.type, 'throttleProcess');
    assert.strictEqual(throttleSuggestion.rule.when.event, 'onCpuHigh');
    assert.strictEqual(throttleSuggestion.rule.match['processes.names'], 'compile-job');
    cleanup(cfg);
  });

  it('does not suggest a rule for processes with <5 occurrences', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 4; i++) {
      ll.logAction('boost', makeContext({ comm: 'rare-app' }));
    }
    ll.logAction('boost', makeContext({ comm: 'common-app' })); // 1 entry
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'common-app' }));
    }
    const result = ll.suggestRules();
    // Only common-app should have a suggestion (5 occurrences)
    // rare-app has 4 (below threshold of 5)
    const rareSuggestion = result.suggestions.find((s) => s.comm === 'rare-app');
    assert.strictEqual(rareSuggestion, undefined);
    cleanup(cfg);
  });

  it('sorts suggestions by count descending', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    // firefox: 7 boosts
    for (let i = 0; i < 7; i++) {
      ll.logAction('boost', makeContext({ comm: 'firefox', pid: 100 + i }));
    }
    // chrome: 5 boosts
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'chrome', pid: 200 + i }));
    }
    // rustc: 6 throttles
    for (let i = 0; i < 6; i++) {
      ll.logAction('throttle', makeContext({ comm: 'rustc', pid: 300 + i }));
    }
    const result = ll.suggestRules();
    assert.ok(result.suggestions.length >= 2);
    for (let i = 1; i < result.suggestions.length; i++) {
      assert.ok(result.suggestions[i - 1].count >= result.suggestions[i].count,
        `suggestions should be sorted descending by count, got ${result.suggestions[i - 1].count} < ${result.suggestions[i].count}`);
    }
    cleanup(cfg);
  });

  it('groups by comm+action (boost and throttle for same comm are separate)', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 10 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 6; i++) {
      ll.logAction('boost', makeContext({ comm: 'mixed-app', pid: 100 + i }));
    }
    for (let i = 0; i < 6; i++) {
      ll.logAction('throttle', makeContext({ comm: 'mixed-app', pid: 200 + i }));
    }
    const result = ll.suggestRules();
    const boostS = result.suggestions.find((s) => s.type === 'boost' && s.comm === 'mixed-app');
    const throttleS = result.suggestions.find((s) => s.type === 'throttle' && s.comm === 'mixed-app');
    assert.ok(boostS, 'expected a boost suggestion for mixed-app');
    assert.ok(throttleS, 'expected a throttle suggestion for mixed-app');
    assert.strictEqual(boostS.count, 6);
    assert.strictEqual(throttleS.count, 6);
    cleanup(cfg);
  });

  it('returns enough:false with current:0 when log is empty', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 1 });
    const ll = new LearningLogger(cfg);
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, false);
    assert.strictEqual(result.current, 0);
    assert.strictEqual(result.needed, 1);
    assert.deepStrictEqual(result.suggestions, []);
    cleanup(cfg);
  });

  it('skips entries without comm when grouping', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    // Write 5 entries without comm directly to the log file
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(ll.logFile, JSON.stringify({ action: 'boost', pid: i }) + '\n');
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    assert.strictEqual(result.suggestions.length, 0);
    cleanup(cfg);
  });

  it('handles threshold exactly equal to entry count', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'edge-app', pid: i }));
    }
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    assert.strictEqual(result.current, 5);
    assert.strictEqual(result.needed, 5);
    cleanup(cfg);
  });

  it('lowercases comm in rule id', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'FireFox', pid: i }));
    }
    const result = ll.suggestRules();
    const s = result.suggestions.find((x) => x.comm === 'FireFox');
    assert.ok(s);
    assert.strictEqual(s.rule.id, 'auto-boost-firefox');
    cleanup(cfg);
  });

  it('description includes the manual count', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 7; i++) {
      ll.logAction('boost', makeContext({ comm: 'firefox', pid: i }));
    }
    const result = ll.suggestRules();
    assert.ok(result.suggestions.length > 0,
      `expected at least 1 suggestion, got ${result.suggestions.length}`);
    const s = result.suggestions[0];
    assert.ok(s.rule && s.rule.description,
      `suggestion missing rule.description: ${JSON.stringify(s)}`);
    assert.ok(s.rule.description.includes('7 manual boosts'),
      `expected "7 manual boosts" in description, got: ${s.rule.description}`);
    cleanup(cfg);
  });

  it('threshold of 5 occurrences is inclusive (exactly 5 IS suggested)', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'five-app', pid: i }));
    }
    const result = ll.suggestRules();
    const s = result.suggestions.find((x) => x.comm === 'five-app');
    assert.ok(s, 'expected a suggestion for exactly 5 occurrences');
    assert.strictEqual(s.count, 5);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. CLEAR
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger.clear()', () => {
  it('removes an existing log file', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    assert.ok(fs.existsSync(ll.logFile));
    ll.clear();
    assert.ok(!fs.existsSync(ll.logFile));
    cleanup(cfg);
  });

  it('resets entryCount to 0', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    ll.logAction('boost', makeContext());
    assert.strictEqual(ll.entryCount, 2);
    ll.clear();
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('does not throw when log file does not exist', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    assert.doesNotThrow(() => ll.clear());
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('clears file contents and re-reads as empty', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ pid: i }));
    }
    ll.clear();
    assert.deepStrictEqual(ll.readEntries(), []);
    cleanup(cfg);
  });

  it('allows logging again after clear', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext({ comm: 'before' }));
    ll.clear();
    ll.logAction('boost', makeContext({ comm: 'after' }));
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].comm, 'after');
    assert.strictEqual(ll.entryCount, 1);
    cleanup(cfg);
  });

  it('is idempotent (calling twice in a row is safe)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext());
    ll.clear();
    assert.doesNotThrow(() => ll.clear());
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. GETTERS
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger getters', () => {
  it('logFile returns the configured path', () => {
    const cfg = makeConfig({ LEARNING_LOG_FILE: '/tmp/some-other.log' });
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.logFile, '/tmp/some-other.log');
    cleanup(cfg);
  });

  it('entryCount starts at 0', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });

  it('entryCount reflects writes', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    for (let i = 0; i < 10; i++) {
      ll.logAction('boost', makeContext({ pid: i }));
    }
    assert.strictEqual(ll.entryCount, 10);
    cleanup(cfg);
  });

  it('entryCount does NOT reflect manual file writes (only logAction calls)', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    // Manually write to the log file — entryCount should still be 0
    fs.appendFileSync(ll.logFile, JSON.stringify({ action: 'boost', pid: 1 }) + '\n');
    assert.strictEqual(ll.entryCount, 0);
    cleanup(cfg);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. ROUND-TRIP INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

describe('LearningLogger round-trip integration', () => {
  it('write -> read -> suggest end-to-end', () => {
    const cfg = makeConfig({ LEARNING_MIN_ENTRIES: 5 });
    const ll = new LearningLogger(cfg);
    // Write 5 boosts and 5 throttles for different comms
    for (let i = 0; i < 5; i++) {
      ll.logAction('boost', makeContext({ comm: 'boost-target', pid: 100 + i }));
    }
    for (let i = 0; i < 5; i++) {
      ll.logAction('throttle', makeContext({ comm: 'throttle-target', pid: 200 + i }));
    }
    // Verify the round trip
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 10);
    const result = ll.suggestRules();
    assert.strictEqual(result.enough, true);
    assert.strictEqual(result.current, 10);
    assert.ok(result.suggestions.length >= 2);
    const boostS = result.suggestions.find((s) => s.type === 'boost');
    const throttleS = result.suggestions.find((s) => s.type === 'throttle');
    assert.ok(boostS);
    assert.ok(throttleS);
    assert.strictEqual(boostS.comm, 'boost-target');
    assert.strictEqual(throttleS.comm, 'throttle-target');
    cleanup(cfg);
  });

  it('survives log file truncation between writes', () => {
    const cfg = makeConfig();
    const ll = new LearningLogger(cfg);
    ll.logAction('boost', makeContext({ comm: 'first' }));
    ll.logAction('boost', makeContext({ comm: 'second' }));
    // Truncate the file externally
    fs.writeFileSync(ll.logFile, '');
    // Subsequent writes should still work
    ll.logAction('boost', makeContext({ comm: 'third' }));
    const entries = ll.readEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].comm, 'third');
    cleanup(cfg);
  });

  it('new instance can read logs written by a previous instance', () => {
    const cfg = makeConfig();
    const ll1 = new LearningLogger(cfg);
    ll1.logAction('boost', makeContext({ comm: 'persisted-app' }));
    ll1.logAction('throttle', makeContext({ comm: 'persisted-app' }));

    // Create a second instance pointing at the same file
    const ll2 = new LearningLogger(cfg);
    // entryCount should start at 0 for the new instance (in-memory state)
    assert.strictEqual(ll2.entryCount, 0);
    // But it should read the persisted entries
    const entries = ll2.readEntries();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].comm, 'persisted-app');
    cleanup(cfg);
  });
});
