'use strict';

/**
 * DynAlloc — Logger Module
 *
 * Production-grade structured logger with level filtering, log rotation,
 * timestamps, process ID, and scheduler state context.
 *
 * Levels: TRACE < DEBUG < INFO < WARN < ERROR < FATAL
 */

const fs = require('fs');
const path = require('path');

const LEVELS = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVEL_NAMES = Object.keys(LEVELS);

let _currentLevel = 'info';
let _onLog = null;
let _logFilePath = null;
let _logStream = null;
let _maxLogSizeBytes = 10 * 1024 * 1024; // 10 MB
let _maxLogFiles = 3;

function setLevel(level) {
  const normalized = String(level).toLowerCase();
  if (normalized in LEVELS) {
    _currentLevel = normalized;
  }
}

function getLevel() {
  return _currentLevel;
}

function setLogHook(fn) {
  _onLog = fn;
}

/**
 * Configure file logging with rotation.
 * @param {object} opts
 * @param {string} [opts.filePath] - path to log file
 * @param {number} [opts.maxSizeBytes] - max size before rotation (default 10MB)
 * @param {number} [opts.maxFiles] - max rotated files to keep (default 3)
 */
function setupFileLogging(opts = {}) {
  if (_logStream) {
    try { _logStream.end(); } catch (_) { /* noop */ }
    _logStream = null;
  }

  if (!opts.filePath) return;

  _logFilePath = opts.filePath;
  _maxLogSizeBytes = opts.maxSizeBytes || _maxLogSizeBytes;
  _maxLogFiles = opts.maxFiles || _maxLogFiles;

  const dir = path.dirname(_logFilePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* dir may already exist */ }

  try {
    _logStream = fs.createWriteStream(_logFilePath, { flags: 'a' });
    _logStream.on('error', () => { /* loss of log file is non-fatal */ });
  } catch (_) { /* file logging not available */ }
}

/**
 * Close the log file stream (called on shutdown).
 * @param {Function} [callback] - dipanggil setelah stream benar-benar selesai
 *   di-flush ke disk (event 'finish'). Opsional — kalau tidak diberikan,
 *   perilakunya sama seperti sebelumnya (fire-and-forget).
 */
function closeFileLogging(callback) {
  if (_logStream) {
    const stream = _logStream;
    _logStream = null;
    try {
      stream.end(callback);
    } catch (_) {
      if (callback) callback();
    }
  } else if (callback) {
    callback();
  }
}

/**
 * Rotate log file if it exceeds the max size.
 */
function _rotateIfNeeded() {
  if (!_logFilePath || !_logStream) return;

  try {
    const stat = fs.statSync(_logFilePath);
    if (stat.size < _maxLogSizeBytes) return;

    // Close current stream
    try { _logStream.end(); } catch (_) { /* noop */ }
    // BUG FIX (v2.1.2): Set _logStream = null BEFORE attempting rotation
    // so that if createWriteStream throws below, subsequent log() calls
    // skip file output (line `if (_logStream)`) instead of writing to
    // the ended stream (which silently drops every log line forever).
    _logStream = null;

    // Rotate: .log.1 -> .log.2, .log.2 -> .log.3, etc.
    for (let i = _maxLogFiles - 1; i >= 1; i--) {
      const src = i === 1 ? _logFilePath : `${_logFilePath}.${i - 1}`;
      const dst = `${_logFilePath}.${i}`;
      try {
        if (fs.existsSync(src)) {
          fs.renameSync(src, dst);
        }
      } catch (_) { /* skip */ }
    }

    // Reopen
    _logStream = fs.createWriteStream(_logFilePath, { flags: 'a' });
    _logStream.on('error', () => { /* noop */ });
  } catch (_) { /* rotation failure is non-fatal */ }
}

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, schedulerState, args) {
  const ts = formatTimestamp();
  const pid = process.pid;
  const lvl = level.toUpperCase().padEnd(5);
  const state = schedulerState ? ` [${schedulerState}]` : '';
  return `[${ts}] [${lvl}] [pid:${pid}]${state} ${args.join(' ')}`;
}

function log(level, ...args) {
  const normalizedLevel = String(level).toLowerCase();
  if (!(normalizedLevel in LEVELS)) return;
  if (LEVELS[normalizedLevel] < LEVELS[_currentLevel]) return;

  const schedulerState = _getSchedulerState();
  const message = formatMessage(normalizedLevel, schedulerState, args);

  // Console output
  switch (normalizedLevel) {
    case 'fatal':
    case 'error':
      console.error(message);
      break;
    case 'warn':
      console.warn(message);
      break;
    default:
      console.log(message);
  }

  // File output
  if (_logStream) {
    try {
      _logStream.write(message + '\n');
      _rotateIfNeeded();
    } catch (_) { /* file write failure is non-fatal */ }
  }

  // Hook
  if (_onLog) {
    try { _onLog(normalizedLevel, formatTimestamp(), args); } catch (_) { /* hook must not throw */ }
  }
}

function trace(...args) { log('trace', ...args); }
function debug(...args) { log('debug', ...args); }
function info(...args)  { log('info', ...args); }
function warn(...args)  { log('warn', ...args); }
function error(...args) { log('error', ...args); }
function fatal(...args) { log('fatal', ...args); }

// ── Scheduler state context (set by daemon) ────────────────────────────

let _schedulerStateFn = null;

/**
 * Set a function that returns the current scheduler state string.
 * Called from daemon to provide context in log messages.
 */
function setSchedulerStateProvider(fn) {
  _schedulerStateFn = typeof fn === 'function' ? fn : null;
}

function _getSchedulerState() {
  if (!_schedulerStateFn) return null;
  try {
    return _schedulerStateFn();
  } catch (_) {
    return null;
  }
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  setLevel,
  getLevel,
  setLogHook,
  setupFileLogging,
  closeFileLogging,
  log,
  trace,
  debug,
  info,
  warn,
  error,
  fatal,
  setSchedulerStateProvider,
};