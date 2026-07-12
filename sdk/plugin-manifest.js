'use strict';

/**
 * DynAlloc — Plugin SDK :: Manifest
 * ===================================
 *
 * Defines the plugin manifest specification and validation.
 *
 * Manifest shape (JSON):
 *
 *   {
 *     "id": "com.example.my-plugin",     // unique, reverse-DNS
 *     "name": "My Plugin",               // human-readable
 *     "version": "1.0.0",                // semver
 *     "author": "Jane Doe",
 *     "description": "Does something cool",
 *     "minDynallocVersion": "0.5.0",     // minimum daemon version
 *     "maxDynallocVersion": "1.0.0",     // maximum supported (optional)
 *     "apiVersion": "1.0",               // SDK API version
 *     "permissions": ["read:config", "write:events"],
 *     "dependencies": [                  // other plugin IDs required
 *       "com.example.other-plugin"
 *     ],
 *     "entryPoint": "./index.js",        // relative to plugin dir
 *   }
 *
 * Validation rules:
 *   - id: required, must match ^[a-z0-9][a-z0-9.-]*$ (reverse-DNS style)
 *   - name: required, non-empty string
 *   - version: required, must be semver X.Y.Z
 *   - author: optional string
 *   - description: optional string
 *   - minDynallocVersion: required, semver
 *   - maxDynallocVersion: optional, semver
 *   - apiVersion: required, must match ^\d+\.\d+$
 *   - permissions: optional, array of valid permission strings
 *   - dependencies: optional, array of valid plugin IDs
 *   - entryPoint: required, non-empty string (relative path)
 *
 * Backward compatibility: only used when ENABLE_PLUGIN_SDK is true.
 */

const { validatePermissions } = require('./plugin-permissions');

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const API_VERSION_RE = /^\d+\.\d+$/;

/**
 * Validate a manifest object.
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  // id
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) {
    errors.push('id: must be a reverse-DNS style string (e.g. "com.example.my-plugin")');
  }

  // name
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    errors.push('name: must be a non-empty string');
  }

  // version
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    errors.push('version: must be semver X.Y.Z');
  }

  // author
  if (manifest.author !== undefined && typeof manifest.author !== 'string') {
    errors.push('author: must be a string if present');
  }

  // description
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    errors.push('description: must be a string if present');
  }

  // minDynallocVersion
  if (typeof manifest.minDynallocVersion !== 'string' || !SEMVER_RE.test(manifest.minDynallocVersion)) {
    errors.push('minDynallocVersion: must be semver X.Y.Z');
  }

  // maxDynallocVersion (optional)
  if (manifest.maxDynallocVersion !== undefined) {
    if (typeof manifest.maxDynallocVersion !== 'string' || !SEMVER_RE.test(manifest.maxDynallocVersion)) {
      errors.push('maxDynallocVersion: must be semver X.Y.Z if present');
    }
  }

  // apiVersion
  if (typeof manifest.apiVersion !== 'string' || !API_VERSION_RE.test(manifest.apiVersion)) {
    errors.push('apiVersion: must be X.Y format (e.g. "1.0")');
  }

  // permissions (optional)
  if (manifest.permissions !== undefined) {
    const permResult = validatePermissions(manifest.permissions);
    if (!permResult.valid) {
      errors.push(`permissions: invalid permissions: ${permResult.invalid.join(', ')}`);
    }
  }

  // dependencies (optional)
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      errors.push('dependencies: must be an array if present');
    } else {
      for (const dep of manifest.dependencies) {
        if (typeof dep !== 'string' || !ID_RE.test(dep)) {
          errors.push(`dependencies: invalid dependency ID "${dep}"`);
        }
      }
    }
  }

  // entryPoint
  if (typeof manifest.entryPoint !== 'string' || manifest.entryPoint.length === 0) {
    errors.push('entryPoint: must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a Manifest object from raw JSON.
 * @param {object} raw
 * @returns {{ success: boolean, manifest: Manifest|null, errors: string[] }}
 */
function createManifest(raw) {
  const result = validateManifest(raw);
  if (!result.valid) {
    return { success: false, manifest: null, errors: result.errors };
  }
  const manifest = Object.freeze({ ...raw });
  return { success: true, manifest, errors: [] };
}

module.exports = {
  validateManifest,
  createManifest,
  ID_RE,
  SEMVER_RE,
  API_VERSION_RE,
};
