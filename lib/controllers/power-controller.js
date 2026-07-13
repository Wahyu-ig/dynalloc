'use strict';

/**
 * PowerController — power management via profile presets + PPD coordination.
 *
 * Phase 2 (Resource Controller Foundation). Owns the power-profile
 * abstraction that the Policy Engine uses to adjust the daemon's
 * power behavior at runtime.
 *
 * Scope:
 *   - Holds a reference to the global CONFIG object (mutable —
 *     profile switches adjust FOREGROUND_CPU_WEIGHT,
 *     BACKGROUND_CPU_WEIGHT, ENABLE_GOVERNOR_SWITCH in-place).
 *   - Exposes applyProfile(name) which maps a profile name to a set
 *     of config overrides.
 *   - Exposes setPpdProfile(name) which sets the power-profiles-daemon
 *     ActiveProfile via gdbus (when PPD is running).
 *   - Exposes getPpdProfile() which reads the current PPD profile.
 *
 * Profiles:
 *
 *   balanced    — factory defaults
 *   power-saver — lower background CPU weight (10 instead of 20),
 *                  disable governor switching (let PPD manage it)
 *   performance — raise foreground CPU weight (1000 instead of 800),
 *                  enable governor switching if not PPD-coordinated
 *
 * The "balanced" preset reads from DEFAULT_CONFIG so it always
 * restores factory values.
 *
 * PPD coordination:
 *
 *   When PPD is detected as running, setPpdProfile() can be used to
 *   switch the system-wide PPD profile (power-saver / balanced /
 *   performance). This uses `gdbus call --system` with an argument
 *   array — no shell, no string interpolation.
 *
 *   When PPD is NOT running, setPpdProfile() returns
 *   { success: false, error: 'PPD not available' }.
 *
 * Snapshot/rollback:
 *
 *   applyProfile() captures config values BEFORE mutation. On failure,
 *   no mutation occurs. restoreSnapshot() reverts the last applyProfile.
 *
 * Capability model:
 *
 *   isAvailable() returns true always — the controller can always
 *   adjust Dynalloc's own config. PPD-specific methods check PPD
 *   availability separately.
 *
 * Security:
 *
 *   - All gdbus calls use execFileSync with argument arrays.
 *   - PPD profile names validated against a strict allowlist
 *     (power-saver / balanced / performance).
 *   - No shell invocation, no string interpolation into commands.
 *
 * Backward compatibility: this controller does NOT change the
 * daemon's existing PPD detection or governor-coordination logic.
 * It only provides a Policy-Engine-facing API.
 */

const ResourceController = require('../resource-controller');
const { execFileSync } = require('child_process');
const logger = require('../../logger');
const { debug, info, warn } = logger;

// ── Constants ────────────────────────────────────────────────────────

const VALID_PROFILES = Object.freeze(['balanced', 'power-saver', 'performance']);

const VALID_PPD_PROFILES = Object.freeze(['power-saver', 'balanced', 'performance']);

// Profile presets. "balanced" uses DEFAULT_CONFIG values (factory reset).
const PROFILE_PRESETS = Object.freeze({
  balanced: { source: 'defaults' },
  'power-saver': {
    FOREGROUND_CPU_WEIGHT: 600,   // slightly lower than default 800
    BACKGROUND_CPU_WEIGHT: 10,    // lower than default 20
    ENABLE_GOVERNOR_SWITCH: false, // let PPD / kernel manage
  },
  performance: {
    FOREGROUND_CPU_WEIGHT: 1000,  // higher than default 800
    BACKGROUND_CPU_WEIGHT: 20,    // default
    ENABLE_GOVERNOR_SWITCH: true,
  },
});

// PPD DBus interface constants
const PPD_BUS = 'system';
const PPD_DEST = 'net.hadess.PowerProfiles';
const PPD_PATH = '/net/hadess/PowerProfiles';
const PPD_IFACE = 'net.hadess.PowerProfiles';

// ── PowerController class ────────────────────────────────────────────

class PowerController extends ResourceController {
  constructor(deps) {
    super('power', deps);
    this._currentProfile = null;
    this._snapshot = null;
    this._ppdAvailable = null;  // cached: true/false/null=unknown
    this._lastPpdProfile = null;
    this._ppdSetCount = 0;
  }

  isAvailable() {
    // Always available — can adjust Dynalloc's own config regardless
    // of PPD. PPD-specific methods check PPD availability separately.
    return true;
  }

  /**
   * Apply a named power profile. Adjusts CONFIG in-place.
   *
   * @param {string} profileName — 'balanced' | 'power-saver' | 'performance'
   * @returns {{ success: boolean, error: string|null, profile: string, snapshot: object|null }}
   */
  applyProfile(profileName) {
    if (!VALID_PROFILES.includes(profileName)) {
      return { success: false, error: `unknown power profile "${profileName}"`, profile: null, snapshot: null };
    }

    const snapshot = this._captureSnapshot();
    this._snapshot = snapshot;

    const preset = PROFILE_PRESETS[profileName];
    if (preset.source === 'defaults') {
      const defaults = this._getDefaults();
      this.config.FOREGROUND_CPU_WEIGHT = defaults.FOREGROUND_CPU_WEIGHT;
      this.config.BACKGROUND_CPU_WEIGHT = defaults.BACKGROUND_CPU_WEIGHT;
      this.config.ENABLE_GOVERNOR_SWITCH = defaults.ENABLE_GOVERNOR_SWITCH;
    } else {
      this.config.FOREGROUND_CPU_WEIGHT = preset.FOREGROUND_CPU_WEIGHT;
      this.config.BACKGROUND_CPU_WEIGHT = preset.BACKGROUND_CPU_WEIGHT;
      if (preset.ENABLE_GOVERNOR_SWITCH !== undefined) {
        this.config.ENABLE_GOVERNOR_SWITCH = preset.ENABLE_GOVERNOR_SWITCH;
      }
    }

    this._currentProfile = profileName;
    info(`Power profile applied: ${profileName} (fg_weight=${this.config.FOREGROUND_CPU_WEIGHT}, bg_weight=${this.config.BACKGROUND_CPU_WEIGHT}, governor_switch=${this.config.ENABLE_GOVERNOR_SWITCH})`);

    return { success: true, error: null, profile: profileName, snapshot };
  }

  /**
   * Set the system-wide PPD profile via gdbus.
   *
   * @param {string} profileName — 'power-saver' | 'balanced' | 'performance'
   * @returns {{ success: boolean, error: string|null, profile: string|null }}
   */
  setPpdProfile(profileName) {
    if (!VALID_PPD_PROFILES.includes(profileName)) {
      return { success: false, error: `invalid PPD profile "${profileName}"`, profile: null };
    }
    if (!this._isPpdAvailable()) {
      return { success: false, error: 'PPD not available', profile: null };
    }
    if (this.isDryRun) {
      debug(`[DRY_RUN] would set PPD profile to "${profileName}"`);
      this._lastPpdProfile = profileName;
      return { success: true, error: null, profile: profileName };
    }
    try {
      execFileSync('gdbus', [
        'call', '--system',
        '--dest', PPD_DEST,
        '--object-path', PPD_PATH,
        '--method', `${PPD_IFACE}.HoldProfile`,
        profileName,
      ], { stdio: 'ignore', timeout: 3000 });
      this._lastPpdProfile = profileName;
      this._ppdSetCount++;
      info(`PPD profile set: ${profileName}`);
      return { success: true, error: null, profile: profileName };
    } catch (err) {
      warn(`PowerController: failed to set PPD profile "${profileName}": ${err.message}`);
      return { success: false, error: err.message, profile: null };
    }
  }

  /**
   * Read the current PPD profile.
   *
   * @returns {{ available: boolean, profile: string|null }}
   */
  getPpdProfile() {
    if (!this._isPpdAvailable()) {
      return { available: false, profile: null };
    }
    if (this.isDryRun) {
      return { available: true, profile: this._lastPpdProfile || 'balanced' };
    }
    try {
      const out = execFileSync('gdbus', [
        'call', '--system',
        '--dest', PPD_DEST,
        '--object-path', PPD_PATH,
        '--method', 'org.freedesktop.DBus.Properties.Get',
        PPD_IFACE, 'ActiveProfile',
      ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const match = out.match(/<["']([^"']+)["']>/);
      if (match) {
        this._lastPpdProfile = match[1];
        return { available: true, profile: match[1] };
      }
      return { available: true, profile: 'unknown' };
    } catch (_) {
      return { available: false, profile: null };
    }
  }

  /**
   * Restore the last captured snapshot (revert the last applyProfile).
   * @returns {boolean} true if snapshot was restored
   */
  restoreSnapshot() {
    if (!this._snapshot) return false;
    this.config.FOREGROUND_CPU_WEIGHT = this._snapshot.FOREGROUND_CPU_WEIGHT;
    this.config.BACKGROUND_CPU_WEIGHT = this._snapshot.BACKGROUND_CPU_WEIGHT;
    this.config.ENABLE_GOVERNOR_SWITCH = this._snapshot.ENABLE_GOVERNOR_SWITCH;
    this._currentProfile = null;
    this._snapshot = null;
    debug('Power: snapshot restored');
    return true;
  }

  /**
   * Check if PPD is available (cached). Probes once on first call.
   * @returns {boolean}
   * @private
   */
  _isPpdAvailable() {
    if (this._ppdAvailable !== null) return this._ppdAvailable;
    if (this.isDryRun) {
      // In DRY_RUN, assume PPD is available so the code path can be tested.
      this._ppdAvailable = true;
      return true;
    }
    try {
      execFileSync('gdbus', [
        'call', '--system',
        '--dest', PPD_DEST,
        '--object-path', PPD_PATH,
        '--method', 'org.freedesktop.DBus.Properties.Get',
        PPD_IFACE, 'ActiveProfile',
      ], { stdio: 'ignore', timeout: 2000 });
      this._ppdAvailable = true;
    } catch (_) {
      this._ppdAvailable = false;
    }
    return this._ppdAvailable;
  }

  _getDefaults() {
    if (!this._defaultsCache) {
      try {
        this._defaultsCache = require('../../config').DEFAULT_CONFIG;
      } catch (_) {
        this._defaultsCache = this.config;
      }
    }
    return this._defaultsCache;
  }

  _captureSnapshot() {
    return {
      FOREGROUND_CPU_WEIGHT: this.config.FOREGROUND_CPU_WEIGHT,
      BACKGROUND_CPU_WEIGHT: this.config.BACKGROUND_CPU_WEIGHT,
      ENABLE_GOVERNOR_SWITCH: this.config.ENABLE_GOVERNOR_SWITCH,
    };
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      currentProfile: this._currentProfile,
      ppdAvailable: this._isPpdAvailable(),
      lastPpdProfile: this._lastPpdProfile,
      ppdSetCount: this._ppdSetCount,
      config: {
        FOREGROUND_CPU_WEIGHT: this.config.FOREGROUND_CPU_WEIGHT,
        BACKGROUND_CPU_WEIGHT: this.config.BACKGROUND_CPU_WEIGHT,
        ENABLE_GOVERNOR_SWITCH: this.config.ENABLE_GOVERNOR_SWITCH,
      },
    };
  }
}

module.exports = PowerController;
module.exports.VALID_PROFILES = VALID_PROFILES;
module.exports.VALID_PPD_PROFILES = VALID_PPD_PROFILES;
module.exports.PROFILE_PRESETS = PROFILE_PRESETS;
