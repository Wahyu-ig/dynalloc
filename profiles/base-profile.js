'use strict';

/**
 * DynAlloc — Profile Layer :: Base Profile
 * ==========================================
 *
 * Abstract base class for all profiles.
 *
 * A Profile is a named, versioned declaration of resource settings
 * that the Resource Controller Layer can apply. Profiles are PURE
 * DATA + LIFECYCLE HOOKS — they do not call the RCM directly. The
 * ProfileManager reads a profile's `settings` and routes them to
 * the appropriate controller.
 *
 * Profile shape:
 *
 *   {
 *     id: 'gaming',                    // unique identifier (kebab-case)
 *     version: '1.0.0',                // semver
 *     description: 'Gaming profile',   // human-readable
 *     priority: 100,                   // higher = wins conflicts (0-1000)
 *     inherits: ['performance'],       // optional parent profile IDs
 *     overrides: {                     // optional per-domain overrides
 *       thermal: { profile: 'cool' },
 *       power: { profile: 'performance' },
 *     },
 *     settings: {                      // the actual resource settings
 *       thermal: { profile: 'balanced' },
 *       power: { profile: 'performance' },
 *       scheduler: { mode: 'aggressive' },
 *       governor: { governor: 'performance', cores: 'foreground' },
 *     },
 *     metadata: {                      // optional free-form metadata
 *       author: 'dynalloc',
 *       tags: ['game', 'interactive'],
 *     },
 *   }
 *
 * Lifecycle:
 *
 *   The ProfileManager calls:
 *     - onActivate(context)   before applying settings
 *     - onDeactivate(context) before restoring previous profile
 *   Default implementations are no-ops. Subclasses (rare) can override.
 *
 * Inheritance:
 *
 *   A profile may declare `inherits: ['parent-id', ...]`. The registry
 *   resolves inheritance by deep-merging parent settings first, then
 *   the child's own settings on top. Circular inheritance is rejected
 *   at load time.
 *
 * Priority & conflict resolution:
 *
 *   Each profile has a `priority` (0-1000, default 100). When multiple
 *   profiles are simultaneously active (e.g. gaming + battery-saver),
 *   the ProfileManager picks the one with the highest priority. Ties
 *   are broken by registration order (first registered wins).
 *
 * Versioning:
 *
 *   The `version` field is semver. The registry rejects duplicate IDs
 *   with the same version. Loading a new version of an existing profile
 *   replaces the old one (with a warning).
 *
 * Backward compatibility: this module is only required when
 * ENABLE_PROFILE_MANAGER is true.
 */

const VALID_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const VALID_VERSION_RE = /^\d+\.\d+\.\d+$/;

class Profile {
  /**
   * @param {object} def - raw profile definition (from JSON/YAML or code)
   */
  constructor(def) {
    this._validate(def);
    this._def = Object.freeze({ ...def });
    this._settings = null;        // resolved (inheritance applied), lazy
    this._activeSince = null;     // timestamp when activated
  }

  // ── Accessors ────────────────────────────────────────────────────

  get id() { return this._def.id; }
  get version() { return this._def.version; }
  get description() { return this._def.description || ''; }
  get priority() { return this._def.priority; }
  get inherits() { return this._def.inherits || []; }
  get overrides() { return this._def.overrides || {}; }
  get metadata() { return this._def.metadata || {}; }
  get definition() { return this._def; }

  /**
   * Resolved settings (with inheritance applied). Set by the registry
   * after all parents are resolved.
   */
  get settings() { return this._settings || this._def.settings || {}; }

  setResolvedSettings(settings) {
    this._settings = Object.freeze({ ...settings });
  }

  // ── Lifecycle hooks (subclasses may override) ────────────────────

  /**
   * Called by the ProfileManager before applying this profile's settings.
   * Default: no-op. Subclasses can use this to capture snapshots,
   * emit events, or veto activation (by returning false).
   *
   * @param {object} context - { manager, rcm, bus, stateStore, logger }
   * @returns {boolean} true to proceed, false to veto
   */
  onActivate(_context) { return true; }

  /**
   * Called by the ProfileManager after deactivating this profile.
   * Default: no-op.
   *
   * @param {object} context - { manager, rcm, bus, stateStore, logger }
   */
  onDeactivate(_context) {}

  // ── Activation state ─────────────────────────────────────────────

  get isActive() { return this._activeSince !== null; }
  get activeSince() { return this._activeSince; }

  _markActive() { this._activeSince = Date.now(); }
  _markInactive() { this._activeSince = null; }

  // ── Validation ───────────────────────────────────────────────────

  _validate(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      throw new Error('Profile: definition must be an object');
    }
    if (typeof def.id !== 'string' || !VALID_ID_RE.test(def.id)) {
      throw new Error(`Profile: invalid id "${def.id}" (must be kebab-case, max 64 chars)`);
    }
    if (typeof def.version !== 'string' || !VALID_VERSION_RE.test(def.version)) {
      throw new Error(`Profile: invalid version "${def.version}" (must be semver X.Y.Z)`);
    }
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`Profile "${def.id}": description must be a string`);
    }
    const priority = def.priority;
    if (priority !== undefined) {
      if (typeof priority !== 'number' || !Number.isInteger(priority) ||
          priority < 0 || priority > 1000) {
        throw new Error(`Profile "${def.id}": priority must be an integer 0-1000`);
      }
    }
    if (def.inherits !== undefined) {
      if (!Array.isArray(def.inherits) ||
          !def.inherits.every((s) => typeof s === 'string' && VALID_ID_RE.test(s))) {
        throw new Error(`Profile "${def.id}": inherits must be an array of valid profile IDs`);
      }
    }
    if (def.overrides !== undefined) {
      if (typeof def.overrides !== 'object' || def.overrides === null || Array.isArray(def.overrides)) {
        throw new Error(`Profile "${def.id}": overrides must be an object`);
      }
    }
    if (def.settings !== undefined) {
      if (typeof def.settings !== 'object' || def.settings === null || Array.isArray(def.settings)) {
        throw new Error(`Profile "${def.id}": settings must be an object`);
      }
    }
    if (def.metadata !== undefined) {
      if (typeof def.metadata !== 'object' || def.metadata === null || Array.isArray(def.metadata)) {
        throw new Error(`Profile "${def.id}": metadata must be an object`);
      }
    }
  }

  /**
   * Return a plain-object representation (for IPC / status).
   */
  toJSON() {
    return {
      id: this.id,
      version: this.version,
      description: this.description,
      priority: this.priority,
      inherits: this.inherits,
      settings: this.settings,
      metadata: this.metadata,
      isActive: this.isActive,
      activeSince: this._activeSince ? new Date(this._activeSince).toISOString() : null,
    };
  }
}

Profile.DEFAULT_PRIORITY = 100;
Profile.VALID_ID_RE = VALID_ID_RE;
Profile.VALID_VERSION_RE = VALID_VERSION_RE;

module.exports = Profile;
