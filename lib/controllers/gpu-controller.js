'use strict';

/**
 * GpuController — GPU power/performance management via profile presets.
 *
 * New resource domain (companion to Phase 2's Thermal/Power controllers).
 * Owns the GPU-profile abstraction that the Policy Engine uses to adjust
 * GPU power limits / performance level at runtime.
 *
 * Scope:
 *   - Detects the GPU vendor (nvidia | amd | intel | none) by reusing
 *     the same detection used for read-only awareness in `sensor.js`
 *     (`getGpuUtilization().type`), so vendor detection stays cached
 *     and consistent across the daemon.
 *   - Exposes applyProfile(name) which maps a profile name to a
 *     vendor-specific action:
 *       * NVIDIA: `nvidia-smi -pl <watts>` (power limit, clamped to the
 *         card's [min_limit, max_limit] range read via
 *         `nvidia-smi --query-gpu=power.min_limit,power.max_limit`).
 *       * AMD:    writes to
 *         `/sys/class/drm/card<N>/device/power_dpm_force_performance_level`
 *         (`low` | `auto` | `high`).
 *       * Intel:  no safe universal control surface exists for iGPU
 *         power/perf without vendor-specific tooling — isAvailable()
 *         returns false and applyProfile() is a documented no-op.
 *   - Read-only utilization stays owned by `sensor.js` /
 *     `getGpuUtilization()`; this controller only adds the write path.
 *
 * Profiles:
 *
 *   balanced    — factory/default behavior (NVIDIA: restore the
 *                 card's default power limit; AMD: 'auto')
 *   power-saver — cap power draw (NVIDIA: ~60% of max limit; AMD: 'low')
 *   performance — maximize power budget (NVIDIA: max limit; AMD: 'high')
 *
 * Snapshot/rollback:
 *
 *   applyProfile() captures the current state BEFORE mutation (the
 *   power limit in watts for NVIDIA, the sysfs value for AMD). On
 *   failure (unavailable controller, unknown profile, exec/sysfs
 *   error) no mutation occurs. restoreSnapshot() reverts the last
 *   applyProfile().
 *
 * Capability model:
 *
 *   isAvailable() returns true iff ENABLE_GPU_CONTROL is true in
 *   config AND the detected vendor is 'nvidia' or 'amd'. When false,
 *   applyProfile() is a no-op that returns
 *   { success: false, error: '...' } — it never throws.
 *
 * Security:
 *
 *   - NVIDIA calls use execFileSync with argument arrays (no shell,
 *     no string interpolation), optionally prefixed with `sudo -n`
 *     when GPU_USE_SUDO is true (same convention as
 *     GovernorManager._buildCommand in governor.js).
 *   - AMD sysfs writes are validated against a strict allowlist of
 *     values ('low' | 'auto' | 'high') before being written.
 *   - All actions are DRY_RUN aware — no syscalls happen when
 *     config.DRY_RUN is true.
 *
 * Backward compatibility: purely additive. Read-only GPU awareness
 * (`sensor.js#getGpuUtilization`, workload recognition's GPU-bound
 * classification) is completely untouched by this controller.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const ResourceController = require('../resource-controller');
const logger = require('../../logger');
const { debug, info, warn } = logger;

// ── Constants ────────────────────────────────────────────────────────

const VALID_PROFILES = Object.freeze(['balanced', 'power-saver', 'performance']);

// Fraction of the card's max power limit used for NVIDIA presets.
// "balanced" restores the card's own default_limit instead of a fraction.
const NVIDIA_POWER_SAVER_FRACTION = 0.6;

// AMD `power_dpm_force_performance_level` values per profile.
const AMD_PERF_LEVEL = Object.freeze({
  balanced: 'auto',
  'power-saver': 'low',
  performance: 'high',
});
const AMD_VALID_LEVELS = Object.freeze(['low', 'auto', 'high']);

const AMD_SYSFS_GLOB_BASE = '/sys/class/drm';

// ── GpuController class ──────────────────────────────────────────────

class GpuController extends ResourceController {
  constructor(deps) {
    super('gpu', deps);
    this._currentProfile = null;
    this._snapshot = null;
    this._vendor = null;       // cache: 'nvidia' | 'amd' | 'intel' | 'none' | null=unknown
    this._amdCardPath = null;  // cached sysfs path once resolved
    this._applyCount = 0;
  }

  /**
   * Available iff GPU control is enabled AND the detected vendor has
   * a supported write path (nvidia or amd). Intel and "none" are
   * read-only (awareness-only), same as pre-existing behavior.
   */
  isAvailable() {
    if (!this.config || !this.config.ENABLE_GPU_CONTROL) return false;
    const vendor = this._detectVendor();
    return vendor === 'nvidia' || vendor === 'amd';
  }

  /**
   * Apply a named GPU profile.
   *
   * @param {string} profileName — 'balanced' | 'power-saver' | 'performance'
   * @returns {{ success: boolean, error: string|null, profile: string|null, vendor: string|null, snapshot: object|null }}
   */
  applyProfile(profileName) {
    if (!this.isAvailable()) {
      return { success: false, error: 'GPU control disabled or unsupported vendor', profile: null, vendor: this._vendor, snapshot: null };
    }
    if (!VALID_PROFILES.includes(profileName)) {
      return { success: false, error: `unknown GPU profile "${profileName}"`, profile: null, vendor: this._vendor, snapshot: null };
    }

    const vendor = this._vendor;
    let result;
    if (vendor === 'nvidia') {
      result = this._applyNvidiaProfile(profileName);
    } else if (vendor === 'amd') {
      result = this._applyAmdProfile(profileName);
    } else {
      return { success: false, error: `unsupported GPU vendor "${vendor}"`, profile: null, vendor, snapshot: null };
    }

    if (result.success) {
      this._currentProfile = profileName;
      this._applyCount++;
      info(`GPU profile applied: ${profileName} (vendor=${vendor})`);
    } else {
      warn(`GpuController: failed to apply profile "${profileName}": ${result.error}`);
    }
    return { ...result, profile: result.success ? profileName : null, vendor };
  }

  /**
   * Restore the last captured snapshot (revert the last applyProfile).
   * @returns {boolean} true if snapshot was restored
   */
  restoreSnapshot() {
    if (!this._snapshot) return false;
    const vendor = this._vendor;
    try {
      if (vendor === 'nvidia' && typeof this._snapshot.powerLimitWatts === 'number') {
        this._setNvidiaPowerLimit(this._snapshot.powerLimitWatts);
      } else if (vendor === 'amd' && typeof this._snapshot.perfLevel === 'string') {
        this._writeAmdPerfLevel(this._snapshot.perfLevel);
      }
    } catch (err) {
      warn(`GpuController: restoreSnapshot failed: ${err.message}`);
      return false;
    }
    this._currentProfile = null;
    this._snapshot = null;
    debug('GPU: snapshot restored');
    return true;
  }

  getStatus() {
    const vendor = this._detectVendor();
    return {
      name: this.name,
      available: this.isAvailable(),
      vendor,
      currentProfile: this._currentProfile,
      applyCount: this._applyCount,
    };
  }

  // ── NVIDIA ───────────────────────────────────────────────────────

  _applyNvidiaProfile(profileName) {
    let targetWatts;
    let snapshotSource = null;
    try {
      const limits = this._queryNvidiaPowerLimits();
      if (!limits) {
        return { success: false, error: 'unable to read nvidia-smi power limits', snapshot: null };
      }
      snapshotSource = { powerLimitWatts: limits.current };

      if (profileName === 'balanced') {
        targetWatts = limits.default;
      } else if (profileName === 'power-saver') {
        targetWatts = Math.max(limits.min, Math.round(limits.max * NVIDIA_POWER_SAVER_FRACTION));
      } else {
        // performance
        targetWatts = limits.max;
      }
      // Clamp defensively to the reported [min, max] range.
      targetWatts = Math.min(limits.max, Math.max(limits.min, targetWatts));
    } catch (err) {
      return { success: false, error: err.message, snapshot: null };
    }

    this._snapshot = snapshotSource;
    try {
      this._setNvidiaPowerLimit(targetWatts);
      return { success: true, error: null, snapshot: snapshotSource };
    } catch (err) {
      this._snapshot = null;
      return { success: false, error: err.message, snapshot: null };
    }
  }

  /**
   * Read {min, max, default, current} power limits (watts) via nvidia-smi.
   * @returns {{min:number,max:number,default:number,current:number}|null}
   */
  _queryNvidiaPowerLimits() {
    if (this.isDryRun) {
      // Plausible placeholder values so DRY_RUN callers exercise the
      // full clamp/compute logic without touching hardware.
      return { min: 100, max: 350, default: 300, current: 300 };
    }
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=power.min_limit,power.max_limit,power.default_limit,power.limit',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const parts = out.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [min, max, def, current] = parts;
    return { min, max, default: def, current };
  }

  _setNvidiaPowerLimit(watts) {
    const rounded = Math.round(watts);
    const { cmd, args } = this._buildNvidiaCommand(rounded);
    if (this.isDryRun) {
      debug(`[DRY_RUN] would run: ${cmd} ${args.join(' ')}`);
      return;
    }
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
  }

  _buildNvidiaCommand(watts) {
    const nvArgs = ['-pl', String(watts)];
    if (this.config && this.config.GPU_USE_SUDO) {
      return { cmd: 'sudo', args: ['-n', 'nvidia-smi', ...nvArgs] };
    }
    return { cmd: 'nvidia-smi', args: nvArgs };
  }

  // ── AMD ──────────────────────────────────────────────────────────

  _applyAmdProfile(profileName) {
    const level = AMD_PERF_LEVEL[profileName];
    if (!AMD_VALID_LEVELS.includes(level)) {
      return { success: false, error: `no AMD mapping for profile "${profileName}"`, snapshot: null };
    }
    let cardPath;
    try {
      cardPath = this._resolveAmdCardPath();
    } catch (err) {
      return { success: false, error: err.message, snapshot: null };
    }
    if (!cardPath) {
      return { success: false, error: 'AMD power_dpm_force_performance_level sysfs path not found', snapshot: null };
    }

    let previous = null;
    try {
      previous = fs.readFileSync(cardPath, 'utf8').trim();
    } catch (_) {
      // Non-fatal: rollback just won't be able to restore a previous value.
    }
    this._snapshot = { perfLevel: previous };

    try {
      this._writeAmdPerfLevel(level, cardPath);
      return { success: true, error: null, snapshot: this._snapshot };
    } catch (err) {
      this._snapshot = null;
      return { success: false, error: err.message, snapshot: null };
    }
  }

  _writeAmdPerfLevel(level, cardPathArg) {
    if (!AMD_VALID_LEVELS.includes(level)) {
      throw new Error(`invalid AMD perf level "${level}"`);
    }
    const cardPath = cardPathArg || this._resolveAmdCardPath();
    if (!cardPath) throw new Error('AMD sysfs path not found');
    if (this.isDryRun) {
      debug(`[DRY_RUN] would write "${level}" to ${cardPath}`);
      return;
    }
    fs.writeFileSync(cardPath, level);
  }

  /**
   * Find the first `/sys/class/drm/card<N>/device/power_dpm_force_performance_level`
   * that exists and is writable-looking. Cached after first resolution.
   * @returns {string|null}
   */
  _resolveAmdCardPath() {
    if (this._amdCardPath) return this._amdCardPath;
    if (this.isDryRun) {
      this._amdCardPath = `${AMD_SYSFS_GLOB_BASE}/card0/device/power_dpm_force_performance_level`;
      return this._amdCardPath;
    }
    try {
      const entries = fs.readdirSync(AMD_SYSFS_GLOB_BASE);
      for (const entry of entries) {
        if (!/^card\d+$/.test(entry)) continue;
        const candidate = `${AMD_SYSFS_GLOB_BASE}/${entry}/device/power_dpm_force_performance_level`;
        try {
          fs.accessSync(candidate, fs.constants.F_OK);
          this._amdCardPath = candidate;
          return candidate;
        } catch (_) { /* try next card */ }
      }
    } catch (_) { /* /sys/class/drm unavailable */ }
    return null;
  }

  // ── Vendor detection ──────────────────────────────────────────────

  /**
   * Detect the GPU vendor, reusing the same probe order used by
   * `sensor.js#getGpuUtilization` so results stay consistent with
   * read-only awareness elsewhere in the daemon. Cached after first call.
   * @returns {'nvidia'|'amd'|'intel'|'none'}
   */
  _detectVendor() {
    if (this._vendor !== null) return this._vendor;
    try {
      const sensor = require('../../sensor');
      this._vendor = sensor.getGpuUtilization().type;
    } catch (_) {
      this._vendor = 'none';
    }
    return this._vendor;
  }
}

module.exports = GpuController;
module.exports.VALID_PROFILES = VALID_PROFILES;
module.exports.AMD_PERF_LEVEL = AMD_PERF_LEVEL;
