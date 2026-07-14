'use strict';

/**
 * DynAlloc — Plugin Architecture
 *
 * Provides a plugin system for detector modules.
 * Plugins auto-register on require/require-dir and are called
 * by the scheduler without modifying scheduler code.
 *
 * Plugin interface:
 *   {
 *     name: string,           // unique plugin name
 *     version: string,        // semver
 *     description: string,
 *     detect(procs, context): { pid, action, reason }[],
 *     init?(config): void,     // optional init
 *     destroy?(): void,        // optional cleanup
 *   }
 *
 * Built-in plugins are in plugins/*.js and auto-loaded.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { info, warn, debug, error } = logger;

class PluginManager {
  constructor() {
    this._plugins = new Map();
    this._initialized = false;
  }

  /**
   * Register a plugin.
   */
  register(plugin) {
    if (!plugin || typeof plugin.name !== 'string') {
      warn('Plugin registration gagal: plugin tidak valid atau tidak punya name');
      return false;
    }

    if (this._plugins.has(plugin.name)) {
      warn(`Plugin "${plugin.name}" sudah terdaftar, di-skip.`);
      return false;
    }

    // Validate required interface
    if (typeof plugin.detect !== 'function') {
      warn(`Plugin "${plugin.name}" tidak punya detect(), di-skip.`);
      return false;
    }

    this._plugins.set(plugin.name, {
      name: plugin.name,
      version: plugin.version || '0.0.0',
      description: plugin.description || '',
      detect: plugin.detect,
      init: typeof plugin.init === 'function' ? plugin.init : null,
      destroy: typeof plugin.destroy === 'function' ? plugin.destroy : null,
    });

    debug(`Plugin terdaftar: ${plugin.name} v${plugin.version}`);
    return true;
  }

  /**
   * Unregister a plugin by name.
   */
  unregister(name) {
    const plugin = this._plugins.get(name);
    if (plugin) {
      if (plugin.destroy) {
        try { plugin.destroy(); } catch (err) { warn(`Plugin ${name} destroy error: ${err.message}`); }
      }
      this._plugins.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Initialize all registered plugins.
   */
  initAll(config) {
    for (const [name, plugin] of this._plugins) {
      if (plugin.init) {
        try {
          plugin.init(config);
          debug(`Plugin ${name} initialized`);
        } catch (err) {
          warn(`Plugin ${name} init error: ${err.message}`);
        }
      }
    }
    this._initialized = true;
  }

  /**
   * Destroy all plugins (called on shutdown).
   */
  destroyAll() {
    for (const [name, plugin] of this._plugins) {
      if (plugin.destroy) {
        try { plugin.destroy(); } catch (err) { warn(`Plugin ${name} destroy error: ${err.message}`); }
      }
    }
    this._plugins.clear();
    this._initialized = false;
  }

  /**
   * Run all plugin detect functions and collect results.
   * Returns a Map<pid, { actions: string[], reasons: string[], pluginName: string }>.
   */
  runDetection(procs, context) {
    const results = new Map();

    for (const [name, plugin] of this._plugins) {
      try {
        const detections = plugin.detect(procs, context);
        if (!Array.isArray(detections)) continue;

        for (const det of detections) {
          if (!det || typeof det.pid !== 'number' || det.pid <= 0) continue;

          const existing = results.get(det.pid) || { actions: [], reasons: [], plugins: [] };
          if (det.action) existing.actions.push(det.action);
          if (det.reason) existing.reasons.push(`[${name}] ${det.reason}`);
          existing.plugins.push(name);
          results.set(det.pid, existing);
        }
      } catch (err) {
        warn(`Plugin ${name} detect error: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Auto-load built-in plugins from the plugins/ directory.
   */
  loadBuiltinPlugins(pluginDir) {
    const dir = pluginDir || path.join(__dirname, 'plugins');
    try {
      if (!fs.existsSync(dir)) return 0;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
      let loaded = 0;
      for (const file of files) {
        try {
          const pluginPath = path.join(dir, file);
          const plugin = require(pluginPath);
          if (plugin && typeof plugin.name === 'string') {
            if (this.register(plugin)) loaded++;
          }
        } catch (err) {
          warn(`Gagal memuat plugin ${file}: ${err.message}`);
        }
      }
      if (loaded > 0) info(`${loaded} plugin berhasil dimuat dari ${dir}`);
      return loaded;
    } catch (err) {
      warn(`Gagal scan plugin directory: ${err.message}`);
      return 0;
    }
  }

  /**
   * Load plugins from a custom directory.
   */
  loadCustomPlugins(pluginDir, config) {
    if (!pluginDir || typeof pluginDir !== 'string') return 0;
    return this.loadBuiltinPlugins(pluginDir);
  }

  get registeredPlugins() {
    return Array.from(this._plugins.keys());
  }

  get size() {
    return this._plugins.size;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance = null;

function getPluginManager() {
  if (!_instance) {
    _instance = new PluginManager();
  }
  return _instance;
}

function resetPluginManager() {
  if (_instance) {
    _instance.destroyAll();
  }
  _instance = null;
}

module.exports = {
  PluginManager,
  getPluginManager,
  resetPluginManager,
};