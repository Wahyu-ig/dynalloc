'use strict';

/**
 * DynAlloc — Resource Controller Manager
 * =======================================
 *
 * Aggregates all resource controllers into a unified orchestrator
 * that the Policy Engine (and future consumers) use to execute
 * resource management actions.
 *
 * Layered architecture:
 *
 *   User Events → Detector Layer → Policy Engine → ResourceControllerManager
 *                                                      ↓
 *                                              ┌───────┴───────┐
 *                                              ↓               ↓
 *                                          CpuController   ThermalController
 *                                          MemoryController  PowerController
 *                                          IoController
 *                                          NetworkController
 *                                          GovernorController
 *                                              ↓
 *                                          Operating System
 *
 * The Policy Engine MUST NOT manipulate system resources directly.
 * All resource modifications pass through this manager, which routes
 * them to the appropriate controller.
 *
 * Design principles:
 *
 *   - Single responsibility: each controller owns one domain.
 *   - Modularity: controllers are independently testable.
 *   - Isolation: no controller depends on another controller.
 *   - Plugin extensibility: third-party controllers can be registered
 *     via registerController().
 *   - Consistent API: all controllers extend ResourceController
 *     (lifecycle, isAvailable, getStatus, setConfig).
 *
 * Lifecycle:
 *
 *   new ResourceControllerManager({ config, actuator, governor, logger, metrics })
 *       ↓
 *   setup()       — one-time init for all controllers
 *       ↓
 *   start()       — begin any periodic work (most controllers no-op)
 *       ↓
 *   ... applyProfile / setGovernor / etc. calls from PE ...
 *       ↓
 *   stop()        — graceful shutdown
 *       ↓
 *   destroy()     — permanent teardown
 *
 * Backward compatibility: the manager does NOT replace the Actuator
 * facade. The daemon's tick loop continues to use the Actuator
 * (which delegates to the same controller instances). The manager
 * is an ADDITIONAL entry point for the Policy Engine.
 */

const logger = require('../logger');
const { debug, info, warn } = logger;
const ThermalController = require('./controllers/thermal-controller');
const PowerController = require('./controllers/power-controller');

// ── Internal helpers ─────────────────────────────────────────────────

function _validName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(name);
}

// ── ResourceControllerManager class ──────────────────────────────────

class ResourceControllerManager {
  /**
   * @param {object} opts
   * @param {object} opts.config        - main CONFIG object
   * @param {object} [opts.actuator]    - Actuator facade (provides cpu/memory/io/network controllers)
   * @param {object} [opts.governor]    - GovernorManager instance
   * @param {object} [opts.metrics]     - metrics registry (may be null)
   * @param {object} [opts.cgroupManager] - shared CgroupManager (may be null; defaults to actuator._cgroupManager)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('ResourceControllerManager: opts.config is required');
    }
    this._config = opts.config;
    this._actuator = opts.actuator || null;
    this._governor = opts.governor || null;
    this._metrics = opts.metrics || null;
    this._cgroupManager = opts.cgroupManager ||
      (opts.actuator && opts.actuator._cgroupManager) || null;

    this._controllers = new Map();  // name → controller instance
    this._started = false;
    this._destroyed = false;
    this._actionCount = 0;

    // Register built-in controllers
    this._registerBuiltins();
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Register a controller instance. Validates the interface.
   * @param {ResourceController} controller
   * @returns {boolean} true on success
   */
  registerController(controller) {
    if (this._destroyed) return false;
    if (!controller || typeof controller.name !== 'string') {
      warn('ResourceControllerManager.register: controller must have a name');
      return false;
    }
    if (!_validName(controller.name)) {
      warn(`ResourceControllerManager.register: invalid controller name "${controller.name}"`);
      return false;
    }
    if (this._controllers.has(controller.name)) {
      warn(`ResourceControllerManager.register: controller "${controller.name}" already registered`);
      return false;
    }
    this._controllers.set(controller.name, controller);
    debug(`Resource controller registered: ${controller.name}`);
    return true;
  }

  /**
   * Unregister a controller by name.
   * @param {string} name
   * @returns {boolean}
   */
  unregisterController(name) {
    const controller = this._controllers.get(name);
    if (!controller) return false;
    try {
      if (typeof controller.stop === 'function') controller.stop();
      if (typeof controller.destroy === 'function') controller.destroy();
    } catch (err) {
      warn(`ResourceControllerManager.unregister: "${name}" teardown error: ${err.message}`);
    }
    this._controllers.delete(name);
    return true;
  }

  /**
   * Get a controller by name.
   * @param {string} name
   * @returns {ResourceController|undefined}
   */
  getController(name) {
    return this._controllers.get(name);
  }

  /**
   * Run setup() on all controllers.
   */
  setupAll() {
    for (const [name, controller] of this._controllers) {
      try {
        if (typeof controller.setup === 'function') controller.setup();
      } catch (err) {
        warn(`Resource controller "${name}" setup error: ${err.message}`);
      }
    }
  }

  /**
   * Run start() on all controllers.
   */
  startAll() {
    if (this._started) return;
    for (const [name, controller] of this._controllers) {
      try {
        if (typeof controller.start === 'function') controller.start();
      } catch (err) {
        warn(`Resource controller "${name}" start error: ${err.message}`);
      }
    }
    this._started = true;
    info(`ResourceControllerManager started (${this._controllers.size} controller(s))`);
  }

  /**
   * Run stop() on all controllers.
   */
  stopAll() {
    if (!this._started) return;
    for (const [name, controller] of this._controllers) {
      try {
        if (typeof controller.stop === 'function') controller.stop();
      } catch (err) {
        warn(`Resource controller "${name}" stop error: ${err.message}`);
      }
    }
    this._started = false;
    debug('ResourceControllerManager stopped');
  }

  /**
   * Destroy all controllers and tear down the manager.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stopAll();
    for (const [name, controller] of this._controllers) {
      try {
        if (typeof controller.destroy === 'function') controller.destroy();
      } catch (err) {
        warn(`Resource controller "${name}" destroy error: ${err.message}`);
      }
    }
    this._controllers.clear();
  }

  /**
   * Propagate a config hot-reload to all controllers.
   */
  setConfig(config) {
    this._config = config;
    for (const [name, controller] of this._controllers) {
      try {
        if (typeof controller.setConfig === 'function') controller.setConfig(config);
      } catch (err) {
        warn(`Resource controller "${name}" setConfig error: ${err.message}`);
      }
    }
  }

  // ── Domain-specific action methods ───────────────────────────────

  /**
   * Apply a thermal profile.
   * @param {string} profileName
   * @returns {object} result from ThermalController.applyProfile
   */
  applyThermalProfile(profileName) {
    const c = this.getController('thermal');
    if (!c) return { success: false, error: 'thermal controller not registered' };
    this._actionCount++;
    return c.applyProfile(profileName);
  }

  /**
   * Apply a power profile.
   * @param {string} profileName
   * @returns {object} result from PowerController.applyProfile
   */
  applyPowerProfile(profileName) {
    const c = this.getController('power');
    if (!c) return { success: false, error: 'power controller not registered' };
    this._actionCount++;
    return c.applyProfile(profileName);
  }

  /**
   * Set the PPD profile via the PowerController.
   * @param {string} profileName
   * @returns {object} result from PowerController.setPpdProfile
   */
  setPpdProfile(profileName) {
    const c = this.getController('power');
    if (!c) return { success: false, error: 'power controller not registered' };
    this._actionCount++;
    return c.setPpdProfile(profileName);
  }

  /**
   * Set CPU governor via the GovernorController.
   * @param {number[]} cores
   * @param {string} governor
   * @returns {object} { success, error }
   */
  setGovernor(cores, governor) {
    const c = this.getController('governor');
    if (!c) return { success: false, error: 'governor controller not registered' };
    if (!c.isAvailable()) return { success: false, error: 'governor not available' };
    this._actionCount++;
    const ok = c.applyGovernor(cores, governor);
    return { success: ok, error: ok ? null : 'governor set failed' };
  }

  // ── Introspection ────────────────────────────────────────────────

  /**
   * Get the registered controller names.
   */
  get registeredControllers() {
    return Array.from(this._controllers.keys());
  }

  /**
   * Get the number of registered controllers.
   */
  get size() {
    return this._controllers.size;
  }

  /**
   * Get the cumulative action count.
   */
  get actionCount() {
    return this._actionCount;
  }

  /**
   * Return a status snapshot for the IPC `status` command.
   */
  getStatus() {
    const controllers = [];
    for (const [name, controller] of this._controllers) {
      try {
        controllers.push(controller.getStatus ? controller.getStatus() : { name });
      } catch (err) {
        controllers.push({ name, error: err.message });
      }
    }
    return {
      enabled: true,
      running: this._started,
      controllerCount: this._controllers.size,
      actionCount: this._actionCount,
      controllers,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Register the built-in controllers. Existing controllers (CPU,
   * Memory, IO, Network, Governor) are referenced from the Actuator
   * facade / GovernorManager. New controllers (Thermal, Power) are
   * instantiated here.
   */
  _registerBuiltins() {
    const deps = {
      config: this._config,
      logger,
      cgroupManager: this._cgroupManager,
      tracker: this._actuator && this._actuator._makeTracker ? this._actuator._makeTracker() : { log() {} },
    };

    // ── Reference existing controllers from Actuator facade ────────
    if (this._actuator) {
      if (this._actuator._cpu) {
        this._controllers.set('cpu', this._actuator._cpu);
        debug('Resource controller registered: cpu (from Actuator)');
      }
      if (this._actuator._memory) {
        this._controllers.set('memory', this._actuator._memory);
        debug('Resource controller registered: memory (from Actuator)');
      }
      if (this._actuator._io) {
        this._controllers.set('io', this._actuator._io);
        debug('Resource controller registered: io (from Actuator)');
      }
      if (this._actuator._network) {
        this._controllers.set('network', this._actuator._network);
        debug('Resource controller registered: network (from Actuator)');
      }
    }

    // ── Wrap GovernorManager in a GovernorController adapter ───────
    if (this._governor) {
      const GovernorController = require('./controllers/governor-controller');
      const govCtrl = new GovernorController({
        config: this._config,
        logger,
        cgroupManager: this._cgroupManager,
        tracker: deps.tracker,
        governorManager: this._governor,
      });
      this._controllers.set('governor', govCtrl);
      debug('Resource controller registered: governor (from GovernorManager)');
    }

    // ── Instantiate new controllers (Thermal, Power) ───────────────
    const thermal = new ThermalController(deps);
    this._controllers.set('thermal', thermal);
    debug('Resource controller registered: thermal');

    const power = new PowerController(deps);
    this._controllers.set('power', power);
    debug('Resource controller registered: power');
  }
}

module.exports = ResourceControllerManager;
