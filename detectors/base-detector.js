'use strict';

/**
 * DynAlloc — Detector Layer :: Base Detector
 * ===========================================
 *
 * Abstract base class for all detectors in the Detector Layer.
 *
 * A Detector owns one detection domain (workload classification, power
 * state, idle state, thermal state, etc.). It is purely observational —
 * it NEVER modifies system state. When it wants to act, it emits an
 * event on the Event Bus; the Policy Engine (or a future consumer)
 * decides what to do.
 *
 * Lifecycle (driven by DetectorManager, called from daemon bootstrap):
 *
 *     new Detector(name, deps)
 *         ↓
 *     setup()       — one-time init (subscribe to bus, capture baseline)
 *         ↓
 *     start()       — begin any periodic work (most detectors do nothing)
 *         ↓
 *     ... detect(context) calls from the daemon tick loop ...
 *         ↓
 *     stop()        — graceful shutdown, unsubscribe
 *
 * Detection model:
 *
 *     detect(context) returns an array of Detection objects:
 *       {
 *         detector: '<name>',
 *         domain: '<logical-domain>',
 *         classification: '<enum>',
 *         confidence: 0.0 - 1.0,
 *         payload: { ... },
 *         timestamp: ISO8601,
 *       }
 *
 *     An empty array means "no detection this tick" — that is a valid
 *     and normal result, not an error.
 *
 * Capability model:
 *
 *     isAvailable() — returns true iff this detector can run on the
 *                     current system. When false, DetectorManager
 *                     skips it entirely (does not call detect()).
 *
 * Event Bus integration:
 *
 *     Detectors MAY subscribe to bus events in setup() and MAY emit
 *     events via this._bus.emit(name, payload). The bus is provided
 *     by the DetectorManager (either the Policy Engine's bus when PE
 *     is enabled, or an isolated bus owned by the DetectorManager
 *     when PE is disabled). Detectors MUST NOT assume any specific
 *     bus implementation — only the EventEmitter-like emit/on/off API.
 *
 * Hot-reload:
 *
 *     setConfig(config) updates the config reference. Detectors that
 *     cache derived values from config (e.g. compiled regexes) should
 *     override this to refresh their cache.
 *
 * This base class is intentionally minimal — it provides sane defaults
 * and a contract. Subclasses override detect() (required) and may
 * override setup/start/stop/isAvailable/getStatus/setConfig.
 *
 * Backward compatibility: this module is only required when
 * ENABLE_DETECTOR_LAYER is true. The daemon never imports it directly
 * — it goes through detectors/index.js.
 */

class BaseDetector {
  /**
   * @param {string} name       Short identifier ('workload', 'power-state', ...).
   * @param {object} deps       Shared dependencies.
   * @param {object} deps.config         The global CONFIG object (hot-reloadable).
   * @param {object} deps.logger         The structured logger module.
   * @param {object} deps.bus            The Event Bus instance (PE bus or isolated).
   * @param {object} deps.stateStore     The shared StateStore (for cross-detector state).
   * @param {object} deps.metrics        The metrics registry (may be null).
   */
  constructor(name, deps) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('BaseDetector: name must be a non-empty string');
    }
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('BaseDetector: deps must be an object');
    }
    this.name = name;
    this._deps = deps;
    this._started = false;
    this._destroyed = false;
  }

  /** Convenience accessor for the current config. */
  get config() {
    return this._deps.config;
  }

  /** Convenience accessor for the logger. */
  get log() {
    return this._deps.logger;
  }

  /** Convenience accessor for the event bus. */
  get bus() {
    return this._deps.bus;
  }

  /** Convenience accessor for the shared state store. */
  get stateStore() {
    return this._deps.stateStore;
  }

  /** Convenience accessor for the metrics registry (may be null). */
  get metrics() {
    return this._deps.metrics || null;
  }

  /** @returns {boolean} whether start() has been called and stop() has not. */
  get isRunning() {
    return this._started && !this._destroyed;
  }

  // ── Lifecycle hooks (subclasses override as needed) ─────────────────

  /**
   * One-time initialization. Called once during daemon bootstrap,
   * BEFORE the scheduler starts ticking. Must be idempotent —
   * bootstrap may call it again after a hot-reload trigger.
   *
   * Default: no-op.
   */
  setup() {}

  /**
   * Begin any periodic work. Most detectors have no periodic work
   * (they only act when the daemon calls detect() each tick). Called
   * after setup(). Default: no-op.
   */
  start() {
    this._started = true;
  }

  /**
   * Graceful shutdown. Unsubscribe from bus, release resources.
   * Called once during daemon shutdown. Default: no-op.
   */
  stop() {
    this._started = false;
  }

  /**
   * Permanent teardown. After destroy, the detector cannot be
   * restarted. Used by tests and on daemon shutdown.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._started = false;
  }

  // ── Capability probe ────────────────────────────────────────────────

  /**
   * Returns true iff this detector can run on the current system.
   * The DetectorManager uses this to skip the detector gracefully
   * when (e.g.) a required sensor is unavailable.
   *
   * Default: true. Subclasses override to probe availability.
   */
  isAvailable() {
    return true;
  }

  // ── Detection (subclasses MUST override) ────────────────────────────

  /**
   * Run detection against the current context snapshot.
   *
   * @param {DetectionContext} context  - snapshot of system state
   * @returns {Array<Detection>}        - may be empty, never null
   */
  detect(_context) {
    return [];
  }

  // ── Introspection ───────────────────────────────────────────────────

  /**
   * Return a status snapshot for the IPC `status` command.
   * Subclasses may extend with detector-specific fields.
   */
  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      running: this.isRunning,
    };
  }

  // ── Hot-reload support ──────────────────────────────────────────────

  /**
   * Update the detector's config reference. Called by the
   * DetectorManager when config is hot-reloaded. Subclasses may
   * override to re-probe capabilities or refresh cached state.
   */
  setConfig(config) {
    this._deps.config = config;
  }
}

module.exports = BaseDetector;
