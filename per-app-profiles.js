'use strict';

/**
 * DynAlloc — Per-App Profile Overrides (v2.1.10)
 * ===============================================
 *
 * Loads override files from PER_APP_PROFILES_DIR (default:
 * ~/.config/dynalloc/apps.d/). Each JSON file defines a custom scheduler
 * class, nice, and/or io priority for a specific process name.
 *
 * File format (e.g. apps.d/firefox.json):
 *   {
 *     "name": "firefox",
 *     "schedClass": "INTERACTIVE",
 *     "nice": -3,
 *     "ioClass": 1,
 *     "ioLevel": 4,
 *     "protect": true
 *   }
 *
 * When the scheduler classifies a process, it checks per-app profiles
 * first. If a profile matches the process name (or comm), the profile's
 * settings override the default classification.
 *
 * Hot-reload: files are re-read on every call to getProfile() (with a
 * 5-second cache to avoid excessive disk I/O).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const { debug, info, warn } = logger;

class PerAppProfiles {
  constructor(config) {
    this._config = config;
    this._profiles = new Map();   // name -> profile object
    this._lastLoadTime = 0;
    this._loadIntervalMs = 5000;  // re-read dir every 5s max
    this._dir = config.PER_APP_PROFILES_DIR ||
      path.join(os.homedir() || '', '.config', 'dynalloc', 'apps.d');
  }

  /**
   * Get the override profile for a process name.
   * Returns null if no profile matches.
   */
  getProfile(comm) {
    if (!this._config.ENABLE_PER_APP_PROFILES) return null;
    if (typeof comm !== 'string' || comm.length === 0) return null;

    this._maybeReload();
    return this._profiles.get(comm) || null;
  }

  /**
   * Check if a process name has a "protect" override (should never be throttled).
   */
  isProtected(comm) {
    const profile = this.getProfile(comm);
    return profile ? !!profile.protect : false;
  }

  /**
   * Get override scheduler class for a process name.
   * Returns null if no override.
   */
  getOverrideSchedClass(comm) {
    const profile = this.getProfile(comm);
    if (!profile) return null;
    return profile.schedClass || null;
  }

  /**
   * Get override nice value for a process name.
   * Returns null if no override.
   */
  getOverrideNice(comm) {
    const profile = this.getProfile(comm);
    if (!profile) return null;
    return typeof profile.nice === 'number' ? profile.nice : null;
  }

  /**
   * Reload profiles from disk if the cache is stale.
   */
  _maybeReload() {
    const now = Date.now();
    if (now - this._lastLoadTime < this._loadIntervalMs) return;
    this._lastLoadTime = now;
    this._load();
  }

  /**
   * Force reload profiles from disk.
   */
  reload() {
    this._lastLoadTime = Date.now();
    this._load();
  }

  _load() {
    this._profiles.clear();
    if (!fs.existsSync(this._dir)) {
      debug(`Per-app profiles dir not found: ${this._dir}`);
      return;
    }
    let files;
    try {
      files = fs.readdirSync(this._dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      warn(`Per-app profiles: cannot read dir ${this._dir}: ${err.message}`);
      return;
    }
    let loaded = 0;
    for (const file of files) {
      const filePath = path.join(this._dir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const profile = JSON.parse(raw);
        if (!profile || typeof profile.name !== 'string') {
          warn(`Per-app profile ${file}: missing "name" field, skipped`);
          continue;
        }
        // Validate fields
        const valid = {
          name: profile.name,
          schedClass: typeof profile.schedClass === 'string' ? profile.schedClass : undefined,
          nice: typeof profile.nice === 'number' ? profile.nice : undefined,
          ioClass: typeof profile.ioClass === 'number' ? profile.ioClass : undefined,
          ioLevel: typeof profile.ioLevel === 'number' ? profile.ioLevel : undefined,
          protect: !!profile.protect,
        };
        this._profiles.set(valid.name, valid);
        loaded++;
        debug(`Per-app profile loaded: ${valid.name} from ${file}`);
      } catch (err) {
        warn(`Per-app profile ${file}: parse error: ${err.message}`);
      }
    }
    if (loaded > 0) {
      info(`Per-app profiles: ${loaded} profile(s) loaded from ${this._dir}`);
    }
  }

  get profileCount() {
    return this._profiles.size;
  }

  get profiles() {
    return Array.from(this._profiles.keys());
  }
}

module.exports = { PerAppProfiles };
