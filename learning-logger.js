'use strict';

/**
 * DynAlloc — Learning Mode Logger (v2.1.10)
 * ==========================================
 *
 * When ENABLE_LEARNING_MODE is true, the daemon logs every manual
 * boost/throttle action (from `dynalloc boost <pid>` / `dynalloc throttle <pid>`)
 * to a log file. After LEARNING_MIN_ENTRIES entries, the user can run
 * `dynalloc learn --suggest` to generate suggested policy rules.
 *
 * Log format (JSON lines, one entry per line):
 *   {"timestamp":"2025-07-11T...","action":"boost","pid":12345,
 *    "comm":"firefox","category":"BROWSER","schedClass":"INTERACTIVE",
 *    "stressLevel":"WARN","cpuPressure":12.5,"foregroundPid":12345}
 *
 * Suggestion algorithm:
 *   - Group entries by comm name
 *   - If a process is manually boosted >5 times, suggest a rule:
 *     "always boost <comm> when foreground"
 *   - If a process is manually throttled >5 times, suggest a rule:
 *     "always throttle <comm> when stress > WARN"
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const { info, warn, debug } = logger;

class LearningLogger {
  constructor(config) {
    this._config = config;
    this._logFile = config.LEARNING_LOG_FILE ||
      path.join(os.homedir() || '', '.config', 'dynalloc', 'learn.log');
    this._minEntries = config.LEARNING_MIN_ENTRIES || 50;
    this._entryCount = 0;
  }

  /**
   * Log a manual action (boost or throttle).
   */
  logAction(action, context) {
    if (!this._config.ENABLE_LEARNING_MODE) return;
    if (typeof action !== 'string' || !context) return;

    const entry = {
      timestamp: new Date().toISOString(),
      action,
      pid: context.pid || null,
      comm: context.comm || '',
      category: context.category || '',
      schedClass: context.schedClass || '',
      stressLevel: context.stressLevel || '',
      cpuPressure: context.cpuPressure || 0,
      foregroundPid: context.foregroundPid || null,
    };

    try {
      // Ensure directory exists
      const dir = path.dirname(this._logFile);
      fs.mkdirSync(dir, { recursive: true });
      // Append JSON line
      fs.appendFileSync(this._logFile, JSON.stringify(entry) + '\n');
      this._entryCount++;
      debug(`Learning log: ${action} ${entry.comm} (entry #${this._entryCount})`);
    } catch (err) {
      warn(`Learning log write failed: ${err.message}`);
    }
  }

  /**
   * Read all entries from the log file.
   */
  readEntries() {
    try {
      if (!fs.existsSync(this._logFile)) return [];
      const raw = fs.readFileSync(this._logFile, 'utf8');
      return raw.trim().split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          try { return JSON.parse(l); }
          catch (_) { return null; }
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * Generate suggested rules based on logged entries.
   * Returns an array of rule suggestion objects.
   */
  suggestRules() {
    const entries = this.readEntries();
    if (entries.length < this._minEntries) {
      return {
        enough: false,
        current: entries.length,
        needed: this._minEntries,
        suggestions: [],
      };
    }

    // Group by comm + action
    const byCommAction = new Map();
    for (const e of entries) {
      if (!e.comm) continue;
      const key = `${e.comm}:${e.action}`;
      byCommAction.set(key, (byCommAction.get(key) || 0) + 1);
    }

    const suggestions = [];
    for (const [key, count] of byCommAction) {
      const idx = key.lastIndexOf(':');
      const comm = idx > 0 ? key.slice(0, idx) : key;
      const action = idx > 0 ? key.slice(idx + 1) : '';
      if (count < 5) continue; // need at least 5 occurrences to suggest

      if (action === 'boost') {
        suggestions.push({
          type: 'boost',
          comm,
          count,
          rule: {
            id: `auto-boost-${comm.toLowerCase()}`,
            when: { event: 'onForegroundChanged' },
            match: { 'foreground.comm': comm },
            action: { type: 'boostProcess', pid: 'foreground' },
            description: `Auto-boost ${comm} when it becomes foreground (suggested: ${count} manual boosts)`,
          },
        });
      } else if (action === 'throttle') {
        suggestions.push({
          type: 'throttle',
          comm,
          count,
          rule: {
            id: `auto-throttle-${comm.toLowerCase()}`,
            when: { event: 'onCpuHigh' },
            match: { 'processes.names': comm },
            action: { type: 'throttleProcess', pid: 'foreground' },
            description: `Auto-throttle ${comm} when CPU is high (suggested: ${count} manual throttles)`,
          },
        });
      }
    }

    // Sort by count descending
    suggestions.sort((a, b) => b.count - a.count);

    return {
      enough: true,
      current: entries.length,
      needed: this._minEntries,
      suggestions,
    };
  }

  /**
   * Clear the learning log.
   */
  clear() {
    try {
      if (fs.existsSync(this._logFile)) {
        fs.unlinkSync(this._logFile);
      }
      this._entryCount = 0;
      info('Learning log cleared.');
    } catch (err) {
      warn(`Cannot clear learning log: ${err.message}`);
    }
  }

  get logFile() {
    return this._logFile;
  }

  get entryCount() {
    return this._entryCount;
  }
}

module.exports = { LearningLogger };
