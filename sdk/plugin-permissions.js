'use strict';

/**
 * DynAlloc — Plugin SDK :: Permissions
 * =====================================
 *
 * Defines the permission model for third-party plugins. Plugins
 * must declare required permissions in their manifest; the
 * PluginContext enforces them at every API call.
 *
 * Permissions are additive — a plugin can request any subset. The
 * daemon administrator can override (grant/deny) via config, but
 * by default, only manifest-declared permissions are granted.
 *
 * Permission categories:
 *
 *   read:config       — read daemon configuration
 *   read:metrics      — read metrics snapshots
 *   read:diagnostics  — read diagnostics reports
 *   read:health       — read health check results
 *   read:state        — read daemon state (getState)
 *
 *   write:profiles    — register/demand profiles
 *   write:detectors   — register detectors
 *   write:controllers — register resource controllers
 *   write:rules       — register recognition rules
 *   write:events      — publish events on the bus
 *
 *   cli:register      — register CLI commands
 *   log:write         — write to daemon log
 *
 *   system:full       — full access (all permissions, use sparingly)
 *
 * Backward compatibility: only used when ENABLE_PLUGIN_SDK is true.
 */

const ALL_PERMISSIONS = Object.freeze([
  'read:config',
  'read:metrics',
  'read:diagnostics',
  'read:health',
  'read:state',
  'write:profiles',
  'write:detectors',
  'write:controllers',
  'write:rules',
  'write:events',
  'cli:register',
  'log:write',
  'system:full',
]);

const PERMISSION_DESCRIPTIONS = Object.freeze({
  'read:config':       'Read daemon configuration',
  'read:metrics':      'Read metrics snapshots',
  'read:diagnostics':  'Read diagnostics reports',
  'read:health':       'Read health check results',
  'read:state':        'Read daemon state',
  'write:profiles':    'Register and demand profiles',
  'write:detectors':   'Register detectors',
  'write:controllers': 'Register resource controllers',
  'write:rules':       'Register recognition rules',
  'write:events':      'Publish events on the bus',
  'cli:register':      'Register CLI commands',
  'log:write':         'Write to daemon log',
  'system:full':       'Full access (all permissions)',
});

/**
 * Validate a list of permission strings.
 * @param {string[]} perms
 * @returns {{ valid: boolean, invalid: string[] }}
 */
function validatePermissions(perms) {
  if (!Array.isArray(perms)) {
    return { valid: false, invalid: ['permissions must be an array'] };
  }
  const invalid = [];
  for (const p of perms) {
    if (typeof p !== 'string' || !ALL_PERMISSIONS.includes(p)) {
      invalid.push(p);
    }
  }
  return { valid: invalid.length === 0, invalid };
}

/**
 * Check if a granted set includes a required permission.
 * 'system:full' grants everything.
 * @param {Set<string>} granted
 * @param {string} required
 * @returns {boolean}
 */
function hasPermission(granted, required) {
  if (!granted || !(granted instanceof Set)) return false;
  if (granted.has('system:full')) return true;
  return granted.has(required);
}

/**
 * Resolve the effective permission set from manifest + config overrides.
 * @param {string[]} manifestPerms - permissions declared in manifest
 * @param {object} [overrides] - { grant: string[], deny: string[] }
 * @returns {Set<string>}
 */
function resolvePermissions(manifestPerms, overrides) {
  const set = new Set();

  // Start with manifest-declared permissions
  for (const p of (manifestPerms || [])) {
    if (ALL_PERMISSIONS.includes(p)) set.add(p);
  }

  // Apply config overrides
  if (overrides) {
    // Grant additional permissions
    for (const p of (overrides.grant || [])) {
      if (ALL_PERMISSIONS.includes(p)) set.add(p);
    }
    // Deny permissions (remove from set)
    for (const p of (overrides.deny || [])) {
      set.delete(p);
    }
  }

  return set;
}

module.exports = {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  validatePermissions,
  hasPermission,
  resolvePermissions,
};
