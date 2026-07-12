'use strict';

/**
 * DynAlloc — Policy Engine :: Policy Logger
 * =========================================
 *
 * Specialized audit logger for the Policy Engine. Every policy
 * execution produces exactly one structured entry containing:
 *
 *   - timestamp (ISO 8601)
 *   - trigger (event name)
 *   - triggerPayload (snapshot of event payload, truncated)
 *   - ruleId
 *   - matchedFields (key/value map of what the matcher saw)
 *   - action (the action object that was attempted)
 *   - executionTimeMs (high-resolution duration)
 *   - success (boolean)
 *   - error (string or null)
 *   - rollbackApplied (boolean)
 *
 * Output destinations:
 *   - Console via the main logger (debug level by default)
 *   - Optional dedicated audit file with rotation, kept completely
 *     independent from the main daemon log file so policy audits
 *     survive daemon log rotation
 *   - In-memory ring buffer (default 500 entries) for programmatic
 *     access via `recentEntries()` — useful for tests and for a
 *     future HTTP/IPC status endpoint
 *
 * The logger is fire-and-forget: writes are buffered in memory and
 * flushed to disk asynchronously via a WriteStream. A write failure
 * never throws — at worst the entry is lost (logged via main logger).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { debug, warn, info } = logger;

const DEFAULT_RING_BUFFER_SIZE = 500;
const MAX_PAYLOAD_STRING_LEN = 1024;

class PolicyLogger {
  constructor(opts = {}) {
    this._ringBufferSize = opts.ringBufferSize || DEFAULT_RING_BUFFER_SIZE;
    this._ring = [];
    this._ringIdx = 0;

    this._filePath = null;
    this._stream = null;
    this._maxSizeBytes = (opts.maxSizeMb || 5) * 1024 * 1024;
    this._maxFiles = opts.maxFiles || 3;

    this._counters = {
      total: 0,
      success: 0,
      failure: 0,
      rollback: 0,
    };

    if (opts.filePath) {
      this._setupFileStream(opts.filePath);
    }
  }

  /**
   * Write a single execution record.
   *
   * @param {object} entry - see class doc for shape
   */
  log(entry) {
    if (!entry || typeof entry !== 'object') return;

    const record = {
      timestamp: entry.timestamp || new Date().toISOString(),
      trigger: entry.trigger || null,
      triggerPayload: this._truncate(entry.triggerPayload),
      ruleId: entry.ruleId || null,
      matchedFields: entry.matchedFields || {},
      action: entry.action || null,
      executionTimeMs: typeof entry.executionTimeMs === 'number'
        ? Number(entry.executionTimeMs.toFixed(3)) : 0,
      success: !!entry.success,
      error: entry.error || null,
      rollbackApplied: !!entry.rollbackApplied,
    };

    this._counters.total++;
    if (record.success) this._counters.success++;
    else this._counters.failure++;
    if (record.rollbackApplied) this._counters.rollback++;

    // Ring buffer (circular, no unbounded growth)
    this._ring[this._ringIdx] = record;
    this._ringIdx = (this._ringIdx + 1) % this._ringBufferSize;
    if (this._ring.length > this._ringBufferSize) {
      this._ring.length = this._ringBufferSize;
    }

    // Console mirror (debug level to avoid spamming info logs)
    const status = record.success ? 'OK' : 'FAIL';
    const rollbackTag = record.rollbackApplied ? ' (rolled back)' : '';
    debug(
      `[policy] ${status}${rollbackTag} rule="${record.ruleId}" ` +
      `trigger="${record.trigger}" ${record.executionTimeMs}ms` +
      (record.error ? ` err="${record.error}"` : '')
    );

    // File output
    if (this._stream) {
      try {
        this._stream.write(JSON.stringify(record) + '\n');
        this._rotateIfNeeded();
      } catch (_) { /* file write failure is non-fatal */ }
    }
  }

  /**
   * Return the N most recent entries, newest first.
   */
  recentEntries(count = 50) {
    const n = Math.min(count, this._ring.length);
    if (n === 0) return [];
    const out = [];
    // Walk backwards from the most recent write position
    let idx = (this._ringIdx - 1 + this._ringBufferSize) % this._ringBufferSize;
    for (let i = 0; i < n; i++) {
      const entry = this._ring[idx];
      if (entry) out.push(entry);
      idx = (idx - 1 + this._ringBufferSize) % this._ringBufferSize;
      // If ring isn't full yet, we may walk into undefined slots
      if (this._ring.length < this._ringBufferSize && idx >= this._ring.length) break;
    }
    return out;
  }

  /**
   * @returns {object} cumulative counters
   */
  get stats() {
    return { ...this._counters };
  }

  /**
   * Close the file stream. Called on daemon shutdown.
   */
  close(callback) {
    if (this._stream) {
      const stream = this._stream;
      this._stream = null;
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
   * Reset all in-memory state (for tests).
   */
  reset() {
    this._ring = [];
    this._ringIdx = 0;
    this._counters = { total: 0, success: 0, failure: 0, rollback: 0 };
  }

  // ── Internal ──────────────────────────────────────────────────────

  _truncate(value) {
    if (value === null || value === undefined) return value;
    try {
      const s = JSON.stringify(value);
      if (s.length <= MAX_PAYLOAD_STRING_LEN) return value;
      return { _truncated: true, preview: s.slice(0, MAX_PAYLOAD_STRING_LEN) };
    } catch (_) {
      return { _unserializable: true };
    }
  }

  _setupFileStream(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    this._filePath = filePath;
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) { /* dir may already exist */ }
    try {
      this._stream = fs.createWriteStream(filePath, { flags: 'a' });
      this._stream.on('error', () => { /* loss of audit file is non-fatal */ });
      info(`Policy audit log: ${filePath}`);
    } catch (err) {
      warn(`Policy audit log unavailable: ${err.message}`);
      this._stream = null;
    }
  }

  _rotateIfNeeded() {
    if (!this._filePath || !this._stream) return;
    try {
      const stat = fs.statSync(this._filePath);
      if (stat.size < this._maxSizeBytes) return;

      try { this._stream.end(); } catch (_) { /* noop */ }

      for (let i = this._maxFiles - 1; i >= 1; i--) {
        const src = i === 1 ? this._filePath : `${this._filePath}.${i - 1}`;
        const dst = `${this._filePath}.${i}`;
        try {
          if (fs.existsSync(src)) fs.renameSync(src, dst);
        } catch (_) { /* skip */ }
      }

      this._stream = fs.createWriteStream(this._filePath, { flags: 'a' });
      this._stream.on('error', () => { /* noop */ });
    } catch (_) { /* rotation failure is non-fatal */ }
  }
}

module.exports = {
  PolicyLogger,
  DEFAULT_RING_BUFFER_SIZE,
};
