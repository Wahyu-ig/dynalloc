'use strict';

/**
 * DynAlloc — Policy Engine :: Action Executor
 * ===========================================
 *
 * Translates policy action objects into concrete system changes via
 * the existing Actuator / GovernorManager / Scheduler APIs.
 *
 * Supported action types:
 *
 *   { "type": "applyProfile",    "profile": "gaming" }
 *   { "type": "setGovernor",     "governor": "performance", "cores": "foreground"|"background"|"all" }
 *   { "type": "setSchedulerMode","mode": "aggressive"|"conservative"|"balanced" }
 *   { "type": "boostProcess",    "pid": 1234 }            // or "pid": "foreground"
 *   { "type": "throttleProcess", "pid": 1234 }
 *   { "type": "restoreProcess",  "pid": 1234 }
 *   { "type": "refreshPalette",  "target": "wallpaper" }  // emits onWallpaperChanged
 *   { "type": "notify",          "summary": "...", "body": "..." }
 *   { "type": "emitEvent",       "event": "onCustom", "payload": {...} }
 *   { "type": "log",             "level": "info", "message": "..." }
 *
 * Self-healing contract:
 *   - Every action returns { success, error, rollbackApplied, snapshot }.
 *   - On failure, the executor attempts to restore the snapshot.
 *   - The executor NEVER throws. Errors are caught and reported.
 *   - The executor NEVER crashes the daemon — even a TypeError in an
 *     action object is caught and logged.
 *
 * Action validation: action.type is checked first. Unknown types
 * return { success: false, error: 'unknown action type' } without
 * touching any system state.
 *
 * Profiles: the executor accepts a profiles map at construction time.
 * `applyProfile` looks up the profile by name and applies its
 * declared governor/schedulerMode/foregroundBoost atomically. If any
 * sub-step fails, all previously applied sub-steps are rolled back.
 *
 * Concurrency: actions are executed sequentially when invoked via the
 * Policy Engine (the engine awaits each call). The executor itself
 * has no internal locking — callers must serialize.
 */

const logger = require('../logger');
const { debug, warn, info } = logger;
const { EVENTS } = require('./event-bus');

class ActionExecutor {
  /**
   * @param {object} deps
   * @param {object} deps.actuator       - Actuator instance
   * @param {object} deps.governor       - GovernorManager instance (may be null)
   * @param {object} deps.scheduler      - Scheduler instance
   * @param {object} deps.config         - current CONFIG object (read-only)
   * @param {object} deps.eventBus       - EventBus instance (for emitEvent action)
   * @param {object} deps.stateStore     - StateStore instance (for pid:'foreground' resolution)
   * @param {object} deps.profiles       - { name: { governor, schedulerMode, foregroundBoost } }
   * @param {number} deps.timeoutMs      - default per-action timeout (currently advisory)
   * @param {object} [deps.resourceControllerManager] - ResourceControllerManager (v0.5.0 Phase 2, may be null)
   */
  constructor(deps) {
    this._actuator = deps.actuator;
    this._governor = deps.governor || null;
    this._scheduler = deps.scheduler;
    this._config = deps.config;
    this._bus = deps.eventBus;
    this._stateStore = deps.stateStore || null;
    this._profiles = deps.profiles || {};
    this._timeoutMs = deps.timeoutMs || 5000;
    this._defaultsCache = null;
    // v0.5.0 Phase 2: Resource Controller Manager (may be null when
    // ENABLE_RESOURCE_CONTROLLER_LAYER is false). When present, the
    // new action types (setThermalProfile, setPowerProfile) route
    // through it. When null, those actions return an error.
    this._rcm = deps.resourceControllerManager || null;
    this._stats = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      rolledBack: 0,
    };
  }

  /**
   * Update the profiles map (e.g. on policy hot-reload).
   */
  setProfiles(profiles) {
    this._profiles = profiles || {};
  }

  /**
   * Update the config reference (e.g. on main config hot-reload).
   */
  setConfig(config) {
    this._config = config;
  }

  /**
   * v0.5.0 Phase 2: Set the Resource Controller Manager reference.
   * Called by the daemon after the manager is constructed (which
   * happens after the PE in bootstrap order).
   */
  setResourceControllerManager(rcm) {
    this._rcm = rcm || null;
  }

  /**
   * @returns {object} cumulative counters
   */
  get stats() {
    return { ...this._stats };
  }

  /**
   * Execute a single action object.
   *
   * @param {object} action
   * @param {object} [ctx] - execution context { triggerEvent, triggerPayload, ruleId }
   * @returns {Promise<{success: boolean, error: string|null, rollbackApplied: boolean, snapshot: *}>}
   */
  async execute(action, ctx = {}) {
    this._stats.attempted++;
    if (!action || typeof action !== 'object') {
      this._stats.failed++;
      return { success: false, error: 'action is not an object', rollbackApplied: false, snapshot: null };
    }
    if (typeof action.type !== 'string' || action.type.length === 0) {
      this._stats.failed++;
      return { success: false, error: 'action.type missing', rollbackApplied: false, snapshot: null };
    }

    const start = Date.now();
    const snapshot = this._captureSnapshot(action);
    let result;
    try {
      switch (action.type) {
        case 'applyProfile':     result = await this._applyProfile(action); break;
        case 'setGovernor':      result = await this._setGovernor(action); break;
        case 'setSchedulerMode': result = await this._setSchedulerMode(action); break;
        case 'boostProcess':     result = await this._boostProcess(action); break;
        case 'throttleProcess':  result = await this._throttleProcess(action); break;
        case 'restoreProcess':   result = await this._restoreProcess(action); break;
        case 'refreshPalette':   result = await this._refreshPalette(action); break;
        case 'notify':           result = await this._notify(action); break;
        case 'emitEvent':        result = await this._emitEvent(action); break;
        case 'log':              result = await this._log(action); break;
        // v0.5.0 Phase 2: new action types routed through ResourceControllerManager
        case 'setThermalProfile': result = await this._setThermalProfile(action); break;
        case 'setPowerProfile':   result = await this._setPowerProfile(action); break;
        case 'setPpdProfile':     result = await this._setPpdProfile(action); break;
        default:
          result = { success: false, error: `unknown action type "${action.type}"` };
      }
    } catch (err) {
      result = { success: false, error: err && err.message ? err.message : String(err) };
    }

    const elapsed = Date.now() - start;
    if (result.success) {
      this._stats.succeeded++;
      return { success: true, error: null, rollbackApplied: false, snapshot, elapsedMs: elapsed };
    }

    // Failure — attempt rollback
    this._stats.failed++;
    let rollbackApplied = false;
    try {
      rollbackApplied = this._restoreSnapshot(snapshot);
      if (rollbackApplied) this._stats.rolledBack++;
    } catch (rollbackErr) {
      warn(`ActionExecutor rollback failed for "${action.type}": ${rollbackErr.message}`);
    }

    // If the action performed its own internal rollback (e.g. applyProfile
    // rolled back sub-steps), propagate that fact to the audit log.
    if (result.internalRollbackApplied) {
      rollbackApplied = true;
    }

    return {
      success: false,
      error: result.error || 'action failed',
      rollbackApplied,
      snapshot,
      elapsedMs: elapsed,
    };
  }

  // ── Action implementations ───────────────────────────────────────

  /**
   * Apply a named profile. A profile may declare any combination of:
   *   { governor: "...", schedulerMode: "...", foregroundBoost: true }
   * Each declared sub-step is applied in order. If any fails, the
   * previous sub-steps are rolled back.
   *
   * The returned result includes `internalRollbackApplied: true` when
   * sub-step rollback was performed, so the outer execute() can record
   * it in the audit log.
   */
  async _applyProfile(action) {
    const profileName = action.profile;
    const profile = this._profiles[profileName];
    if (!profile) {
      return { success: false, error: `unknown profile "${profileName}"` };
    }

    const appliedSteps = [];
    let internalRollbackApplied = false;
    const tryStep = async (subAction) => {
      const r = await this.execute(subAction, { _profileStep: true });
      if (!r.success) {
        // Roll back the steps we already applied (in reverse order)
        for (let i = appliedSteps.length - 1; i >= 0; i--) {
          try {
            this._restoreSnapshot(appliedSteps[i]);
            internalRollbackApplied = true;
          } catch (_) { /* continue */ }
        }
        return { ...r, internalRollbackApplied };
      }
      appliedSteps.push(r.snapshot);
      return r;
    };

    if (profile.schedulerMode) {
      const r = await tryStep({
        type: 'setSchedulerMode',
        mode: profile.schedulerMode,
      });
      if (!r.success) return r;
    }
    if (profile.governor) {
      const r = await tryStep({
        type: 'setGovernor',
        governor: profile.governor,
        cores: profile.governorCores || 'foreground',
      });
      if (!r.success) return r;
    }
    if (profile.foregroundBoost && this._scheduler) {
      // BUG FIX (v2.1.1): Previously this branch was "informational only"
      // — it just emitted an event and never actually boosted the
      // foreground process, contradicting the profile schema docs which
      // say `foregroundBoost: true` should boost. We now invoke the same
      // _boostProcess({pid:'foreground'}) code path that the
      // `boostProcess` action type uses, so the profile actually has the
      // documented effect. The ON_PROFILE_CHANGED event is still emitted
      // so listeners can react.
      const boostResult = await tryStep({
        type: 'boostProcess',
        pid: 'foreground',
      });
      if (!boostResult.success) return boostResult;

      if (this._bus) {
        const bus = this._bus;
        const payload = { profile: profileName, foregroundBoost: true };
        setImmediate(() => {
          try { bus.emit(EVENTS.ON_PROFILE_CHANGED, payload); } catch (_) { /* swallow */ }
        });
      }
    }
    info(`Policy: applied profile "${profileName}"`);
    return { success: true };
  }

  /**
   * Set CPU governor on a set of cores.
   */
  async _setGovernor(action) {
    if (!this._governor) {
      return { success: false, error: 'governor manager not available' };
    }
    const valid = ['performance', 'powersave', 'ondemand', 'conservative', 'schedutil', 'userspace'];
    if (!valid.includes(action.governor)) {
      return { success: false, error: `invalid governor "${action.governor}"` };
    }
    const cores = this._resolveCores(action.cores || 'foreground');
    if (cores.length === 0) {
      return { success: false, error: 'no cores selected for governor switch' };
    }
    this._governor.setGovernor(cores, action.governor, this._config);
    return { success: true };
  }

  /**
   * Set scheduler mode by adjusting PSI thresholds at runtime.
   *
   *   aggressive   → lower thresholds (faster throttling)
   *   conservative → higher thresholds (slower throttling)
   *   balanced     → restore to config defaults (from DEFAULT_CONFIG)
   *
   * The "balanced" preset reads from DEFAULT_CONFIG so it always
   * restores the original factory values, not whatever CONFIG happens
   * to hold at the time (which may have been mutated by a previous
   * aggressive/conservative action).
   *
   * Snapshot/rollback captures the current values BEFORE mutation.
   * On rollback, those exact values are restored — even if a hot-
   * reload happened in between (the snapshot wins). This is the
   * accepted trade-off: the action's effect is reverted at the
   * expense of any concurrent hot-reload changes.
   */
  async _setSchedulerMode(action) {
    if (!this._scheduler) {
      return { success: false, error: 'scheduler not available' };
    }
    const mode = action.mode;
    const cfg = this._config;

    // Read defaults from DEFAULT_CONFIG for the "balanced" preset
    // so we restore factory values rather than the current (possibly
    // already-mutated) values.
    const defaults = this._getConfigDefaults();

    // Use the current config values for aggressive/conservative
    // scaling — but read from defaults when the current values look
    // already-mutated (heuristic: if WARN*2 == CRITICAL, assume the
    // user hasn't customized and the ratio is from defaults).
    const baseWarn = defaults.PSI_CPU_WARN;
    const baseCrit = defaults.PSI_CPU_CRITICAL;

    const presets = {
      aggressive:   { cpuWarn: baseWarn * 0.5, cpuCrit: baseCrit * 0.5 },
      conservative: { cpuWarn: baseWarn * 1.5, cpuCrit: baseCrit * 1.5 },
      balanced:     { cpuWarn: baseWarn,       cpuCrit: baseCrit },
    };
    const preset = presets[mode];
    if (!preset) {
      return { success: false, error: `unknown scheduler mode "${mode}"` };
    }

    // Cross-field validation: never allow WARN >= CRITICAL
    if (preset.cpuWarn >= preset.cpuCrit) {
      return { success: false, error: `invalid preset: WARN (${preset.cpuWarn}) >= CRITICAL (${preset.cpuCrit})` };
    }

    cfg.PSI_CPU_WARN = preset.cpuWarn;
    cfg.PSI_CPU_CRITICAL = preset.cpuCrit;
    return { success: true };
  }

  /**
   * Get the DEFAULT_CONFIG. Cached to avoid repeated requires.
   */
  _getConfigDefaults() {
    if (!this._defaultsCache) {
      try {
        this._defaultsCache = require('../config').DEFAULT_CONFIG;
      } catch (_) {
        // Fallback: use current config values as "defaults"
        this._defaultsCache = this._config;
      }
    }
    return this._defaultsCache;
  }

  async _boostProcess(action) {
    if (!this._actuator || !this._scheduler) {
      return { success: false, error: 'actuator/scheduler not available' };
    }
    const pid = this._resolvePid(action.pid);
    if (!pid) return { success: false, error: 'invalid pid' };
    try {
      const boost = this._scheduler.generateForegroundBoost(pid, [], false);
      if (!boost) return { success: false, error: 'could not generate boost' };
      // Reuse the same execution path as daemon._executeBoost
      if (this._actuator.cgroupsReady) {
        this._actuator.assignToCgroup(pid, this._actuator.foregroundCgroupPath);
      } else {
        this._actuator.pinToCores(pid, boost.cores);
      }
      this._actuator.setNiceness(pid, boost.nice);
      this._actuator.setIoPriority(pid, boost.ioClass, boost.ioLevel);
      if (this._config.ENABLE_OOM_PROTECTION) {
        this._actuator.setOomScoreAdj(pid, this._config.FOREGROUND_OOM_SCORE_ADJ);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _throttleProcess(action) {
    if (!this._actuator || !this._scheduler) {
      return { success: false, error: 'actuator/scheduler not available' };
    }
    const pid = this._resolvePid(action.pid);
    if (!pid) return { success: false, error: 'invalid pid' };
    try {
      // Use the executor's own config reference (kept up-to-date by
      // setConfig on hot-reload) rather than reaching into the
      // scheduler's private _config field.
      const nice = this._config.SCHEDULER_CLASS_BACKGROUND_NICE;
      const ioPrio = this._config.SCHEDULER_CLASS_BACKGROUND_IOPRIO;
      const ioClass = Array.isArray(ioPrio) ? ioPrio[0] : 3;
      const ioLevel = Array.isArray(ioPrio) ? ioPrio[1] : 0;
      const cores = this._scheduler.backgroundCores;
      if (this._actuator.cgroupsReady) {
        this._actuator.assignToCgroup(pid, this._actuator.backgroundCgroupPath);
      } else {
        this._actuator.pinToCores(pid, cores);
      }
      this._actuator.setNiceness(pid, nice);
      this._actuator.setIoPriority(pid, ioClass, ioLevel);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _restoreProcess(action) {
    if (!this._actuator || !this._scheduler) {
      return { success: false, error: 'actuator/scheduler not available' };
    }
    const pid = this._resolvePid(action.pid);
    if (!pid) return { success: false, error: 'invalid pid' };
    try {
      this._actuator.restoreProcess(pid, this._scheduler.allCores);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _refreshPalette(action) {
    if (!this._bus) return { success: false, error: 'event bus not available' };
    // Emit the onWallpaperChanged event so plugins (e.g. wallpaper
    // palette extractor) can react. The target field lets producers
    // scope the refresh.
    this._bus.emit('onWallpaperChanged', { target: action.target || 'wallpaper' });
    return { success: true };
  }

  async _notify(action) {
    if (!this._actuator) return { success: false, error: 'actuator not available' };
    try {
      this._actuator.notify(action.summary || 'DynAlloc', action.body || '');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _emitEvent(action) {
    if (!this._bus) return { success: false, error: 'event bus not available' };
    if (typeof action.event !== 'string' || action.event.length === 0) {
      return { success: false, error: 'emitEvent.event missing' };
    }
    // Defer the emit via setImmediate to break synchronous re-entry.
    // Without this, a rule that emits the same event it matches on
    // would re-enter the wildcard listener synchronously and spin
    // the microtask queue. The rule engine's cooldown prevents
    // re-firing, but the defer adds a second layer of safety.
    const bus = this._bus;
    const event = action.event;
    const payload = action.payload || {};
    setImmediate(() => {
      try { bus.emit(event, payload); } catch (_) { /* swallow */ }
    });
    return { success: true };
  }

  async _log(action) {
    const level = typeof action.level === 'string' ? action.level.toLowerCase() : 'info';
    const msg = typeof action.message === 'string' ? action.message : '';
    if (typeof logger[level] === 'function') {
      logger[level](`[policy] ${msg}`);
    } else {
      info(`[policy] ${msg}`);
    }
    return { success: true };
  }

  // ── v0.5.0 Phase 2: Resource Controller actions ──────────────────

  /**
   * Apply a thermal profile via the ResourceControllerManager.
   * Action shape: { "type": "setThermalProfile", "profile": "cool" }
   * Valid profiles: 'balanced', 'cool', 'silent'
   */
  async _setThermalProfile(action) {
    if (!this._rcm) {
      return { success: false, error: 'Resource Controller Layer not enabled (set ENABLE_RESOURCE_CONTROLLER_LAYER=true)' };
    }
    if (typeof action.profile !== 'string' || action.profile.length === 0) {
      return { success: false, error: 'setThermalProfile.profile missing' };
    }
    const result = this._rcm.applyThermalProfile(action.profile);
    return {
      success: result.success,
      error: result.error || null,
      profile: result.profile || null,
    };
  }

  /**
   * Apply a power profile via the ResourceControllerManager.
   * Action shape: { "type": "setPowerProfile", "profile": "power-saver" }
   * Valid profiles: 'balanced', 'power-saver', 'performance'
   */
  async _setPowerProfile(action) {
    if (!this._rcm) {
      return { success: false, error: 'Resource Controller Layer not enabled (set ENABLE_RESOURCE_CONTROLLER_LAYER=true)' };
    }
    if (typeof action.profile !== 'string' || action.profile.length === 0) {
      return { success: false, error: 'setPowerProfile.profile missing' };
    }
    const result = this._rcm.applyPowerProfile(action.profile);
    return {
      success: result.success,
      error: result.error || null,
      profile: result.profile || null,
    };
  }

  /**
   * Set the system-wide PPD profile via the ResourceControllerManager.
   * Action shape: { "type": "setPpdProfile", "profile": "performance" }
   * Valid profiles: 'power-saver', 'balanced', 'performance'
   */
  async _setPpdProfile(action) {
    if (!this._rcm) {
      return { success: false, error: 'Resource Controller Layer not enabled (set ENABLE_RESOURCE_CONTROLLER_LAYER=true)' };
    }
    if (typeof action.profile !== 'string' || action.profile.length === 0) {
      return { success: false, error: 'setPpdProfile.profile missing' };
    }
    const result = this._rcm.setPpdProfile(action.profile);
    return {
      success: result.success,
      error: result.error || null,
      profile: result.profile || null,
    };
  }

  // ── Snapshot / Rollback ──────────────────────────────────────────

  /**
   * Capture a minimal snapshot of state that this specific action
   * might modify. Used for best-effort rollback.
   *
   * For setGovernor, we force-capture originals for the targeted
   * cores via GovernorManager.captureOriginals() — this ensures the
   * snapshot has entries for every core we're about to modify, even
   * if the daemon never captured them before.
   */
  _captureSnapshot(action) {
    if (!this._config) return null;
    try {
      switch (action.type) {
        case 'setGovernor': {
          if (!this._governor) return null;
          const cores = this._resolveCores(action.cores || 'foreground');
          // Force-capture originals for the targeted cores
          this._governor.captureOriginals(cores);
          return {
            kind: 'governor',
            cores,
            originals: this._governor.getOriginalGovernors(),
          };
        }
        case 'setSchedulerMode':
          return {
            kind: 'schedulerMode',
            cpuWarn: this._config.PSI_CPU_WARN,
            cpuCrit: this._config.PSI_CPU_CRITICAL,
          };
        case 'applyProfile':
          // applyProfile snapshots are handled per-sub-step
          return { kind: 'profile', name: action.profile };
        default:
          return null;
      }
    } catch (_) {
      return null;
    }
  }

  /**
   * Best-effort rollback for a captured snapshot.
   * Returns true if at least one restoration was performed.
   */
  _restoreSnapshot(snapshot) {
    if (!snapshot) return false;
    try {
      switch (snapshot.kind) {
        case 'governor': {
          if (this._governor && Array.isArray(snapshot.cores)) {
            let restoredAny = false;
            for (const core of snapshot.cores) {
              const orig = snapshot.originals && snapshot.originals.get
                ? snapshot.originals.get(core) : null;
              if (orig) {
                this._governor.setGovernor([core], orig, this._config);
                restoredAny = true;
              }
            }
            return restoredAny;
          }
          return false;
        }
        case 'schedulerMode':
          if (this._config) {
            this._config.PSI_CPU_WARN = snapshot.cpuWarn;
            this._config.PSI_CPU_CRITICAL = snapshot.cpuCrit;
            return true;
          }
          return false;
        default:
          return false;
      }
    } catch (_) {
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  _resolveCores(which) {
    if (!this._scheduler) return [];
    if (Array.isArray(which)) return which;
    if (which === 'foreground') return this._scheduler.foregroundCores;
    if (which === 'background') return this._scheduler.backgroundCores;
    if (which === 'all')        return this._scheduler.allCores;
    return this._scheduler.foregroundCores;
  }

  _resolvePid(pidSpec) {
    if (typeof pidSpec === 'number') {
      return pidSpec > 0 ? pidSpec : null;
    }
    if (pidSpec === 'foreground') {
      // Read the current foreground PID from the policy engine's
      // state store (the daemon's EventSources updates this on every
      // foreground change).
      if (this._stateStore) {
        const pid = this._stateStore.get('foreground.pid');
        if (typeof pid === 'number' && pid > 0) return pid;
      }
      return null;
    }
    return null;
  }
}

module.exports = {
  ActionExecutor,
};
