'use strict';

/**
 * DynAlloc — Profile Layer :: Profile Registry
 * =============================================
 *
 * Loads, validates, and stores Profile instances. Handles:
 *
 *   - Loading from JSON/YAML files (reuses policy-loader's YAML parser)
 *   - Loading from plain JS objects (for built-in profiles)
 *   - Detecting duplicate IDs (same version → reject; different version → replace)
 *   - Detecting circular inheritance (reject)
 *   - Resolving inheritance (deep-merge parent settings)
 *   - Applying overrides (per-domain override of resolved settings)
 *   - Hot-reload (re-read file on change)
 *
 * The registry NEVER applies profiles — it only stores and resolves
 * them. The ProfileManager is responsible for activation.
 *
 * Validation rules (per Phase 3 spec):
 *
 *   - Invalid values       → reject with error, never crash
 *   - Duplicate IDs        → reject same-version, replace different-version
 *   - Circular inheritance → reject
 *   - Invalid priorities   → reject (must be integer 0-1000)
 *   - Missing required fields → reject (id, version required)
 *
 * Backward compatibility: only constructed when ENABLE_PROFILE_MANAGER
 * is true.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { info, warn, debug } = logger;
const Profile = require('./base-profile');

// Reuse the policy-loader's YAML parser to avoid duplication.
const { _parseYaml } = require('../policy-engine/policy-loader');

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Deep merge two objects. `b` wins over `a`. Arrays are replaced
 * (not concatenated). Used for inheritance resolution.
 */
function _deepMerge(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (typeof a !== 'object' || typeof b !== 'object') return b;
  if (Array.isArray(a) || Array.isArray(b)) return b;
  const out = { ...a };
  for (const key of Object.keys(b)) {
    if (key in out) {
      out[key] = _deepMerge(out[key], b[key]);
    } else {
      out[key] = b[key];
    }
  }
  return out;
}

// ── ProfileRegistry class ────────────────────────────────────────────

class ProfileRegistry {
  constructor() {
    this._profiles = new Map();    // id → Profile
    this._registrationOrder = [];  // array of IDs in registration order
    this._fileWatcher = null;
    this._filePath = null;
    this._onReload = null;
  }

  /**
   * Register a profile from a raw definition object.
   * Validates, resolves inheritance, and stores.
   *
   * @param {object} def - raw profile definition
   * @returns {{ success: boolean, error: string|null, profile: Profile|null }}
   */
  register(def) {
    let profile;
    try {
      profile = new Profile(def);
    } catch (err) {
      return { success: false, error: err.message, profile: null };
    }

    // Check for duplicate ID + version
    const existing = this._profiles.get(profile.id);
    if (existing) {
      if (existing.version === profile.version) {
        return {
          success: false,
          error: `duplicate profile id "${profile.id}" version "${profile.version}"`,
          profile: null,
        };
      }
      warn(`ProfileRegistry: replacing "${profile.id}" v${existing.version} with v${profile.version}`);
    }

    // Store (resolve inheritance lazily — after all profiles registered,
    // or immediately if parents are already present)
    this._profiles.set(profile.id, profile);
    if (!existing) {
      this._registrationOrder.push(profile.id);
    }

    debug(`Profile registered: ${profile.id} v${profile.version} (priority=${profile.priority})`);
    return { success: true, error: null, profile };
  }

  /**
   * Register multiple profile definitions at once.
   * After all are registered, resolve inheritance for all of them.
   *
   * @param {Array<object>} defs
   * @returns {{ registered: number, errors: Array<{def, error}> }}
   */
  registerAll(defs) {
    if (!Array.isArray(defs)) {
      return { registered: 0, errors: [{ def: defs, error: 'expected an array' }] };
    }
    const errors = [];
    let registered = 0;
    for (const def of defs) {
      const result = this.register(def);
      if (result.success) {
        registered++;
      } else {
        errors.push({ def, error: result.error });
        warn(`ProfileRegistry: rejected profile: ${result.error}`);
      }
    }
    // Resolve inheritance for all profiles now that all are registered.
    this._resolveAllInheritance();
    return { registered, errors };
  }

  /**
   * Unregister a profile by ID.
   */
  unregister(id) {
    if (!this._profiles.has(id)) return false;
    this._profiles.delete(id);
    this._registrationOrder = this._registrationOrder.filter((x) => x !== id);
    return true;
  }

  /**
   * Get a profile by ID.
   * @returns {Profile|undefined}
   */
  get(id) {
    return this._profiles.get(id);
  }

  /**
   * Get all registered profile IDs (in registration order).
   */
  get ids() {
    return [...this._registrationOrder];
  }

  /**
   * Get all registered profiles (in registration order).
   */
  get all() {
    return this._registrationOrder.map((id) => this._profiles.get(id));
  }

  get size() {
    return this._profiles.size;
  }

  /**
   * Clear all profiles.
   */
  clear() {
    this._profiles.clear();
    this._registrationOrder = [];
  }

  // ── File loading ──────────────────────────────────────────────────

  /**
   * Load profiles from a JSON or YAML file.
   *
   * File format:
   *   { "profiles": [ {def1}, {def2}, ... ] }
   * or simply:
   *   [ {def1}, {def2}, ... ]
   *
   * @param {string} filePath
   * @param {Function} [onReload] - callback() called on hot-reload
   * @returns {{ success: boolean, error: string|null, loaded: number }}
   */
  loadFile(filePath, onReload) {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'filePath required', loaded: 0 };
    }
    // Path traversal protection
    if (filePath.includes('\0') || filePath.includes('..')) {
      return { success: false, error: 'invalid path', loaded: 0 };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `file not found: ${filePath}`, loaded: 0 };
    }

    this._filePath = filePath;
    this._onReload = typeof onReload === 'function' ? onReload : null;

    const result = this._readAndParse(filePath);
    if (!result.success) {
      return result;
    }

    const defs = this._extractDefs(result.parsed);
    const regResult = this.registerAll(defs);
    info(`ProfileRegistry: loaded ${regResult.registered} profile(s) from ${filePath}`);
    if (regResult.errors.length > 0) {
      warn(`ProfileRegistry: ${regResult.errors.length} profile(s) rejected during load`);
    }
    return { success: true, error: null, loaded: regResult.registered };
  }

  /**
   * Start watching the file for hot-reload.
   */
  startWatch() {
    if (!this._filePath) return;
    try {
      this._fileWatcher = fs.watchFile(this._filePath, { persistent: false, interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        debug(`ProfileRegistry: file changed, reloading: ${this._filePath}`);
        // Re-load: clear + re-register
        this.clear();
        const result = this._readAndParse(this._filePath);
        if (!result.success) {
          warn(`ProfileRegistry: reload failed: ${result.error}`);
          return;
        }
        const defs = this._extractDefs(result.parsed);
        const regResult = this.registerAll(defs);
        info(`ProfileRegistry: reloaded ${regResult.registered} profile(s)`);
        if (this._onReload) {
          try { this._onReload(); } catch (_) { /* callback failure is non-fatal */ }
        }
      });
    } catch (err) {
      warn(`ProfileRegistry: cannot watch ${this._filePath}: ${err.message}`);
    }
  }

  stopWatch() {
    if (this._fileWatcher && this._filePath) {
      try { fs.unwatchFile(this._filePath); } catch (_) { /* noop */ }
      this._fileWatcher = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  _readAndParse(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return { success: false, error: `cannot read: ${err.message}`, parsed: null };
    }
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.json') {
        return { success: true, error: null, parsed: JSON.parse(raw) };
      }
      if (ext === '.yaml' || ext === '.yml') {
        return { success: true, error: null, parsed: _parseYaml(raw) };
      }
      // Unknown extension — try JSON first, then YAML
      try {
        return { success: true, error: null, parsed: JSON.parse(raw) };
      } catch (_) {
        return { success: true, error: null, parsed: _parseYaml(raw) };
      }
    } catch (err) {
      return { success: false, error: `parse error: ${err.message}`, parsed: null };
    }
  }

  _extractDefs(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.profiles)) return parsed.profiles;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  }

  /**
   * Resolve inheritance for all registered profiles. Detects circular
   * inheritance and warns (skipping resolution for the offending profile).
   */
  _resolveAllInheritance() {
    for (const profile of this._profiles.values()) {
      try {
        const resolved = this._resolveInheritance(profile, new Set());
        profile.setResolvedSettings(resolved);
      } catch (err) {
        warn(`ProfileRegistry: inheritance resolution failed for "${profile.id}": ${err.message}`);
        // Fall back to raw settings
        profile.setResolvedSettings(profile.settings);
      }
    }
  }

  /**
   * Recursively resolve inheritance for a profile.
   * @param {Profile} profile
   * @param {Set<string>} visited - IDs already in the resolution chain (for cycle detection)
   * @returns {object} resolved settings
   */
  _resolveInheritance(profile, visited) {
    if (visited.has(profile.id)) {
      throw new Error(`circular inheritance detected: ${[...visited, profile.id].join(' → ')}`);
    }
    visited.add(profile.id);

    let merged = {};
    for (const parentId of profile.inherits) {
      const parent = this._profiles.get(parentId);
      if (!parent) {
        warn(`ProfileRegistry: "${profile.id}" inherits unknown parent "${parentId}" — skipping`);
        continue;
      }
      const parentSettings = this._resolveInheritance(parent, visited);
      merged = _deepMerge(merged, parentSettings);
    }
    // Apply this profile's own settings on top
    merged = _deepMerge(merged, profile.settings || {});
    // Apply overrides (overrides take precedence over everything)
    if (profile.overrides && Object.keys(profile.overrides).length > 0) {
      merged = _deepMerge(merged, profile.overrides);
    }
    return merged;
  }
}

module.exports = ProfileRegistry;
module.exports._deepMerge = _deepMerge;
