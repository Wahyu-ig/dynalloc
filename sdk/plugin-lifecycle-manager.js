'use strict';

/**
 * DynAlloc — Plugin SDK :: Plugin Lifecycle Manager
 * ===================================================
 *
 * Manages the complete lifecycle of all SDK plugins:
 *
 *   Initialize → Validate → Load → Register → Activate →
 *   Runtime → Deactivate → Unload → Cleanup
 *
 * Error isolation:
 *   - Every plugin call is wrapped in try/catch
 *   - A failing plugin is disabled, not killed
 *   - The daemon continues running regardless of plugin failures
 *   - Failed plugins are logged + reported to diagnostics
 *
 * Dependency management:
 *   - Plugins can declare dependencies on other plugins
 *   - The manager loads dependencies first
 *   - Unresolvable dependencies → plugin rejected
 *
 * Permission enforcement:
 *   - The manager creates a PluginContext for each plugin
 *   - The context enforces permissions at every API call
 *   - Strict mode (PLUGIN_SDK_STRICT_PERMISSIONS) rejects plugins
 *     that request unknown permissions
 *
 * Version compatibility:
 *   - Plugin's apiVersion is checked against the daemon's SDK API version
 *   - Plugin's minDynallocVersion is checked against the daemon version
 *   - Incompatible plugins are rejected
 *
 * Backward compatibility: only constructed when ENABLE_PLUGIN_SDK is true.
 * The existing plugin-manager.js continues to work independently.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { info, warn, debug } = logger;
const { validateManifest } = require('./plugin-manifest');
const { checkApiCompatibility, checkDaemonCompatibility } = require('./plugin-version');
const { validatePermissions, resolvePermissions } = require('./plugin-permissions');
const PluginContext = require('./plugin-context');

// ── Plugin states ────────────────────────────────────────────────────

const STATE = Object.freeze({
  INITIALIZED: 'initialized',
  VALIDATED: 'validated',
  LOADED: 'loaded',
  REGISTERED: 'registered',
  ACTIVATED: 'activated',
  DEACTIVATED: 'deactivated',
  UNLOADED: 'unloaded',
  ERROR: 'error',
  DISABLED: 'disabled',
});

// ── PluginLifecycleManager class ─────────────────────────────────────

class PluginLifecycleManager {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {string} opts.apiVersion  - SDK API version (e.g. "1.0")
   * @param {string} opts.daemonVersion - daemon version (e.g. "0.5.0")
   * @param {object} opts.providers   - { getConfig, getState, ... }
   * @param {object} [opts.diagnostics] - DiagnosticsEngine for reporting
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('PluginLifecycleManager: opts.config is required');
    }
    this._config = opts.config;
    this._apiVersion = opts.apiVersion || '1.0';
    this._daemonVersion = opts.daemonVersion || '0.5.0';
    this._providers = opts.providers || {};
    this._diagnostics = opts.diagnostics || null;
    this._strict = !!opts.config.PLUGIN_SDK_STRICT_PERMISSIONS;

    this._plugins = new Map();      // id → { manifest, context, module, state, error }
    this._loadOrder = [];           // ids in load order
    this._errorCount = 0;
    this._disabledCount = 0;
  }

  /**
   * Load a plugin from a directory containing a manifest.json + entry point.
   * @param {string} pluginDir
   * @returns {{ success: boolean, error: string|null, id: string|null }}
   */
  loadFromDirectory(pluginDir) {
    if (!pluginDir || typeof pluginDir !== 'string') {
      return { success: false, error: 'pluginDir required', id: null };
    }
    // Path traversal protection
    if (pluginDir.includes('\0') || pluginDir.includes('..')) {
      return { success: false, error: 'invalid path', id: null };
    }
    const manifestPath = path.join(pluginDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: `manifest.json not found in ${pluginDir}`, id: null };
    }

    let rawManifest;
    try {
      rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      return { success: false, error: `manifest parse error: ${err.message}`, id: null };
    }

    return this.loadPlugin(rawManifest, pluginDir);
  }

  /**
   * Load a plugin from a manifest + directory.
   * @param {object} rawManifest
   * @param {string} pluginDir
   * @returns {{ success: boolean, error: string|null, id: string|null }}
   */
  loadPlugin(rawManifest, pluginDir) {
    // 1. Validate manifest
    const validation = validateManifest(rawManifest);
    if (!validation.valid) {
      const err = `manifest validation failed: ${validation.errors.join('; ')}`;
      this._recordError(rawManifest.id || 'unknown', err);
      return { success: false, error: err, id: rawManifest.id || null };
    }

    const manifest = rawManifest;
    const id = manifest.id;

    // 2. Check for duplicate
    if (this._plugins.has(id)) {
      const err = `plugin "${id}" already loaded`;
      return { success: false, error: err, id };
    }

    // 3. Check API version compatibility
    const apiCheck = checkApiCompatibility(manifest.apiVersion, this._apiVersion);
    if (!apiCheck.compatible) {
      const err = `API version incompatible: ${apiCheck.reason}`;
      this._recordError(id, err);
      return { success: false, error: err, id };
    }

    // 4. Check daemon version compatibility
    const daemonCheck = checkDaemonCompatibility(
      this._daemonVersion,
      manifest.minDynallocVersion,
      manifest.maxDynallocVersion
    );
    if (!daemonCheck.compatible) {
      const err = `daemon version incompatible: ${daemonCheck.reason}`;
      this._recordError(id, err);
      return { success: false, error: err, id };
    }

    // 5. Check permissions (strict mode rejects unknown permissions)
    if (this._strict) {
      const permCheck = validatePermissions(manifest.permissions || []);
      if (!permCheck.valid) {
        const err = `invalid permissions: ${permCheck.invalid.join(', ')}`;
        this._recordError(id, err);
        return { success: false, error: err, id };
      }
    }

    // 6. Check dependencies
    for (const depId of (manifest.dependencies || [])) {
      if (!this._plugins.has(depId)) {
        const err = `unresolved dependency: "${depId}"`;
        this._recordError(id, err);
        return { success: false, error: err, id };
      }
    }

    // 7. Resolve permissions
    const permissions = resolvePermissions(manifest.permissions || []);

    // 8. Create PluginContext
    const context = new PluginContext({
      manifest,
      permissions,
      providers: this._providers,
      apiVersion: this._apiVersion,
      daemonVersion: this._daemonVersion,
    });

    // 9. Load the entry point module
    let pluginModule = null;
    if (pluginDir) {
      const entryPath = path.resolve(pluginDir, manifest.entryPoint);
      try {
        pluginModule = require(entryPath);
      } catch (err) {
        const e = `failed to load entry point: ${err.message}`;
        this._recordError(id, e);
        return { success: false, error: e, id };
      }
    }

    // 10. Register
    const entry = {
      manifest,
      context,
      module: pluginModule,
      state: STATE.LOADED,
      error: null,
      loadedAt: Date.now(),
    };
    this._plugins.set(id, entry);
    this._loadOrder.push(id);

    // 11. Activate (call module.activate if it exists)
    this._activate(id);

    info(`Plugin SDK: loaded "${id}" v${manifest.version} (API ${manifest.apiVersion})`);
    return { success: true, error: null, id };
  }

  /**
   * Unload a plugin by ID.
   * @param {string} id
   * @returns {boolean}
   */
  unloadPlugin(id) {
    const entry = this._plugins.get(id);
    if (!entry) return false;

    // Deactivate first
    this._deactivate(id);

    // Disable context
    entry.context.disable();

    // Cleanup module
    if (entry.module && typeof entry.module.cleanup === 'function') {
      try { entry.module.cleanup(entry.context); } catch (err) {
        warn(`Plugin "${id}" cleanup error: ${err.message}`);
      }
    }

    entry.state = STATE.UNLOADED;
    this._plugins.delete(id);
    this._loadOrder = this._loadOrder.filter((x) => x !== id);
    debug(`Plugin SDK: unloaded "${id}"`);
    return true;
  }

  /**
   * Disable a plugin (after crash/error). The plugin stays loaded
   * but its context is disabled — all API calls become no-ops.
   * @param {string} id
   * @param {string} reason
   */
  disablePlugin(id, reason) {
    const entry = this._plugins.get(id);
    if (!entry) return;
    entry.context.disable();
    entry.state = STATE.DISABLED;
    entry.error = reason;
    this._disabledCount++;
    warn(`Plugin SDK: disabled "${id}" — ${reason}`);
    this._recordError(id, `disabled: ${reason}`);
  }

  /**
   * Get a plugin context by ID.
   * @param {string} id
   * @returns {PluginContext|undefined}
   */
  getContext(id) {
    const entry = this._plugins.get(id);
    return entry ? entry.context : undefined;
  }

  /**
   * Get list of loaded plugin IDs.
   */
  get loadedPlugins() {
    return [...this._loadOrder];
  }

  get size() {
    return this._plugins.size;
  }

  get errorCount() {
    return this._errorCount;
  }

  get disabledCount() {
    return this._disabledCount;
  }

  getStatus() {
    const plugins = [];
    for (const [id, entry] of this._plugins) {
      plugins.push({
        id,
        version: entry.manifest.version,
        apiVersion: entry.manifest.apiVersion,
        state: entry.state,
        permissions: Array.from(entry.context.permissions),
        error: entry.error,
        loadedAt: new Date(entry.loadedAt).toISOString(),
      });
    }
    return {
      apiVersion: this._apiVersion,
      daemonVersion: this._daemonVersion,
      pluginCount: this._plugins.size,
      errorCount: this._errorCount,
      disabledCount: this._disabledCount,
      strict: this._strict,
      plugins,
    };
  }

  /**
   * Destroy all plugins and clean up.
   */
  destroy() {
    for (const id of [...this._loadOrder].reverse()) {
      this.unloadPlugin(id);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  _activate(id) {
    const entry = this._plugins.get(id);
    if (!entry || !entry.module) return;

    try {
      // Call module.activate(context) if it exists
      if (typeof entry.module.activate === 'function') {
        const result = entry.module.activate(entry.context);
        if (result === false) {
          // Plugin vetoed activation
          warn(`Plugin "${id}" vetoed activation`);
          entry.state = STATE.DEACTIVATED;
          return;
        }
      }
      // Call module.init(context) if it exists (older convention)
      if (typeof entry.module.init === 'function' && typeof entry.module.activate !== 'function') {
        entry.module.init(entry.context);
      }
      entry.state = STATE.ACTIVATED;
    } catch (err) {
      this.disablePlugin(id, `activation error: ${err.message}`);
    }
  }

  _deactivate(id) {
    const entry = this._plugins.get(id);
    if (!entry || !entry.module) return;

    try {
      if (typeof entry.module.deactivate === 'function') {
        entry.module.deactivate(entry.context);
      } else if (typeof entry.module.destroy === 'function') {
        entry.module.destroy();
      }
      entry.state = STATE.DEACTIVATED;
    } catch (err) {
      warn(`Plugin "${id}" deactivation error: ${err.message}`);
    }
  }

  _recordError(pluginId, message) {
    this._errorCount++;
    if (this._diagnostics) {
      try { this._diagnostics.recordError(`Plugin "${pluginId}": ${message}`); } catch (_) { /* noop */ }
    }
  }
}

module.exports = PluginLifecycleManager;
module.exports.STATE = STATE;
