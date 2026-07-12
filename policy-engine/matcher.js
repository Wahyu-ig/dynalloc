'use strict';

/**
 * DynAlloc — Policy Engine :: Matcher
 * ===================================
 *
 * Evaluates rule conditions against:
 *   1. The triggering event's payload.
 *   2. The shared StateStore (for fields not present in the payload).
 *
 * Condition schema (JSON):
 *
 *   Simple form (single comparison):
 *     { "<field>": "<op><value>" }
 *     Example: { "battery.capacity": "<20" }
 *     Example: { "wallpaperChanged": true }
 *
 *   Structured form (explicit operator):
 *     { "field": "battery.capacity", "op": "<", "value": 20 }
 *
 *   Compound form (boolean combinators):
 *     { "AND": [ <condition>, <condition>, ... ] }
 *     { "OR":  [ <condition>, <condition>, ... ] }
 *     { "NOT": <condition> }
 *
 * Supported operators (value type in parens):
 *   - "<"  "<="  ">"  ">="  "=="  "!="        (number or string)
 *   - "contains"   (string/array contains substring/element)
 *   - "startsWith" "endsWith"                 (string)
 *   - "matches"    (regex test against string)
 *   - "in"         (value is in a list)
 *   - "exists"     (value is not undefined; payload value true/false toggles)
 *
 * If a field is missing from both the payload and the state store,
 * the comparison evaluates to `false` (safe default — never trigger
 * on unknown state).
 *
 * All evaluation is synchronous and pure. No side effects, no
 * allocations beyond the comparator closures.
 */

const logger = require('../logger');
const { warn } = logger;

/**
 * Parse a "short-form" string like "<20", ">=40", "!=idle" into
 * { op, value }. Returns null if the input is not a short-form string.
 *
 * @param {*} s
 * @returns {{op: string, value: string}|null}
 */
function parseShortForm(s) {
  if (typeof s !== 'string') return null;
  // Match optional operator prefix then the rest as the value
  const m = s.match(/^(<=|>=|==|!=|<|>|contains|startsWith|endsWith|matches|in)\s*(.*)$/);
  if (!m) return null;
  const op = m[1];
  let raw = m[2];
  // Try to coerce to number when it looks numeric
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return { op, value: parseFloat(raw) };
  }
  // Strip surrounding quotes if present
  if (raw.length >= 2 &&
      ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
       (raw[0] === "'" && raw[raw.length - 1] === "'"))) {
    raw = raw.slice(1, -1);
  }
  return { op, value: raw };
}

/**
 * Coerce a value to a number when possible.
 */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return NaN;
}

/**
 * Resolve a field value from the event payload first, then fall back
 * to the StateStore. Returns undefined if neither has the field.
 *
 * Field lookup rules in the payload:
 *   - If field is "foo.bar", walk payload.foo.bar if possible.
 *   - Also accept a flat key "foo.bar" in the payload (producers may
 *     choose either convention).
 *
 * @param {string} field - dot-path
 * @param {object} payload - triggering event payload
 * @param {object} stateStore - StateStore instance
 * @returns {*}
 */
function resolveField(field, payload, stateStore) {
  // 1. Direct flat key on payload
  if (payload && typeof payload === 'object' && field in payload) {
    return payload[field];
  }
  // 2. Walk payload as nested object
  if (payload && typeof payload === 'object') {
    const parts = field.split('.');
    let cursor = payload;
    let found = true;
    for (const part of parts) {
      if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) {
        found = false;
        break;
      }
      cursor = cursor[part];
    }
    if (found) return cursor;
  }
  // 3. Fall back to StateStore
  if (stateStore) {
    return stateStore.get(field);
  }
  return undefined;
}

/**
 * Apply a comparison operator to two values.
 *
 * @param {string} op
 * @param {*} left - actual value
 * @param {*} right - expected value
 * @returns {boolean}
 */
function applyOp(op, left, right) {
  if (left === undefined || left === null) {
    // 'exists' / 'in' / 'contains' have specific semantics for missing left
    if (op === 'exists') return false;
    return false;
  }

  switch (op) {
    case '<':  return toNumber(left) <  toNumber(right);
    case '<=': return toNumber(left) <= toNumber(right);
    case '>':  return toNumber(left) >  toNumber(right);
    case '>=': return toNumber(left) >= toNumber(right);
    case '==': return left === right ||
                       toNumber(left) === toNumber(right);
    case '!=': return left !== right &&
                       !(toNumber(left) === toNumber(right) && !Number.isNaN(toNumber(left)));
    case 'contains': {
      if (Array.isArray(left)) return left.includes(right);
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      return false;
    }
    case 'startsWith':
      return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
    case 'endsWith':
      return typeof left === 'string' && typeof right === 'string' && left.endsWith(right);
    case 'matches': {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      try { return new RegExp(right).test(left); } catch (_) { return false; }
    }
    case 'in': {
      if (!Array.isArray(right)) return false;
      return right.includes(left);
    }
    case 'exists':
      // `exists: true` (default) → field has a value
      // `exists: false` → field does NOT have a value (negation)
      return right === false ? left === undefined : left !== undefined;
    default:
      warn(`Matcher: unknown operator "${op}"`);
      return false;
  }
}

/**
 * Evaluate a single-leaf condition object.
 *
 * Accepted shapes:
 *   { "<field>": "<op> <value>" }            // short form
 *   { "<field>": <plainValue> }              // implicit "=="
 *   { "field": "...", "op": "...", "value": ... }   // explicit form
 *
 * @param {object} cond
 * @param {object} payload
 * @param {object} stateStore
 * @returns {boolean}
 */
function evalLeaf(cond, payload, stateStore) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;

  // Explicit form
  if ('field' in cond && 'op' in cond) {
    const left = resolveField(cond.field, payload, stateStore);
    return applyOp(cond.op, left, cond.value);
  }

  const keys = Object.keys(cond);
  if (keys.length === 0) return true; // empty leaf = trivially true

  // Treat each key as a separate leaf and AND them. This lets users
  // write compact rules like { "app": "steam", "battery": ">40" }.
  for (const key of keys) {
    const val = cond[key];
    let op = '==';
    let expected = val;

    if (typeof val === 'string') {
      const short = parseShortForm(val);
      if (short) {
        op = short.op;
        expected = short.value;
      } else if (val === 'true') {
        expected = true;
      } else if (val === 'false') {
        expected = false;
      }
    }

    const left = resolveField(key, payload, stateStore);
    if (!applyOp(op, left, expected)) return false;
  }
  return true;
}

/**
 * Recursively evaluate a (possibly compound) condition.
 *
 * Compound shapes:
 *   { "AND": [cond, cond, ...] }
 *   { "OR":  [cond, cond, ...] }
 *   { "NOT": cond }
 *
 * A condition that is neither compound nor a leaf is treated as
 * truthy if it is truthy in JS semantics (rare — usually a bug).
 *
 * @param {object} cond
 * @param {object} payload
 * @param {object} stateStore
 * @returns {boolean}
 */
function evaluate(cond, payload, stateStore) {
  if (cond === null || cond === undefined) return true;
  if (typeof cond !== 'object') return !!cond;
  if (Array.isArray(cond)) return cond.length > 0; // weak default

  if ('AND' in cond) {
    const arr = cond.AND;
    if (!Array.isArray(arr)) return false;
    for (const c of arr) {
      if (!evaluate(c, payload, stateStore)) return false;
    }
    return true;
  }
  if ('OR' in cond) {
    const arr = cond.OR;
    if (!Array.isArray(arr)) return false;
    for (const c of arr) {
      if (evaluate(c, payload, stateStore)) return true;
    }
    return false;
  }
  if ('NOT' in cond) {
    return !evaluate(cond.NOT, payload, stateStore);
  }

  return evalLeaf(cond, payload, stateStore);
}

module.exports = {
  evaluate,
  evalLeaf,
  applyOp,
  resolveField,
  parseShortForm,
  toNumber,
};
