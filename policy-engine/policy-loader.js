'use strict';

/**
 * DynAlloc — Policy Engine :: Policy Loader
 * =========================================
 *
 * Loads, validates, and hot-reloads the policy file (JSON or YAML).
 *
 * Supported file formats:
 *   - .json  (parsed with JSON.parse, strict)
 *   - .yaml  (parsed with a minimal YAML subset parser — see _parseYaml)
 *   - .yml   (same as .yaml)
 *
 * File resolution order:
 *   1. $DYNALLOC_POLICY_PATH env var
 *   2. CONFIG.POLICY_FILE_PATH (if set in main config)
 *   3. ~/.config/dynalloc/policies.json
 *   4. ~/.config/dynalloc/policies.yaml
 *   5. /etc/dynalloc/policies.json
 *
 * Hot reload:
 *   - When POLICY_HOT_RELOAD is true, watches the resolved policy file
 *     with fs.watch and re-loads on change (300ms debounce).
 *   - Validation errors during reload are non-fatal — the previous
 *     valid ruleset stays in effect until a valid file replaces it.
 *
 * Validation:
 *   - Top-level shape: { rules: [...], profiles: {...} }
 *   - Each rule is normalized via rule-engine.normalizeRule().
 *   - Unknown top-level keys are silently dropped.
 *   - Duplicate rule ids are rejected (last one wins, with a warning).
 *
 * Backward compatibility: the loader is only constructed when
 * ENABLE_POLICY_ENGINE is true.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger');
const { info, warn, debug } = logger;
const { normalizeRule } = require('./rule-engine');

/**
 * Resolve the policy file path using the documented priority order.
 * @returns {string|null}
 */
function resolvePolicyPath(config) {
  const candidates = [
    process.env.DYNALLOC_POLICY_PATH,
    config && config.POLICY_FILE_PATH,
    path.join(os.homedir() || '', '.config', 'dynalloc', 'policies.json'),
    path.join(os.homedir() || '', '.config', 'dynalloc', 'policies.yaml'),
    path.join(os.homedir() || '', '.config', 'dynalloc', 'policies.yml'),
    '/etc/dynalloc/policies.json',
    '/etc/dynalloc/policies.yaml',
  ].filter(Boolean);

  for (const p of candidates) {
    if (typeof p !== 'string') continue;
    if (p.includes('\0') || p.includes('..')) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* skip */ }
  }
  return null;
}

/**
 * Read and parse a policy file.
 * @param {string} filePath
 * @returns {object|null} parsed object or null on failure
 */
function readPolicyFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warn(`PolicyLoader: cannot read "${filePath}": ${err.message}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.json') {
      return JSON.parse(raw);
    }
    if (ext === '.yaml' || ext === '.yml') {
      return _parseYaml(raw);
    }
    // Unknown extension — try JSON first, fall back to YAML
    try { return JSON.parse(raw); }
    catch (_) { return _parseYaml(raw); }
  } catch (err) {
    warn(`PolicyLoader: parse error in "${filePath}": ${err.message}`);
    return null;
  }
}

/**
 * Minimal YAML subset parser supporting:
 *   - Top-level key: value (string/number/boolean)
 *   - Top-level key: (followed by indented block of "  - item" lists
 *     or "  key: value" maps)
 *   - Lists with "- item" or "- key: value" (object items)
 *   - Nested maps via 2-space indentation
 *
 * This is NOT a full YAML parser — it covers the subset used in the
 * example policies.yaml and the README documentation. For anything
 * more complex, users should switch to JSON.
 *
 * @param {string} text
 * @returns {object}
 */
function _parseYaml(text) {
  const lines = text.split('\n');
  // Strip comments and trailing whitespace
  const cleaned = lines.map((l) => {
    let out = l;
    // Don't strip # inside single or double quotes
    let inSingle = false, inDouble = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "'" && !inDouble) inSingle = !inSingle;
      else if (out[i] === '"' && !inSingle) inDouble = !inDouble;
      else if (out[i] === '#' && !inSingle && !inDouble) { out = out.slice(0, i); break; }
    }
    return out.replace(/\s+$/, '');
  }).filter((l) => l.trim().length > 0);

  let i = 0;
  function parseBlock(indent) {
    const result = {};
    while (i < cleaned.length) {
      const line = cleaned[i];
      const curIndent = line.length - line.trimStart().length;
      if (curIndent < indent) break;
      if (curIndent > indent) {
        // Unexpected over-indent without a parent — skip
        i++;
        continue;
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith('- ')) {
        // List item under a parent key — handled by parseList
        i++;
        continue;
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) { i++; continue; }
      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();
      i++;
      if (rest.length > 0) {
        result[key] = _coerceScalar(rest);
      } else {
        // Look ahead for nested block or list
        if (i < cleaned.length) {
          const nextLine = cleaned[i];
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent > indent && nextLine.trimStart().startsWith('- ')) {
            result[key] = parseList(nextIndent);
          } else if (nextIndent > indent) {
            result[key] = parseBlock(nextIndent);
          } else {
            result[key] = null;
          }
        } else {
          result[key] = null;
        }
      }
    }
    return result;
  }
  function parseList(indent) {
    const arr = [];
    while (i < cleaned.length) {
      const line = cleaned[i];
      const curIndent = line.length - line.trimStart().length;
      if (curIndent < indent) break;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('- ')) break;
      const itemContent = trimmed.slice(2).trim();
      i++;
      if (itemContent.length === 0) {
        // Multi-line item, nested block follows
        if (i < cleaned.length) {
          const nextIndent = cleaned[i].length - cleaned[i].trimStart().length;
          if (nextIndent > indent) arr.push(parseBlock(nextIndent));
          else arr.push(null);
        } else {
          arr.push(null);
        }
        continue;
      }
      const colonIdx = itemContent.indexOf(':');
      if (colonIdx !== -1 && !itemContent.startsWith('"')) {
        // Inline object item: "- key: value"
        const obj = {};
        const key = itemContent.slice(0, colonIdx).trim();
        const val = itemContent.slice(colonIdx + 1).trim();
        if (val.length > 0) {
          obj[key] = _coerceScalar(val);
          // Continue reading additional sibling keys at the same deeper
          // indentation (e.g. "- key: value\n  key2: value2").
          if (i < cleaned.length) {
            const nextIndent = cleaned[i].length - cleaned[i].trimStart().length;
            if (nextIndent > indent) {
              const nested = parseBlock(nextIndent);
              Object.assign(obj, nested);
            }
          }
        } else {
          // "- key:" with no inline value — the value is a nested list
          // or map on the following, deeper-indented lines (mirrors the
          // bare "key:" handling in parseBlock). Without this branch,
          // nested lists were silently dropped and nested maps were
          // incorrectly flattened into sibling keys of `obj` instead of
          // being nested under `key`.
          if (i < cleaned.length) {
            const nextLine = cleaned[i];
            const nextIndent = nextLine.length - nextLine.trimStart().length;
            if (nextIndent > indent && nextLine.trimStart().startsWith('- ')) {
              obj[key] = parseList(nextIndent);
            } else if (nextIndent > indent) {
              obj[key] = parseBlock(nextIndent);
            } else {
              obj[key] = null;
            }
          } else {
            obj[key] = null;
          }
        }
        arr.push(obj);
      } else {
        arr.push(_coerceScalar(itemContent));
      }
    }
    return arr;
  }
  function _coerceScalar(s) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    // Strip surrounding quotes
    if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') ||
                          (s[0] === "'" && s[s.length - 1] === "'"))) {
      return s.slice(1, -1);
    }
    return s;
  }
  return parseBlock(0);
}

/**
 * Validate and normalize a parsed policy object.
 * Returns { rules, profiles, warnings }.
 *
 * @param {object} parsed
 * @param {object} defaults - { cooldownMs, executionTimeoutMs }
 * @returns {{rules: Array, profiles: object, warnings: Array<string>}}
 */
function validatePolicy(parsed, defaults) {
  const warnings = [];
  if (!parsed || typeof parsed !== 'object') {
    return { rules: [], profiles: {}, warnings: ['policy file is not an object'] };
  }
  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const rawProfiles = (parsed.profiles && typeof parsed.profiles === 'object' &&
                       !Array.isArray(parsed.profiles)) ? parsed.profiles : {};

  const rules = [];
  const seenIds = new Set();
  rawRules.forEach((raw, idx) => {
    try {
      const normalized = normalizeRule(raw, defaults, idx);
      if (seenIds.has(normalized.id)) {
        warnings.push(`duplicate rule id "${normalized.id}", last one wins`);
      }
      seenIds.add(normalized.id);
      rules.push(normalized);
    } catch (err) {
      warnings.push(`rule #${idx}: ${err.message}`);
    }
  });

  // Validate profiles
  const profiles = {};
  for (const [name, p] of Object.entries(rawProfiles)) {
    if (!p || typeof p !== 'object') {
      warnings.push(`profile "${name}" is not an object, skipped`);
      continue;
    }
    profiles[name] = {
      governor: typeof p.governor === 'string' ? p.governor : undefined,
      governorCores: typeof p.governorCores === 'string' ? p.governorCores : 'foreground',
      schedulerMode: typeof p.schedulerMode === 'string' ? p.schedulerMode : undefined,
      foregroundBoost: !!p.foregroundBoost,
    };
  }

  return { rules, profiles, warnings };
}

// ── Loader class ──────────────────────────────────────────────────────

class PolicyLoader {
  /**
   * @param {object} opts
   * @param {object} opts.config - main daemon CONFIG
   * @param {object} opts.defaults - { cooldownMs, executionTimeoutMs }
   * @param {Function} opts.onReload - callback(parsedPolicy) on successful (re)load
   */
  constructor(opts) {
    this._config = opts.config;
    this._defaults = opts.defaults || { cooldownMs: 1000, executionTimeoutMs: 5000 };
    this._onReload = typeof opts.onReload === 'function' ? opts.onReload : null;
    this._filePath = null;
    this._watching = false;
    this._debounceTimer = null;
    this._shuttingDown = false;
    this._lastLoaded = null;
  }

  /**
   * Initial load. Resolves the policy file path, reads it, validates
   * it, and invokes onReload. Returns the loaded policy or null.
   */
  load() {
    this._filePath = resolvePolicyPath(this._config);
    if (!this._filePath) {
      info('PolicyLoader: no policy file found, engine will run with zero rules');
      this._onReload && this._onReload({ rules: [], profiles: {}, warnings: [] });
      return null;
    }

    const parsed = readPolicyFile(this._filePath);
    if (!parsed) {
      warn(`PolicyLoader: failed to parse "${this._filePath}", running with zero rules`);
      this._onReload && this._onReload({ rules: [], profiles: {}, warnings: [] });
      return null;
    }

    const validated = validatePolicy(parsed, this._defaults);
    for (const w of validated.warnings) {
      warn(`PolicyLoader: ${w}`);
    }
    info(`PolicyLoader: loaded ${validated.rules.length} rule(s) and ` +
         `${Object.keys(validated.profiles).length} profile(s) from ${this._filePath}`);

    this._lastLoaded = validated;
    this._onReload && this._onReload(validated);
    return validated;
  }

  /**
   * Start watching the policy file for hot reload.
   *
   * Uses fs.watchFile (polling) instead of fs.watch (inotify) because:
   *   1. fs.watch watches inodes — common editor patterns like
   *      `mv new.json policies.json` replace the inode and silently
   *      stop the watcher. fs.watchFile follows the path.
   *   2. fs.watchFile is more portable across Linux/Mac/WSL.
   * The trade-off is up to 5s of latency (default polling interval),
   * which is acceptable for a policy file.
   */
  startWatch() {
    if (!this._filePath) return;
    if (!this._config.POLICY_HOT_RELOAD) return;
    try {
      // Persistent=false so the watcher doesn't keep the event loop
      // alive on shutdown. Poll every 1s for snappy reloads.
      fs.watchFile(this._filePath, { persistent: false, interval: 1000 }, (curr, prev) => {
        if (this._shuttingDown) return;
        // Only fire on mtime change
        if (curr.mtimeMs === prev.mtimeMs) return;
        debug(`PolicyLoader: file changed: ${this._filePath}`);
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          this._reload();
        }, 300);
        if (this._debounceTimer && typeof this._debounceTimer.unref === 'function') {
          this._debounceTimer.unref();
        }
      });
      this._watching = true;
      info(`PolicyLoader: hot-reload active on ${this._filePath}`);
    } catch (err) {
      warn(`PolicyLoader: cannot watch ${this._filePath}: ${err.message}`);
    }
  }

  /**
   * Stop watching and tear down the watcher.
   */
  stopWatch() {
    this._shuttingDown = true;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._watching && this._filePath) {
      try { fs.unwatchFile(this._filePath); } catch (_) { /* noop */ }
      this._watching = false;
    }
  }

  /**
   * Get the most recently loaded policy.
   */
  get lastLoaded() {
    return this._lastLoaded;
  }

  /**
   * Get the resolved file path.
   */
  get filePath() {
    return this._filePath;
  }

  // ── Internal ─────────────────────────────────────────────────────

  _reload() {
    if (this._shuttingDown) return;
    const parsed = readPolicyFile(this._filePath);
    if (!parsed) {
      warn('PolicyLoader: reload skipped (parse failed), keeping previous rules');
      return;
    }
    const validated = validatePolicy(parsed, this._defaults);
    for (const w of validated.warnings) {
      warn(`PolicyLoader (reload): ${w}`);
    }
    info(`PolicyLoader: reloaded ${validated.rules.length} rule(s) and ` +
         `${Object.keys(validated.profiles).length} profile(s)`);
    this._lastLoaded = validated;
    this._onReload && this._onReload(validated);
  }
}

module.exports = {
  PolicyLoader,
  resolvePolicyPath,
  readPolicyFile,
  validatePolicy,
  // Exported for testing
  _parseYaml,
};
