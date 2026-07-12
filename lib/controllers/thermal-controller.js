'use strict';

/**
 * ThermalController — thermal management via config-driven profile presets.
 *
 * Phase 2 (Resource Controller Foundation). Owns the thermal-profile
 * abstraction that the Policy Engine uses to adjust the daemon's
 * thermal behavior at runtime.
 *
 * Scope:
 *   - Holds a reference to the global CONFIG object (mutable —
 *     profile switches adjust THERMAL_PAUSE_THRESHOLD,
 *     THERMAL_PAUSE_DURATION_MS, THERMAL_RESUME_THRESHOLD in-place).
 *   - Exposes applyProfile(name) which maps a profile name to a set
 *     of config overrides.
 *   - Exposes pause()/resume()/isPaused() for explicit control
 *     (independent of the daemon's auto-pause logic).
 *   - Does NOT own the actual governor-boost-skipping logic — that
 *     stays in daemon.js (which reads CONFIG.THERMAL_PAUSE_THRESHOLD
 *     etc.). This controller only adjusts the config values.
 *
 * Profiles:
 *
 *   balanced  — factory defaults (THERMAL_PAUSE_THRESHOLD=85,
 *               THERMAL_PAUSE_DURATION_MS=30000, THERMAL_RESUME_THRESHOLD=75)
 *   cool      — more aggressive (threshold=75, duration=45000, resume=65)
 *   silent    — maximum protection (threshold=65, duration=60000, resume=55)
 *
 * The "balanced" preset reads from DEFAULT_CONFIG so it always
 * restores factory values, not whatever CONFIG happens to hold.
 *
 * Snapshot/rollback:
 *
 *   applyProfile() captures the current config values BEFORE
 *   mutation. On failure (invalid profile name), it returns
 *   { success: false } without touching config. The caller can
 *   also call restoreSnapshot() to revert to the captured values.
 *
 * Capability model:
 *
 *   isAvailable() returns true iff ENABLE_THERMAL_PROTECTION is true
 *   in config. When false, applyProfile() is a no-op that returns
 *   { success: false, error: 'thermal protection disabled' }.
 *
 * Backward compatibility: this controller does NOT change the
 * daemon's existing thermal pause logic. It only provides a
 * Policy-Engine-facing API for adjusting the config values that
 * the daemon's logic reads.
 */

const ResourceController = require('../resource-controller');
const logger = require('../../logger');
const { debug, info, warn } = logger;

// ── Constants ────────────────────────────────────────────────────────

const VALID_PROFILES = Object.freeze(['balanced', 'cool', 'silent']);

// Profile presets. Values are applied to CONFIG in-place.
// "balanced" uses DEFAULT_CONFIG values (factory reset).
const PROFILE_PRESETS = Object.freeze({
  balanced: { source: 'defaults' },
  cool: {
    THERMAL_PAUSE_THRESHOLD: 75,
    THERMAL_PAUSE_DURATION_MS: 45000,
    THERMAL_RESUME_THRESHOLD: 65,
  },
  silent: {
    THERMAL_PAUSE_THRESHOLD: 65,
    THERMAL_PAUSE_DURATION_MS: 60000,
    THERMAL_RESUME_THRESHOLD: 55,
  },
});

// ── ThermalController class ──────────────────────────────────────────

class ThermalController extends ResourceController {
  constructor(deps) {
    super('thermal', deps);
    this._currentProfile = null;
    this._snapshot = null;
    this._manualPauseUntil = 0;  // timestamp (ms) for explicit pause()
    this._manualPauseCount = 0;
  }

  isAvailable() {
    return !!(this.config && this.config.ENABLE_THERMAL_PROTECTION);
  }

  /**
   * Apply a named thermal profile. Adjusts CONFIG in-place.
   *
   * @param {string} profileName — 'balanced' | 'cool' | 'silent'
   * @returns {{ success: boolean, error: string|null, profile: string, snapshot: object|null }}
   */
  applyProfile(profileName) {
    if (!this.isAvailable()) {
      return { success: false, error: 'thermal protection disabled', profile: null, snapshot: null };
    }
    if (!VALID_PROFILES.includes(profileName)) {
      return { success: false, error: `unknown thermal profile "${profileName}"`, profile: null, snapshot: null };
    }

    // Capture snapshot BEFORE mutation (for rollback)
    const snapshot = this._captureSnapshot();
    this._snapshot = snapshot;

    const preset = PROFILE_PRESETS[profileName];
    if (preset.source === 'defaults') {
      // Restore factory values from DEFAULT_CONFIG
      const defaults = this._getDefaults();
      this.config.THERMAL_PAUSE_THRESHOLD = defaults.THERMAL_PAUSE_THRESHOLD;
      this.config.THERMAL_PAUSE_DURATION_MS = defaults.THERMAL_PAUSE_DURATION_MS;
      this.config.THERMAL_RESUME_THRESHOLD = defaults.THERMAL_RESUME_THRESHOLD;
    } else {
      this.config.THERMAL_PAUSE_THRESHOLD = preset.THERMAL_PAUSE_THRESHOLD;
      this.config.THERMAL_PAUSE_DURATION_MS = preset.THERMAL_PAUSE_DURATION_MS;
      this.config.THERMAL_RESUME_THRESHOLD = preset.THERMAL_RESUME_THRESHOLD;
    }

    this._currentProfile = profileName;
    info(`Thermal profile applied: ${profileName} (threshold=${this.config.THERMAL_PAUSE_THRESHOLD}°C, duration=${this.config.THERMAL_PAUSE_DURATION_MS}ms, resume=${this.config.THERMAL_RESUME_THRESHOLD}°C)`);

    return { success: true, error: null, profile: profileName, snapshot };
  }

  /**
   * Explicitly pause thermal-governor boosting for a duration.
   * This is INDEPENDENT of the daemon's auto-pause logic — both
   * can be active simultaneously. The daemon's isThermalPaused()
   * checks its own State.thermalPausedUntil; this controller's
   * isPaused() checks _manualPauseUntil. Callers that want to
   * respect BOTH should check both.
   *
   * @param {number} durationMs — pause duration in milliseconds
   * @returns {{ success: boolean, pausedUntil: number }}
   */
  pause(durationMs) {
    if (!this.isAvailable()) {
      return { success: false, pausedUntil: 0 };
    }
    if (typeof durationMs !== 'number' || durationMs < 1000 || durationMs > 600000) {
      return { success: false, pausedUntil: 0 };
    }
    const now = Date.now();
    this._manualPauseUntil = now + durationMs;
    this._manualPauseCount++;
    info(`Thermal: manual pause for ${durationMs}ms (until ${new Date(this._manualPauseUntil).toISOString()})`);
    return { success: true, pausedUntil: this._manualPauseUntil };
  }

  /**
   * Clear the manual pause.
   */
  resume() {
    if (this._manualPauseUntil > 0) {
      debug('Thermal: manual pause cleared');
    }
    this._manualPauseUntil = 0;
  }

  /**
   * Whether the manual pause is currently active.
   * (Does NOT reflect the daemon's auto-pause state.)
   */
  isPaused() {
    return Date.now() < this._manualPauseUntil;
  }

  /**
   * Restore the last captured snapshot (revert the last applyProfile).
   * @returns {boolean} true if snapshot was restored
   */
  restoreSnapshot() {
    if (!this._snapshot) return false;
    this.config.THERMAL_PAUSE_THRESHOLD = this._snapshot.THERMAL_PAUSE_THRESHOLD;
    this.config.THERMAL_PAUSE_DURATION_MS = this._snapshot.THERMAL_PAUSE_DURATION_MS;
    this.config.THERMAL_RESUME_THRESHOLD = this._snapshot.THERMAL_RESUME_THRESHOLD;
    this._currentProfile = null;
    this._snapshot = null;
    debug('Thermal: snapshot restored');
    return true;
  }

  /**
   * Get the DEFAULT_CONFIG (cached). Used by the "balanced" preset
   * to restore factory values rather than the current (possibly
   * already-mutated) values.
   */
  _getDefaults() {
    if (!this._defaultsCache) {
      try {
        this._defaultsCache = require('../../config').DEFAULT_CONFIG;
      } catch (_) {
        // Fallback: use current config values as "defaults"
        this._defaultsCache = this.config;
      }
    }
    return this._defaultsCache;
  }

  _captureSnapshot() {
    return {
      THERMAL_PAUSE_THRESHOLD: this.config.THERMAL_PAUSE_THRESHOLD,
      THERMAL_PAUSE_DURATION_MS: this.config.THERMAL_PAUSE_DURATION_MS,
      THERMAL_RESUME_THRESHOLD: this.config.THERMAL_RESUME_THRESHOLD,
    };
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      currentProfile: this._currentProfile,
      manualPauseActive: this.isPaused(),
      manualPauseUntil: this._manualPauseUntil > 0 ? this._manualPauseUntil : null,
      manualPauseCount: this._manualPauseCount,
      config: {
        THERMAL_PAUSE_THRESHOLD: this.config.THERMAL_PAUSE_THRESHOLD,
        THERMAL_PAUSE_DURATION_MS: this.config.THERMAL_PAUSE_DURATION_MS,
        THERMAL_RESUME_THRESHOLD: this.config.THERMAL_RESUME_THRESHOLD,
      },
    };
  }
}

module.exports = ThermalController;
module.exports.VALID_PROFILES = VALID_PROFILES;
module.exports.PROFILE_PRESETS = PROFILE_PRESETS;
