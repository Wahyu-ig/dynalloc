'use strict';

/**
 * DynAlloc — Recognition Layer :: Recognition Engine
 * ====================================================
 *
 * The event-driven orchestrator for workload recognition. Subscribes
 * to detector events, runs the WorkloadRecognizer, and routes
 * high-confidence detections to the Profile Manager.
 *
 * Architecture:
 *
 *   User Events
 *       ↓
 *   Detector Layer (Phase 1)
 *       ↓
 *   Recognition Engine (Phase 5)    ← THIS MODULE
 *       ↓ (confidence ≥ threshold)
 *   Profile Manager (Phase 3)
 *       ↓
 *   Adaptive Switching Engine (Phase 4)
 *       ↓
 *   Resource Controller (Phase 2)
 *       ↓
 *   Operating System
 *
 * Event-driven (no polling):
 *
 *   The engine subscribes to detector events. It NEVER polls. The
 *   only timer is the debounce timer (unref'd).
 *
 * Confidence gating:
 *
 *   When the recognizer produces detections with confidence ≥
 *   RECOGNITION_CONFIDENCE_THRESHOLD, the engine demands the
 *   top-confidence workload's profile from the PM. When confidence
 *   is below threshold, the engine withdraws its demand (allowing
 *   other demand sources to win, or the default 'balanced' to apply).
 *
 * Conflict resolution:
 *
 *   When multiple workloads are detected simultaneously (e.g. Gaming
 *   + Streaming), the engine demands only the TOP-confidence
 *   workload's profile. The PM's priority system + the Adaptive
 *   Engine's cooldown/oscillation detection handle the rest.
 *
 * Debounce:
 *
 *   Rapid recognition events are debounced (RECOGNITION_DEBOUNCE_MS,
 *   default 300ms) to prevent event storms.
 *
 * Extensibility:
 *
 *   Plugins can register custom recognition rules via
 *   `engine.recognizer.registerRule(rule)`.
 *
 * Backward compatibility: only constructed when
 * ENABLE_WORKLOAD_RECOGNITION is true.
 */

const logger = require('../logger');
const { info, warn, debug } = logger;
const WorkloadRecognizer = require('./workload-recognizer');

// ── Constants ────────────────────────────────────────────────────────

const SUBSCRIBED_EVENTS = [
  'onWorkloadDetected',
  'onPowerStateChanged',
  'onIdleStateChanged',
  'onDetectionTick',
];

const DEFAULT_DEBOUNCE_MS = 300;

// ── RecognitionEngine class ──────────────────────────────────────────

class RecognitionEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config          - main CONFIG
   * @param {object} opts.bus             - EventBus
   * @param {object} opts.profileManager  - ProfileManager (for demand)
   * @param {object} [opts.metrics]       - metrics registry (may be null)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('RecognitionEngine: opts.config is required');
    }
    if (!opts.bus) {
      throw new TypeError('RecognitionEngine: opts.bus is required');
    }
    if (!opts.profileManager) {
      throw new TypeError('RecognitionEngine: opts.profileManager is required');
    }
    this._config = opts.config;
    this._bus = opts.bus;
    this._pm = opts.profileManager;
    this._metrics = opts.metrics || null;

    this._recognizer = new WorkloadRecognizer({ config: opts.config });
    this._listenerIds = [];
    this._debounceTimer = null;
    this._pendingContext = null;
    this._started = false;
    this._destroyed = false;
    this._lastDemandedProfile = null;
    this._demandCount = 0;

    // Bind handlers
    this._handlers = {
      onWorkloadDetected: (p) => this._handleWorkload(p),
      onPowerStateChanged: (p) => this._handlePowerState(p),
      onIdleStateChanged: (p) => this._handleIdleState(p),
      onDetectionTick: (p) => this._handleDetectionTick(p),
    };
  }

  // ── Public API ───────────────────────────────────────────────────

  get recognizer() {
    return this._recognizer;
  }

  /**
   * Setup: no-op (recognizer is initialized in constructor).
   */
  setup() {}

  /**
   * Start: subscribe to bus events.
   */
  start() {
    if (this._started) return;

    for (const eventName of SUBSCRIBED_EVENTS) {
      const handler = this._handlers[eventName];
      if (handler) {
        const id = this._bus.on(eventName, handler);
        if (id > 0) this._listenerIds.push(id);
      }
    }

    this._started = true;
    info(`RecognitionEngine started (${this._recognizer.ruleCount} rules, threshold=${this._recognizer._getConfidenceThreshold()})`);
  }

  /**
   * Stop: unsubscribe from bus events.
   */
  stop() {
    if (!this._started) return;
    for (const id of this._listenerIds) {
      try { this._bus.off(id); } catch (_) { /* noop */ }
    }
    this._listenerIds = [];
    this._cancelDebounce();
    this._started = false;
    debug('RecognitionEngine stopped');
  }

  /**
   * Destroy: stop + clear state.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    // Withdraw our demand from the PM if we had one
    if (this._lastDemandedProfile) {
      try { this._pm.demand('recognition', null); } catch (_) { /* noop */ }
      this._lastDemandedProfile = null;
    }
  }

  /**
   * Get the currently demanded profile (or null).
   */
  get demandedProfile() {
    return this._lastDemandedProfile;
  }

  getStatus() {
    return {
      enabled: true,
      running: this._started,
      recognizer: this._recognizer.getStatus(),
      demandedProfile: this._lastDemandedProfile,
      demandCount: this._demandCount,
    };
  }

  // ── Hot-reload ───────────────────────────────────────────────────

  setConfig(config) {
    this._config = config;
    this._recognizer._config = config;
  }

  // ── Event handlers ───────────────────────────────────────────────

  _handleWorkload(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload) return;

    // The detector event payload has `workload` (e.g. 'GAME', 'IDE')
    // which maps to our workloadClassification field.
    this._pendingContext = {
      foregroundComm: payload.comm || '',
      foregroundPid: payload.pid || null,
      workloadClassification: payload.workload || 'UNKNOWN',
      cpuPressure: payload.cpuPressure || 0,
      gpuUtilization: payload.gpuUtilization !== undefined ? payload.gpuUtilization : null,
      memoryUsage: payload.memoryUsage || 0,
      processCount: payload.processCount || 0,
      mediaPidsCount: payload.mediaPidsCount || 0,
      idleState: payload.idleState || 'ACTIVE',
      onBattery: payload.onBattery || false,
      batteryCapacity: payload.batteryCapacity || 100,
    };

    this._scheduleRecognition();
  }

  _handlePowerState(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload) return;

    // Enrich pending context with power state
    if (this._pendingContext) {
      this._pendingContext.onBattery = (payload.to === 'BATTERY' || payload.to === 'BATTERY_LOW' || payload.to === 'BATTERY_CRITICAL');
      // If battery low/critical, we might want to override to battery-saver
      if (payload.to === 'BATTERY_LOW' || payload.to === 'BATTERY_CRITICAL') {
        this._pendingContext.idleState = 'ACTIVE';  // not idle, just low battery
      }
    }
    this._scheduleRecognition();
  }

  _handleIdleState(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload) return;

    // If there's no pending context, create a minimal one with the idle state.
    // The idle rule can fire with just idleState set.
    if (!this._pendingContext) {
      this._pendingContext = {
        foregroundComm: '',
        foregroundPid: null,
        workloadClassification: 'UNKNOWN',
        cpuPressure: 0,
        gpuUtilization: null,
        memoryUsage: 0,
        processCount: 0,
        mediaPidsCount: 0,
        idleState: payload.to || 'ACTIVE',
        onBattery: false,
        batteryCapacity: 100,
      };
    } else {
      this._pendingContext.idleState = payload.to || 'ACTIVE';
    }
    this._scheduleRecognition();
  }

  _handleDetectionTick(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload) return;

    // The detection tick from the Detector Layer carries aggregate info
    // Use it to enrich the pending context
    if (this._pendingContext && payload.byDomain) {
      // Update process count if available
      // (the tick payload has byDomain but not raw process count —
      // we approximate from the detection count)
      this._pendingContext.processCount = payload.count || 0;
    }
    this._scheduleRecognition();
  }

  // ── Recognition + demand ─────────────────────────────────────────

  _scheduleRecognition() {
    this._cancelDebounce();
    const delay = this._getDebounceMs();

    if (delay <= 0) {
      this._runRecognition();
      return;
    }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._runRecognition();
    }, delay);
    if (typeof this._debounceTimer.unref === 'function') {
      this._debounceTimer.unref();
    }
  }

  _runRecognition() {
    if (!this._pendingContext) return;

    const detections = this._recognizer.recognize(this._pendingContext);
    this._pendingContext = null;

    if (this._metrics) {
      try {
        this._metrics.counter('recognition_runs').increment();
        this._metrics.gauge('recognition_detections').set(detections.length);
        if (detections.length > 0) {
          this._metrics.gauge('recognition_top_confidence').set(detections[0].confidence);
        }
      } catch (_) { /* non-fatal */ }
    }

    if (detections.length === 0) {
      // No high-confidence detection — withdraw our demand
      if (this._lastDemandedProfile) {
        debug('RecognitionEngine: no confident detection, withdrawing demand');
        try { this._pm.demand('recognition', null); } catch (_) { /* noop */ }
        this._lastDemandedProfile = null;
      }
      return;
    }

    // Demand the top-confidence workload's profile
    const top = detections[0];
    if (top.profile !== this._lastDemandedProfile) {
      debug(`RecognitionEngine: demanding "${top.profile}" (workload=${top.workload}, confidence=${top.confidence.toFixed(2)}, source=${top.source})`);
      try {
        const ok = this._pm.demand('recognition', top.profile);
        if (ok) {
          this._lastDemandedProfile = top.profile;
          this._demandCount++;

          // Emit event for observability
          if (this._bus) {
            try {
              this._bus.emit('onWorkloadRecognized', {
                workload: top.workload,
                profile: top.profile,
                confidence: top.confidence,
                source: top.source,
                reason: top.reason,
                timestamp: new Date().toISOString(),
              });
            } catch (_) { /* bus emit failure is non-fatal */ }
          }
        }
      } catch (err) {
        warn(`RecognitionEngine: demand error: ${err.message}`);
      }
    }
  }

  _cancelDebounce() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  _getDebounceMs() {
    const t = this._config.RECOGNITION_DEBOUNCE_MS;
    return typeof t === 'number' && t >= 0 && t <= 5000 ? t : DEFAULT_DEBOUNCE_MS;
  }
}

module.exports = RecognitionEngine;
module.exports.SUBSCRIBED_EVENTS = SUBSCRIBED_EVENTS;
module.exports.DEFAULT_DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
