'use strict';

/**
 * DynAlloc — Detector Layer :: Detector Manager
 * ==============================================
 *
 * Orchestrates the lifecycle of all registered detectors and runs
 * them on each daemon tick.
 *
 * Responsibilities:
 *
 *   - Register/unregister detectors (validates interface).
 *   - Construct the DetectionContext snapshot from daemon state.
 *   - Run all available detectors on each tick (in registration order).
 *   - Aggregate detections into a single result map.
 *   - Emit bus events when detector state transitions are observed.
 *   - Provide getStatus() for the IPC `status` command.
 *
 * Concurrency:
 *
 *   Detectors are called sequentially on the daemon's event loop.
 *   There is no internal locking. Detectors MUST be synchronous in
 *   detect() — async detect() is not supported (would complicate the
 *   tick loop). If a detector needs async work, it should defer via
 *   setImmediate and emit a bus event when complete.
 *
 * Event Bus:
 *
 *   The manager accepts a bus in its constructor. When the daemon
 *   passes the Policy Engine's bus, detectors share state with PE
 *   rules. When PE is disabled, the daemon passes an isolated bus
 *   owned by the manager itself.
 *
 * Standard events emitted by the manager (detectors may emit more):
 *
 *   onDetectionTick  { timestamp, count, byDomain }
 *
 * Backward compatibility: only constructed when ENABLE_DETECTOR_LAYER
 * is true. When false, no detector code runs at all.
 */

const logger = require('../logger');
const { debug, info, warn } = logger;
const { DetectionContext } = require('./detection-context');
const { EventBus } = require('../policy-engine/event-bus');

// ── Internal helpers ─────────────────────────────────────────────────

function _validName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(name);
}

// ── DetectorManager class ────────────────────────────────────────────

class DetectorManager {
  /**
   * @param {object} opts
   * @param {object} opts.config   - main CONFIG object
   * @param {object} [opts.bus]    - event bus (if null, creates isolated bus)
   * @param {object} [opts.metrics] - metrics registry (may be null)
   * @param {object} [opts.stateStore] - shared StateStore (may be null)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('DetectorManager: opts.config is required');
    }
    this._config = opts.config;
    // If no bus is passed, create an isolated one and remember that
    // we own its lifecycle (so destroy() can tear it down). When the
    // daemon passes the Policy Engine's bus, the PE owns its lifecycle.
    this._ownsBus = !opts.bus;
    this._bus = opts.bus || new EventBus();
    this._metrics = opts.metrics || null;
    this._stateStore = opts.stateStore || null;

    this._detectors = new Map();      // name → detector instance
    this._lastDetections = new Map(); // name → last Detection[] (for diff)
    this._started = false;
    this._destroyed = false;
    this._lastTickAt = 0;
    this._tickCount = 0;
    this._ticking = false;            // re-entrancy guard for tick()
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Register a detector instance. Validates the interface.
   * @param {BaseDetector} detector
   * @returns {boolean} true on success
   */
  register(detector) {
    if (this._destroyed) return false;
    if (!detector || typeof detector.name !== 'string') {
      warn('DetectorManager.register: detector must have a name');
      return false;
    }
    if (!_validName(detector.name)) {
      warn(`DetectorManager.register: invalid detector name "${detector.name}" (must be lowercase kebab-case, max 31 chars)`);
      return false;
    }
    if (typeof detector.detect !== 'function') {
      warn(`DetectorManager.register: detector "${detector.name}" must have detect()`);
      return false;
    }
    if (this._detectors.has(detector.name)) {
      warn(`DetectorManager.register: detector "${detector.name}" already registered`);
      return false;
    }

    this._detectors.set(detector.name, detector);
    this._lastDetections.set(detector.name, []);
    debug(`Detector registered: ${detector.name}`);
    return true;
  }

  /**
   * Unregister a detector by name. Calls its stop() and destroy().
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    const detector = this._detectors.get(name);
    if (!detector) return false;
    try {
      if (detector.isRunning) detector.stop();
      if (typeof detector.destroy === 'function') detector.destroy();
    } catch (err) {
      warn(`DetectorManager.unregister: "${name}" teardown error: ${err.message}`);
    }
    this._detectors.delete(name);
    this._lastDetections.delete(name);
    debug(`Detector unregistered: ${name}`);
    return true;
  }

  /**
   * Run setup() on all registered detectors.
   */
  setupAll() {
    for (const [name, detector] of this._detectors) {
      try {
        if (typeof detector.setup === 'function') detector.setup();
      } catch (err) {
        warn(`Detector "${name}" setup error: ${err.message}`);
      }
    }
  }

  /**
   * Run start() on all registered detectors.
   */
  startAll() {
    if (this._started) return;
    for (const [name, detector] of this._detectors) {
      try {
        if (typeof detector.start === 'function') detector.start();
      } catch (err) {
        warn(`Detector "${name}" start error: ${err.message}`);
      }
    }
    this._started = true;
    info(`DetectorManager started (${this._detectors.size} detector(s))`);
  }

  /**
   * Run stop() on all registered detectors.
   */
  stopAll() {
    if (!this._started) return;
    for (const [name, detector] of this._detectors) {
      try {
        if (typeof detector.stop === 'function') detector.stop();
      } catch (err) {
        warn(`Detector "${name}" stop error: ${err.message}`);
      }
    }
    this._started = false;
    debug('DetectorManager stopped');
  }

  /**
   * Destroy all detectors and tear down the manager.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stopAll();
    for (const [name, detector] of this._detectors) {
      try {
        if (typeof detector.destroy === 'function') detector.destroy();
      } catch (err) {
        warn(`Detector "${name}" destroy error: ${err.message}`);
      }
    }
    this._detectors.clear();
    this._lastDetections.clear();
    if (this._ownsBus && this._bus && typeof this._bus.destroy === 'function') {
      this._bus.destroy();
    }
  }

  /**
   * Build a DetectionContext from the daemon's current state and run
   * all available detectors. Returns the aggregated result map.
   *
   * Re-entrancy: if a detector's detect() emits a bus event that
   * triggers a listener which calls tick() again, the re-entrant
   * call returns an empty Map immediately. This prevents nested
   * ticks from corrupting _lastDetections mid-iteration.
   *
   * @param {object} fields - see DetectionContext shape
   * @returns {Map<string, Detection[]>} name → detections
   */
  tick(fields) {
    if (this._destroyed || !this._started) return new Map();
    // Re-entrancy guard: if we're already inside a tick, return
    // immediately. The outer tick will finish and the next regular
    // tick will pick up any state changes.
    if (this._ticking) {
      debug('DetectorManager.tick: re-entrant call skipped');
      return new Map();
    }
    this._ticking = true;

    let context;
    try {
      context = new DetectionContext(fields);
    } catch (err) {
      warn(`DetectorManager.tick: failed to build context: ${err.message}`);
      this._ticking = false;
      return new Map();
    }

    this._lastTickAt = context.timestamp;
    this._tickCount++;

    const results = new Map();
    let totalDetections = 0;
    const byDomain = {};

    try {
      for (const [name, detector] of this._detectors) {
        // Skip unavailable detectors
        try {
          if (typeof detector.isAvailable === 'function' && !detector.isAvailable()) {
            continue;
          }
        } catch (err) {
          warn(`Detector "${name}" isAvailable() threw: ${err.message}`);
          continue;
        }

        let detections = [];
        try {
          detections = detector.detect(context) || [];
          if (!Array.isArray(detections)) {
            warn(`Detector "${name}" detect() returned non-array, ignoring`);
            detections = [];
          }
        } catch (err) {
          warn(`Detector "${name}" detect() error: ${err.message}`);
          detections = [];
        }

        results.set(name, detections);
        this._lastDetections.set(name, detections);
        totalDetections += detections.length;

        for (const det of detections) {
          const domain = det.domain || 'unknown';
          byDomain[domain] = (byDomain[domain] || 0) + 1;
        }
      }

      // Emit aggregate tick event. Listeners can subscribe to
      // 'onDetectionTick' for periodic snapshots. Only emitted when
      // there is at least one detection, to avoid bus spam on idle ticks.
      if (this._bus && totalDetections > 0) {
        try {
          this._bus.emit('onDetectionTick', {
            timestamp: context.timestamp,
            count: totalDetections,
            byDomain,
          });
        } catch (_) { /* bus emit failure is non-fatal */ }
      }

      if (this._metrics) {
        try {
          this._metrics.counter('detector_ticks').increment();
          this._metrics.counter('detector_detections').increment(totalDetections);
          this._metrics.gauge('detector_count').set(this._detectors.size);
        } catch (_) { /* metrics failure is non-fatal */ }
      }
    } finally {
      // Always clear the re-entrancy guard, even if a detector
      // threw an uncaught error (defense-in-depth — the per-detector
      // try/catch above should already prevent this).
      this._ticking = false;
    }

    return results;
  }

  /**
   * Propagate a config hot-reload to all detectors.
   */
  setConfig(config) {
    this._config = config;
    for (const [name, detector] of this._detectors) {
      try {
        if (typeof detector.setConfig === 'function') detector.setConfig(config);
      } catch (err) {
        warn(`Detector "${name}" setConfig error: ${err.message}`);
      }
    }
  }

  // ── Introspection ────────────────────────────────────────────────

  /**
   * Get the registered detector names (in registration order).
   */
  get registeredDetectors() {
    return Array.from(this._detectors.keys());
  }

  /**
   * Get the number of registered detectors.
   */
  get size() {
    return this._detectors.size;
  }

  /**
   * Get the last tick timestamp (ms since epoch).
   */
  get lastTickAt() {
    return this._lastTickAt;
  }

  /**
   * Get the cumulative tick count.
   */
  get tickCount() {
    return this._tickCount;
  }

  /**
   * Return a status snapshot for the IPC `status` command.
   */
  getStatus() {
    const detectors = [];
    for (const [name, detector] of this._detectors) {
      try {
        detectors.push(detector.getStatus ? detector.getStatus() : { name });
      } catch (err) {
        detectors.push({ name, error: err.message });
      }
    }
    return {
      enabled: true,
      running: this._started,
      detectorCount: this._detectors.size,
      tickCount: this._tickCount,
      lastTickAt: this._lastTickAt ? new Date(this._lastTickAt).toISOString() : null,
      detectors,
    };
  }

  /**
   * Return the last detections for a specific detector (or all).
   * @param {string} [name] - detector name, or omit for all
   * @returns {Map<string, Detection[]>} | Detection[]
   */
  getLastDetections(name) {
    if (name !== undefined) {
      return this._lastDetections.get(name) || [];
    }
    return new Map(this._lastDetections);
  }

  /**
   * Expose the bus so plugins and other modules can subscribe
   * (read-only — they should not emit directly).
   */
  get bus() {
    return this._bus;
  }
}

module.exports = { DetectorManager, DetectionContext };
