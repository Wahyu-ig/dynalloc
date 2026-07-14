'use strict';

/**
 * DynAlloc — Policy Engine :: State Store
 * =======================================
 *
 * A small in-memory key/value store that caches the "current state" of
 * the system as observed by event sources. The Rule Engine queries
 * this store when evaluating rule conditions that reference fields the
 * triggering event does not carry.
 *
 * Example:
 *   A rule "if battery < 20 then powersave" might be triggered by an
 *   onForegroundChanged event, which carries no battery information.
 *   The matcher reads `stateStore.get('battery.capacity')` instead.
 *
 * The store is intentionally dumb:
 *   - Synchronous get/set/has/delete.
 *   - Dot-paths are supported: `set('battery.capacity', 75)` and
 *     `get('battery.capacity')` walk a nested object.
 *   - No persistence, no schema, no validation. Producers are trusted.
 *   - Bounded: a configurable max number of top-level keys (default
 *     256) prevents unbounded growth from buggy producers.
 *
 * Backward compatibility: only loaded when ENABLE_POLICY_ENGINE is on.
 */

const logger = require('../logger');
const { warn, debug } = logger;

const DEFAULT_MAX_KEYS = 256;

class StateStore {
  constructor(maxKeys = DEFAULT_MAX_KEYS) {
    this._root = {};
    this._maxKeys = Math.max(8, maxKeys);
    this._topLevelCount = 0;
  }

  /**
   * Store a value at a dot-path.
   *
   * @param {string} key - dot-separated path, e.g. "battery.capacity"
   * @param {*} value - any JSON-serializable value
   */
  set(key, value) {
    if (typeof key !== 'string' || key.length === 0) return;
    const parts = key.split('.');
    if (parts.length === 1) {
      if (!(key in this._root)) {
        if (this._topLevelCount >= this._maxKeys) {
          warn(`StateStore: maxKeys (${this._maxKeys}) exceeded, ignoring "${key}"`);
          return;
        }
        this._topLevelCount++;
      }
      this._root[key] = value;
      return;
    }

    const top = parts[0];
    if (!(top in this._root)) {
      if (this._topLevelCount >= this._maxKeys) {
        warn(`StateStore: maxKeys (${this._maxKeys}) exceeded, ignoring "${key}"`);
        return;
      }
      this._root[top] = {};
      this._topLevelCount++;
    }
    if (typeof this._root[top] !== 'object' || this._root[top] === null) {
      // Overwrite a non-object top-level with an object so we can nest
      this._root[top] = {};
    }
    let cursor = this._root[top];
    for (let i = 1; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof cursor[part] !== 'object' || cursor[part] === null) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  /**
   * Read a value at a dot-path. Returns `defaultValue` if any segment
   * is missing or if the path traverses a non-object.
   *
   * @param {string} key
   * @param {*} [defaultValue=undefined]
   * @returns {*}
   */
  get(key, defaultValue = undefined) {
    if (typeof key !== 'string' || key.length === 0) return defaultValue;
    const parts = key.split('.');
    let cursor = this._root;
    for (const part of parts) {
      if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) {
        return defaultValue;
      }
      cursor = cursor[part];
    }
    return cursor === undefined ? defaultValue : cursor;
  }

  /**
   * Check whether a value exists at the given path.
   */
  has(key) {
    return this.get(key, undefined) !== undefined;
  }

  /**
   * Delete a value at a dot-path. Cleans up empty parent objects.
   */
  delete(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    const parts = key.split('.');
    if (parts.length === 1) {
      if (key in this._root) {
        delete this._root[key];
        this._topLevelCount--;
        return true;
      }
      return false;
    }
    // Walk to parent, then delete leaf
    let cursor = this._root;
    const stack = [cursor];
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) {
        return false;
      }
      cursor = cursor[part];
      stack.push(cursor);
    }
    const leaf = parts[parts.length - 1];
    if (typeof cursor !== 'object' || cursor === null || !(leaf in cursor)) {
      return false;
    }
    delete cursor[leaf];
    // Clean up empty parent objects, walking up the stack.
    // stack[i] is the object at depth i; parts[i] is the key that
    // points from stack[i] to stack[i+1]. So to clean up stack[i+1]
    // (which is now potentially empty), we delete parts[i] from
    // stack[i].
    for (let i = stack.length - 2; i >= 0; i--) {
      const parent = stack[i];
      const childKey = parts[i];
      const child = parent[childKey];
      if (child && typeof child === 'object' && !Array.isArray(child) &&
          Object.keys(child).length === 0) {
        delete parent[childKey];
        // If we just deleted a top-level key, decrement the counter
        if (i === 0) this._topLevelCount--;
      } else {
        break;
      }
    }
    return true;
  }

  /**
   * Replace the entire state with a snapshot. Useful for tests and
   * for restoring from a checkpoint.
   */
  replaceAll(obj) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      this._root = obj;
      this._topLevelCount = Object.keys(obj).length;
    }
  }

  /**
   * Return a shallow snapshot of the root state. Mutations to the
   * returned object do not affect the store.
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this._root));
  }

  /**
   * Clear all state.
   */
  clear() {
    this._root = {};
    this._topLevelCount = 0;
  }

  get size() {
    return this._topLevelCount;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance = null;

/**
 * Get the shared StateStore singleton.
 *
 * @param {number} [maxKeys] - only applied on first creation
 * @returns {StateStore}
 */
function getStateStore(maxKeys) {
  if (!_instance) {
    _instance = new StateStore(maxKeys);
  }
  return _instance;
}

/**
 * Reset the singleton (clears all state and recreates the store).
 * Used by tests and on daemon shutdown.
 */
function resetStateStore() {
  if (_instance) {
    _instance.clear();
  }
  _instance = null;
}

module.exports = {
  StateStore,
  getStateStore,
  resetStateStore,
  DEFAULT_MAX_KEYS,
};
