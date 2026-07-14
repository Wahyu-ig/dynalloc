'use strict';

/**
 * DynAlloc — Plugin SDK :: Plugin Context (Public API)
 * ======================================================
 *
 * The PluginContext is the stable, versioned Public API object passed
 * to every plugin. Plugins interact with the daemon EXCLUSIVELY through
 * this object — internal implementation details are never exposed.
 *
 * The context enforces:
 *   - Permission checks (every API call verifies the plugin has permission)
 *   - Error isolation (plugin errors are caught, never crash the daemon)
 *   - API versioning (the context shape is versioned via apiVersion)
 *
 * API surface:
 *
 *   context.config          — read daemon configuration (perm: read:config)
 *   context.state           — read daemon state (perm: read:state)
 *   context.metrics         — read metrics snapshot (perm: read:metrics)
 *   context.diagnostics     — read diagnostics report (perm: read:diagnostics)
 *   context.health          — read health check (perm: read:health)
 *
 *   context.bus             — event bus access (perm: write:events for emit,
 *                             no perm needed for subscribe — but events only
 *                             reach the plugin if it's registered)
 *   context.registerDetector(detector)    — (perm: write:detectors)
 *   context.registerProfile(def)          — (perm: write:profiles)
 *   context.registerController(ctrl)      — (perm: write:controllers)
 *   context.registerRule(rule)            — (perm: write:rules)
 *   context.registerCliCommand(cmd, fn)   — (perm: cli:register)
 *
 *   context.log             — logger (perm: log:write)
 *
 *   context.apiVersion      — string, e.g. "1.0"
 *   context.pluginId        — this plugin's ID
 *   context.pluginVersion   — this plugin's version
 *
 * Backward compatibility: only used when ENABLE_PLUGIN_SDK is true.
 */

const logger = require('../logger');
const { info, warn, debug, error: logError } = logger;
const { hasPermission } = require('./plugin-permissions');

class PluginContext {
  /**
   * @param {object} opts
   * @param {object} opts.manifest       - validated manifest
   * @param {Set<string>} opts.permissions - granted permissions
   * @param {object} opts.providers      - { getConfig, getState, getMetrics, ... }
   * @param {string} opts.apiVersion     - SDK API version
   * @param {string} opts.daemonVersion  - daemon version
   */
  constructor(opts) {
    if (!opts || !opts.manifest) {
      throw new TypeError('PluginContext: opts.manifest is required');
    }
    this._manifest = opts.manifest;
    this._permissions = opts.permissions || new Set();
    this._providers = opts.providers || {};
    this._apiVersion = opts.apiVersion || '1.0';
    this._daemonVersion = opts.daemonVersion || '0.5.0';
    this._disabled = false;

    // Bind the log methods so plugins can use context.log.info(...)
    this.log = this._createLogProxy();
  }

  // ── Accessors ────────────────────────────────────────────────────

  get apiVersion() { return this._apiVersion; }
  get daemonVersion() { return this._daemonVersion; }
  get pluginId() { return this._manifest.id; }
  get pluginVersion() { return this._manifest.version; }
  get manifest() { return this._manifest; }

  // ── Config (perm: read:config) ───────────────────────────────────

  get config() {
    this._requirePermission('read:config');
    if (this._providers.getConfig) {
      return this._providers.getConfig();
    }
    return {};
  }

  // ── State (perm: read:state) ─────────────────────────────────────

  get state() {
    this._requirePermission('read:state');
    if (this._providers.getState) {
      return this._providers.getState();
    }
    return {};
  }

  // ── Metrics (perm: read:metrics) ─────────────────────────────────

  get metrics() {
    this._requirePermission('read:metrics');
    if (this._providers.getMetrics) {
      return this._providers.getMetrics();
    }
    return {};
  }

  // ── Diagnostics (perm: read:diagnostics) ─────────────────────────

  get diagnostics() {
    this._requirePermission('read:diagnostics');
    if (this._providers.getDiagnostics) {
      return this._providers.getDiagnostics();
    }
    return {};
  }

  // ── Health (perm: read:health) ───────────────────────────────────

  get health() {
    this._requirePermission('read:health');
    if (this._providers.getHealth) {
      return this._providers.getHealth();
    }
    return { healthy: true };
  }

  // ── Event Bus (perm: write:events for emit) ──────────────────────

  get bus() {
    // Subscribe doesn't require permission — but the bus reference
    // is only useful for subscribing. Emitting requires permission.
    const bus = this._providers.getBus ? this._providers.getBus() : null;
    if (!bus) return null;

    // Return a proxy that checks permission on emit
    const self = this;
    return {
      on: (event, fn, opts) => {
        if (self._disabled) return -1;
        try { return bus.on(event, fn, opts); } catch (err) {
          warn(`Plugin "${self.pluginId}" bus.on error: ${err.message}`);
          return -1;
        }
      },
      off: (id) => {
        try { return bus.off(id); } catch (_) { return false; }
      },
      emit: (event, payload) => {
        self._requirePermission('write:events');
        if (self._disabled) return 0;
        try { return bus.emit(event, payload); } catch (err) {
          warn(`Plugin "${self.pluginId}" bus.emit error: ${err.message}`);
          return 0;
        }
      },
    };
  }

  // ── Registration APIs ────────────────────────────────────────────

  registerDetector(detector) {
    this._requirePermission('write:detectors');
    if (this._providers.registerDetector) {
      return this._providers.registerDetector(detector);
    }
    return false;
  }

  registerProfile(def) {
    this._requirePermission('write:profiles');
    if (this._providers.registerProfile) {
      return this._providers.registerProfile(def);
    }
    return { success: false, error: 'profile registration not available' };
  }

  registerController(controller) {
    this._requirePermission('write:controllers');
    if (this._providers.registerController) {
      return this._providers.registerController(controller);
    }
    return false;
  }

  registerRule(rule) {
    this._requirePermission('write:rules');
    if (this._providers.registerRule) {
      return this._providers.registerRule(rule);
    }
    return false;
  }

  registerCliCommand(cmd, handler) {
    this._requirePermission('cli:register');
    if (this._providers.registerCliCommand) {
      return this._providers.registerCliCommand(cmd, handler);
    }
    return false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Disable this context (after plugin crash/unload). All subsequent
   * API calls become no-ops.
   */
  disable() {
    this._disabled = true;
    debug(`PluginContext for "${this.pluginId}" disabled`);
  }

  get isDisabled() {
    return this._disabled;
  }

  get permissions() {
    return new Set(this._permissions);
  }

  // ── Internal ─────────────────────────────────────────────────────

  _requirePermission(perm) {
    if (this._disabled) {
      throw new Error(`plugin "${this.pluginId}" is disabled`);
    }
    if (!hasPermission(this._permissions, perm)) {
      throw new Error(`plugin "${this.pluginId}" lacks permission "${perm}"`);
    }
  }

  _createLogProxy() {
    const self = this;
    return {
      trace: (...args) => self._log('trace', ...args),
      debug: (...args) => self._log('debug', ...args),
      info: (...args) => self._log('info', ...args),
      warn: (...args) => self._log('warn', ...args),
      error: (...args) => self._log('error', ...args),
      fatal: (...args) => self._log('fatal', ...args),
    };
  }

  _log(level, ...args) {
    if (this._disabled) return;
    if (!hasPermission(this._permissions, 'log:write')) return;
    try {
      if (typeof logger[level] === 'function') {
        logger[level](`[plugin:${this.pluginId}]`, ...args);
      }
    } catch (_) { /* never let logging crash the daemon */ }
  }
}

module.exports = PluginContext;
