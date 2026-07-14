'use strict';

/**
 * DynAlloc — Monitoring Layer :: Diagnostics Engine
 * ==================================================
 *
 * Aggregates diagnostics from all subsystems into a single report.
 * The engine is READ-ONLY — it never modifies system state, never
 * interrupts daemon execution.
 *
 * Report shape:
 *
 *   {
 *     timestamp: ISO8601,
 *     daemon: { pid, uptime, version, mode },
 *     detectors: [ { name, available, running, ... } ],
 *     controllers: [ { name, available, ... } ],
 *     profiles: { count, active, demandSet, switchCount },
 *     adaptive: { running, activeProfile, userOverride, transitions },
 *     recognition: { running, ruleCount, demandedProfile },
 *     policyEngine: { running, ruleCount, ... },
 *     plugins: [ name, ... ],
 *     eventBus: { listeners, events },
 *     metrics: { counters, gauges, histograms },
 *     errors: [ { timestamp, message }, ... ],
 *     warnings: [ { timestamp, message }, ... ],
 *   }
 *
 * The engine accepts "providers" — functions that return subsystem
 * status. The daemon wires these at construction time.
 *
 * Backward compatibility: only constructed when
 * ENABLE_MONITORING_FRAMEWORK is true.
 */

const logger = require('../logger');
const { debug, warn } = logger;

class DiagnosticsEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {object} [opts.providers] - { getState, getDetectorStatus, ... }
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('DiagnosticsEngine: opts.config is required');
    }
    this._config = opts.config;
    this._providers = opts.providers || {};
    this._errors = [];       // bounded error log
    this._warnings = [];     // bounded warning log
    this._maxLogSize = 50;
    this._reportCount = 0;
  }

  /**
   * Generate a full diagnostics report.
   * @returns {object}
   */
  report() {
    this._reportCount++;
    return {
      timestamp: new Date().toISOString(),
      daemon: this._readDaemon(),
      detectors: this._readDetectors(),
      controllers: this._readControllers(),
      profiles: this._readProfiles(),
      adaptive: this._readAdaptive(),
      recognition: this._readRecognition(),
      policyEngine: this._readPolicyEngine(),
      plugins: this._readPlugins(),
      eventBus: this._readEventBus(),
      metrics: this._readMetrics(),
      errors: this._errors.slice(-10),
      warnings: this._warnings.slice(-10),
    };
  }

  /**
   * Record an error (for diagnostics).
   */
  recordError(message) {
    this._errors.push({ timestamp: new Date().toISOString(), message: String(message) });
    if (this._errors.length > this._maxLogSize) {
      this._errors = this._errors.slice(-this._maxLogSize);
    }
  }

  /**
   * Record a warning (for diagnostics).
   */
  recordWarning(message) {
    this._warnings.push({ timestamp: new Date().toISOString(), message: String(message) });
    if (this._warnings.length > this._maxLogSize) {
      this._warnings = this._warnings.slice(-this._maxLogSize);
    }
  }

  get reportCount() {
    return this._reportCount;
  }

  getStatus() {
    return {
      reportCount: this._reportCount,
      errorCount: this._errors.length,
      warningCount: this._warnings.length,
    };
  }

  // ── Internal readers ─────────────────────────────────────────────

  _readDaemon() {
    return {
      pid: process.pid,
      uptime: this._providers.getUptime ? this._providers.getUptime() : 0,
      nodeVersion: process.version,
      dryRun: !!this._config.DRY_RUN,
    };
  }

  _readDetectors() {
    try {
      if (this._providers.getDetectorStatus) {
        const status = this._providers.getDetectorStatus();
        if (status && status.detectors) return status.detectors;
      }
    } catch (_) { /* unavailable */ }
    return [];
  }

  _readControllers() {
    try {
      if (this._providers.getRcmStatus) {
        const status = this._providers.getRcmStatus();
        if (status && status.controllers) return status.controllers;
      }
    } catch (_) { /* unavailable */ }
    return [];
  }

  _readProfiles() {
    try {
      if (this._providers.getProfileManagerStatus) {
        const pm = this._providers.getProfileManagerStatus();
        if (pm && pm.enabled) {
          return {
            count: pm.profileCount || 0,
            active: pm.activeProfileId,
            demandSet: pm.demandSet || [],
            switchCount: pm.switchCount || 0,
          };
        }
      }
    } catch (_) { /* unavailable */ }
    return { count: 0, active: null, demandSet: [], switchCount: 0 };
  }

  _readAdaptive() {
    try {
      if (this._providers.getAdaptiveStatus) {
        const ae = this._providers.getAdaptiveStatus();
        if (ae && ae.enabled) {
          return {
            running: ae.running,
            activeProfileId: ae.activeProfileId,
            userOverrideProfileId: ae.userOverrideProfileId,
            transitionCount: ae.transitionManager ? ae.transitionManager.historySize : 0,
          };
        }
      }
    } catch (_) { /* unavailable */ }
    return { running: false, activeProfileId: null, userOverrideProfileId: null, transitionCount: 0 };
  }

  _readRecognition() {
    try {
      if (this._providers.getRecognitionStatus) {
        const re = this._providers.getRecognitionStatus();
        if (re && re.enabled) {
          return {
            running: re.running,
            ruleCount: re.recognizer ? re.recognizer.ruleCount : 0,
            demandedProfile: re.demandedProfile,
          };
        }
      }
    } catch (_) { /* unavailable */ }
    return { running: false, ruleCount: 0, demandedProfile: null };
  }

  _readPolicyEngine() {
    try {
      if (this._providers.getPolicyEngineStatus) {
        const pe = this._providers.getPolicyEngineStatus();
        if (pe) return pe;
      }
    } catch (_) { /* unavailable */ }
    return { running: false, ruleCount: 0 };
  }

  _readPlugins() {
    try {
      if (this._providers.getPluginNames) {
        return this._providers.getPluginNames();
      }
    } catch (_) { /* unavailable */ }
    return [];
  }

  _readEventBus() {
    try {
      if (this._providers.getBusStatus) {
        return this._providers.getBusStatus();
      }
    } catch (_) { /* unavailable */ }
    return { listeners: 0, activeEvents: [] };
  }

  _readMetrics() {
    try {
      if (this._providers.getMetricsSnapshot) {
        return this._providers.getMetricsSnapshot();
      }
    } catch (_) { /* unavailable */ }
    return {};
  }
}

module.exports = DiagnosticsEngine;
