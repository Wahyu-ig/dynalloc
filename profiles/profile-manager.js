'use strict';

/**
 * DynAlloc — Profile Layer :: Profile Manager
 * ============================================
 *
 * The decision layer between the Detector Layer and the Resource
 * Controller Layer. Subscribes to detector events on the bus,
 * evaluates which profile should be active based on a deterministic
 * priority system, and instructs the ResourceControllerManager to
 * apply the winning profile's resource settings.
 *
 * Architecture:
 *
 *   User Events
 *       ↓
 *   Detector Layer (Phase 1)
 *       ↓
 *   Event Bus
 *       ↓
 *   Profile Manager  ←── THIS MODULE (Phase 3)
 *       ↓
 *   Resource Controller (Phase 2)
 *       ↓
 *   Operating System
 *
 * Event-driven (no polling):
 *
 *   The manager subscribes to bus events emitted by the Detector
 *   Layer. It NEVER polls. Profile changes occur only when relevant
 *   events are received:
 *
 *     onWorkloadDetected   → activate workload profile (game/ide/browser/...)
 *     onPowerStateChanged  → activate power profile (battery-saver on low)
 *     onIdleStateChanged   → activate idle profile after timeout
 *
 * Conflict resolution (deterministic):
 *
 *   When multiple profiles are simultaneously "wanted" (e.g. gaming
 *   detector says GAME, battery detector says BATTERY_SAVER), the
 *   manager picks the one with the highest `priority` field. Ties
 *   are broken by registration order (first registered wins).
 *
 *   The manager maintains a "demand set" — a map of source → profileId.
 *   Each detector can demand one profile at a time. When a detector
 *   withdraws its demand (e.g. idle ends), the entry is removed. The
 *   active profile is always the highest-priority entry in the demand
 *   set, or 'balanced' (the default) if the set is empty.
 *
 * Idle timeout:
 *
 *   When the IdleStateDetector emits onIdle, the manager waits
 *   PROFILE_IDLE_TIMEOUT_MS (default 300000 = 5 min) before activating
 *   the idle profile. This prevents flicker on brief idle moments.
 *   When onIdleEnd is received, the timeout is cancelled.
 *
 * Rollback:
 *
 *   When a profile is deactivated, the manager activates the next-highest-
 *   priority profile in the demand set, or 'balanced' if empty. The
 *   ResourceControllerManager's controllers have their own snapshot/
 *   rollback for individual settings; the manager only decides WHICH
 *   profile to apply, not HOW.
 *
 * Backward compatibility: only constructed when ENABLE_PROFILE_MANAGER
 * is true. When false, the PE's existing applyProfile action continues
 * to work independently (it calls the RCM directly).
 */

const logger = require('../logger');
const { info, warn, debug } = logger;
const ProfileRegistry = require('./profile-registry');
const { createBuiltinProfiles } = require('./builtin-profiles');

// ── Constants ────────────────────────────────────────────────────────

// Workload classification → profile ID mapping
const WORKLOAD_TO_PROFILE = Object.freeze({
  GAME: 'gaming',
  IDE: 'development',
  BROWSER: 'balanced',         // browsers don't need a special profile
  RENDERER: 'rendering',
  VIRTUALIZATION: 'balanced',
  COMPILER: 'development',
  MULTIMEDIA: 'streaming',
  COMMUNICATION: 'balanced',
  UNKNOWN: 'balanced',
  NONE: null,                  // no foreground → no workload demand
});

// Power state → profile ID mapping
const POWER_TO_PROFILE = Object.freeze({
  AC: null,                    // no special profile on AC
  CHARGING: null,
  BATTERY: null,               // normal battery → balanced (default)
  BATTERY_LOW: 'battery-saver',
  BATTERY_CRITICAL: 'battery-saver',
  UNKNOWN: null,
});

// ── ProfileManager class ─────────────────────────────────────────────

class ProfileManager {
  /**
   * @param {object} opts
   * @param {object} opts.config        - main CONFIG
   * @param {object} opts.bus           - EventBus (PE bus or isolated)
   * @param {object} opts.rcm           - ResourceControllerManager
   * @param {object} [opts.metrics]     - metrics registry (may be null)
   * @param {object} [opts.stateStore]  - shared StateStore (may be null)
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('ProfileManager: opts.config is required');
    }
    if (!opts.bus) {
      throw new TypeError('ProfileManager: opts.bus is required');
    }
    if (!opts.rcm) {
      throw new TypeError('ProfileManager: opts.rcm is required');
    }
    this._config = opts.config;
    this._bus = opts.bus;
    this._rcm = opts.rcm;
    this._metrics = opts.metrics || null;
    this._stateStore = opts.stateStore || null;

    this._registry = new ProfileRegistry();
    this._demand = new Map();       // source → { profileId, priority, timestamp }
    this._activeProfileId = null;   // currently applied profile ID
    this._listenerIds = [];         // bus listener IDs for cleanup
    this._idleTimer = null;         // setTimeout handle for idle activation
    this._started = false;
    this._destroyed = false;
    this._switchCount = 0;
    this._lastSwitchAt = 0;

    // Bind event handlers
    this._onWorkload = this._handleWorkload.bind(this);
    this._onPowerState = this._handlePowerState.bind(this);
    this._onIdleState = this._handleIdleState.bind(this);
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Initialize: register built-in profiles, load user profiles from
   * file (if configured), subscribe to bus events.
   */
  setup() {
    // Register built-in profiles
    const builtins = createBuiltinProfiles();
    const result = this._registry.registerAll(builtins);
    info(`ProfileManager: registered ${result.registered} built-in profile(s)`);
    if (result.errors.length > 0) {
      warn(`ProfileManager: ${result.errors.length} built-in profile(s) rejected`);
    }

    // Load user profiles from file (if configured)
    if (this._config.PROFILE_FILE_PATH) {
      const fileResult = this._registry.loadFile(this._config.PROFILE_FILE_PATH, () => {
        // On hot-reload, re-evaluate active profile in case the
        // currently-active profile's settings changed.
        debug('ProfileManager: profile file reloaded, re-evaluating active profile');
        this._reevaluate();
      });
      if (fileResult.success) {
        info(`ProfileManager: loaded ${fileResult.loaded} profile(s) from ${this._config.PROFILE_FILE_PATH}`);
        this._registry.startWatch();
      } else {
        warn(`ProfileManager: failed to load profiles from ${this._config.PROFILE_FILE_PATH}: ${fileResult.error}`);
      }
    }
  }

  /**
   * Start: subscribe to bus events and activate the default profile.
   */
  start() {
    if (this._started) return;

    // Subscribe to detector events
    const id1 = this._bus.on('onWorkloadDetected', this._onWorkload);
    const id2 = this._bus.on('onPowerStateChanged', this._onPowerState);
    const id3 = this._bus.on('onIdleStateChanged', this._onIdleState);
    if (id1 > 0) this._listenerIds.push(id1);
    if (id2 > 0) this._listenerIds.push(id2);
    if (id3 > 0) this._listenerIds.push(id3);

    this._started = true;

    // Activate the default profile ('balanced') immediately so the
    // daemon starts in a known state. Without this, _activeProfileId
    // stays null until the first demand event.
    this._reevaluate();

    info(`ProfileManager started (${this._registry.size} profile(s), demand set: ${this._demand.size})`);
  }

  /**
   * Stop: unsubscribe from bus events, cancel idle timer.
   */
  stop() {
    if (!this._started) return;
    for (const id of this._listenerIds) {
      try { this._bus.off(id); } catch (_) { /* noop */ }
    }
    this._listenerIds = [];
    this._cancelIdleTimer();
    this._started = false;
    debug('ProfileManager stopped');
  }

  /**
   * Destroy: stop + clear registry + clear demand.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    this._registry.stopWatch();
    this._registry.clear();
    this._demand.clear();
  }

  /**
   * Manually demand a profile from a source (programmatic, not via bus).
   * @param {string} source - demand source identifier
   * @param {string} profileId - profile to demand (or null to withdraw)
   * @returns {boolean} true if demand was accepted
   */
  demand(source, profileId) {
    if (this._destroyed) return false;
    if (typeof source !== 'string' || source.length === 0) return false;

    if (profileId === null) {
      this._demand.delete(source);
      debug(`ProfileManager: demand withdrawn from "${source}"`);
      this._reevaluate();
      return true;
    }

    const profile = this._registry.get(profileId);
    if (!profile) {
      warn(`ProfileManager: cannot demand unknown profile "${profileId}" from "${source}"`);
      return false;
    }

    this._demand.set(source, {
      profileId,
      priority: profile.priority,
      timestamp: Date.now(),
    });
    debug(`ProfileManager: demand from "${source}" → "${profileId}" (priority ${profile.priority})`);
    this._reevaluate();
    return true;
  }

  /**
   * Get the currently active profile ID.
   */
  get activeProfileId() {
    return this._activeProfileId;
  }

  /**
   * Get the currently active Profile object (or null).
   */
  get activeProfile() {
    return this._activeProfileId ? this._registry.get(this._activeProfileId) : null;
  }

  /**
   * Get the demand set (read-only snapshot).
   */
  get demandSet() {
    return new Map(this._demand);
  }

  /**
   * Get the registry (for tests / introspection).
   */
  get registry() {
    return this._registry;
  }

  /**
   * Return a status snapshot for the IPC `status` command.
   */
  getStatus() {
    return {
      enabled: true,
      running: this._started,
      profileCount: this._registry.size,
      activeProfileId: this._activeProfileId,
      activeProfile: this.activeProfile ? this.activeProfile.toJSON() : null,
      demandSet: Array.from(this._demand.entries()).map(([source, d]) => ({
        source,
        profileId: d.profileId,
        priority: d.priority,
      })),
      switchCount: this._switchCount,
      lastSwitchAt: this._lastSwitchAt ? new Date(this._lastSwitchAt).toISOString() : null,
      profiles: this._registry.all.map((p) => p.toJSON()),
    };
  }

  // ── Event handlers ───────────────────────────────────────────────

  _handleWorkload(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload || typeof payload.workload !== 'string') return;

    const profileId = WORKLOAD_TO_PROFILE[payload.workload];
    this.demand('workload', profileId);
  }

  _handlePowerState(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload || typeof payload.to !== 'string') return;

    const profileId = POWER_TO_PROFILE[payload.to];
    this.demand('power', profileId);
  }

  _handleIdleState(payload) {
    if (this._destroyed || !this._started) return;
    if (!payload || typeof payload.to !== 'string') return;

    if (payload.to === 'IDLE') {
      // Start idle timer — only activate idle profile after timeout
      this._cancelIdleTimer();
      const timeoutMs = this._getIdleTimeoutMs();
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        this.demand('idle', 'idle');
      }, timeoutMs);
      if (typeof this._idleTimer.unref === 'function') this._idleTimer.unref();
      debug(`ProfileManager: idle timer started (${timeoutMs}ms)`);
    } else if (payload.to === 'ACTIVE') {
      // Cancel idle timer + withdraw idle demand
      this._cancelIdleTimer();
      this.demand('idle', null);
    }
  }

  // ── Conflict resolution + activation ─────────────────────────────

  /**
   * Re-evaluate the demand set and activate the winning profile.
   * Called whenever the demand set changes.
   */
  _reevaluate() {
    if (this._destroyed) return;

    let winnerId = 'balanced';  // default when demand set is empty
    let winnerPriority = -1;
    let winnerTimestamp = Infinity;

    for (const [source, d] of this._demand) {
      const profile = this._registry.get(d.profileId);
      if (!profile) {
        // Profile was unregistered — skip
        continue;
      }
      // Higher priority wins. Ties broken by earliest timestamp.
      if (d.priority > winnerPriority ||
          (d.priority === winnerPriority && d.timestamp < winnerTimestamp)) {
        winnerId = d.profileId;
        winnerPriority = d.priority;
        winnerTimestamp = d.timestamp;
      }
    }

    if (winnerId !== this._activeProfileId) {
      this._activateProfile(winnerId);
    }
  }

  /**
   * Activate a profile: call lifecycle hooks, apply settings via RCM.
   */
  _activateProfile(profileId) {
    const profile = this._registry.get(profileId);
    if (!profile) {
      warn(`ProfileManager: cannot activate unknown profile "${profileId}"`);
      return;
    }

    const previousId = this._activeProfileId;
    const previous = previousId ? this._registry.get(previousId) : null;
    const context = {
      manager: this,
      rcm: this._rcm,
      bus: this._bus,
      stateStore: this._stateStore,
      logger,
    };

    // Deactivate previous profile
    if (previous) {
      try {
        previous.onDeactivate(context);
        previous._markInactive();
      } catch (err) {
        warn(`ProfileManager: onDeactivate error for "${previousId}": ${err.message}`);
      }
    }

    // Activate new profile (allow veto)
    let proceed = true;
    try {
      proceed = profile.onActivate(context);
    } catch (err) {
      warn(`ProfileManager: onActivate error for "${profileId}": ${err.message}`);
      proceed = false;
    }
    if (!proceed) {
      debug(`ProfileManager: activation of "${profileId}" vetoed by onActivate`);
      return;
    }

    // Apply settings via RCM
    this._applySettings(profile.settings);

    profile._markActive();
    this._activeProfileId = profileId;
    this._switchCount++;
    this._lastSwitchAt = Date.now();

    info(`ProfileManager: ${previousId || '(none)'} → ${profileId} (demand set: ${this._demand.size})`);

    // Emit event for observability
    if (this._bus) {
      try {
        this._bus.emit('onProfileChanged', {
          from: previousId,
          to: profileId,
          timestamp: new Date().toISOString(),
        });
      } catch (_) { /* bus emit failure is non-fatal */ }
    }

    // Update state store
    if (this._stateStore) {
      try {
        this._stateStore.set('profile.active', profileId);
        this._stateStore.set('profile.previous', previousId);
      } catch (_) { /* non-fatal */ }
    }

    // Update metrics
    if (this._metrics) {
      try {
        this._metrics.counter('profile_switches').increment();
        this._metrics.gauge('profile_active').set(profileId);
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Apply a profile's resolved settings via the ResourceControllerManager.
   * Routes each domain's settings to the appropriate controller method.
   */
  _applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    // Thermal
    if (settings.thermal && settings.thermal.profile) {
      try {
        const r = this._rcm.applyThermalProfile(settings.thermal.profile);
        if (!r.success) {
          debug(`ProfileManager: thermal profile "${settings.thermal.profile}" failed: ${r.error}`);
        }
      } catch (err) {
        debug(`ProfileManager: thermal apply error: ${err.message}`);
      }
    }

    // Power
    if (settings.power && settings.power.profile) {
      try {
        const r = this._rcm.applyPowerProfile(settings.power.profile);
        if (!r.success) {
          debug(`ProfileManager: power profile "${settings.power.profile}" failed: ${r.error}`);
        }
      } catch (err) {
        debug(`ProfileManager: power apply error: ${err.message}`);
      }
    }

    // PPD (optional)
    if (settings.power && settings.power.ppdProfile) {
      try {
        const r = this._rcm.setPpdProfile(settings.power.ppdProfile);
        if (!r.success) {
          debug(`ProfileManager: PPD profile "${settings.power.ppdProfile}" failed: ${r.error}`);
        }
      } catch (err) {
        debug(`ProfileManager: PPD apply error: ${err.message}`);
      }
    }

    // Governor (optional)
    if (settings.governor && settings.governor.governor) {
      try {
        const cores = settings.governor.cores || 'foreground';
        const coreArray = this._resolveCores(cores);
        if (coreArray.length > 0) {
          const r = this._rcm.setGovernor(coreArray, settings.governor.governor);
          if (!r.success) {
            debug(`ProfileManager: governor "${settings.governor.governor}" failed: ${r.error}`);
          }
        }
      } catch (err) {
        debug(`ProfileManager: governor apply error: ${err.message}`);
      }
    }
  }

  _resolveCores(which) {
    // Delegate to the RCM's scheduler if available, else return empty.
    // The RCM doesn't expose scheduler directly, so we use the governor
    // controller's resolveCores via the actuator facade if present.
    try {
      const gov = this._rcm.getController('governor');
      if (gov && gov.config) {
        // Use the scheduler's foregroundCores — access via the governor
        // controller's deps. This is a best-effort resolution; if the
        // scheduler isn't available, skip governor setting.
        return [];
      }
    } catch (_) { /* noop */ }
    return [];
  }

  _cancelIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _getIdleTimeoutMs() {
    const t = this._config.PROFILE_IDLE_TIMEOUT_MS;
    return typeof t === 'number' && t >= 0 && t <= 3600000 ? t : 300000;
  }

  // ── Hot-reload ───────────────────────────────────────────────────

  setConfig(config) {
    this._config = config;
    // Note: we do NOT re-load the profile file here — the registry's
    // own file watcher handles that. We only update the config
    // reference so _getIdleTimeoutMs() picks up new values.
  }
}

module.exports = ProfileManager;
module.exports.WORKLOAD_TO_PROFILE = WORKLOAD_TO_PROFILE;
module.exports.POWER_TO_PROFILE = POWER_TO_PROFILE;
