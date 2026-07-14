'use strict';

/**
 * DynAlloc — Profile Layer :: Public API
 * ========================================
 *
 * Single import surface for the rest of the daemon. Mirrors
 * `detectors/index.js` and `policy-engine/index.js`.
 *
 * Usage:
 *
 *   const { ProfileManager } = require('./profiles');
 *   const mgr = new ProfileManager({ config, bus, rcm, metrics });
 *   mgr.setup();
 *   mgr.start();
 *   // ... events flow, profiles activate/deactivate automatically ...
 *   mgr.destroy();
 *
 * For daemon integration, see `daemon.js` — the ProfileManager is
 * constructed only when ENABLE_PROFILE_MANAGER is true.
 */

const Profile = require('./base-profile');
const ProfileRegistry = require('./profile-registry');
const ProfileManager = require('./profile-manager');
const { createBuiltinProfiles, BUILTIN_DEFINITIONS } = require('./builtin-profiles');

module.exports = {
  Profile,
  ProfileRegistry,
  ProfileManager,
  createBuiltinProfiles,
  BUILTIN_DEFINITIONS,
};
