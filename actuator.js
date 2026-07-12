'use strict';

/**
 * DynAlloc — Actuator Module (Phase 1 refactor, ADR-0001)
 *
 * This file is now a **facade** that preserves the original public API of the
 * v0.2.x `Actuator` class while internally delegating to:
 *
 *   - CgroupManager                (lib/cgroup-manager.js)
 *       path resolution, capability probing, subtree setup, limit application
 *   - CpuController                (lib/controllers/cpu-controller.js)
 *       taskset, renice
 *   - MemoryController             (lib/controllers/memory-controller.js)
 *       oom_score_adj
 *   - IoController                 (lib/controllers/io-controller.js)
 *       ionice
 *
 * GovernorController is NOT instantiated here — `governor.js` remains a
 * standalone module that the daemon constructs and passes to the Actuator
 * when needed. Phase 2+ may revisit this if governor switching becomes
 * controller-driven.
 *
 * Backward compatibility contract (frozen by scripts/verify-actuator-api.js):
 *   - `require('./actuator')` returns the `Actuator` class.
 *   - `new Actuator(config)` produces an instance with all the methods,
 *     getters, and properties enumerated in verify-actuator-api.js.
 *   - Behavioral semantics (dry-run, error handling, log messages) are
 *     byte-identical to v0.2.1.
 *
 * Any change to this file MUST be accompanied by a green run of
 * `node scripts/verify-actuator-api.js` AND the full 451-test suite.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');
const { debug, info, warn, error, trace } = logger;

const CgroupManager = require('./lib/cgroup-manager');
const CpuController = require('./lib/controllers/cpu-controller');
const MemoryController = require('./lib/controllers/memory-controller');
const IoController = require('./lib/controllers/io-controller');
const NetworkController = require('./lib/controllers/network-controller');

// ── Internal helpers (kept here for facade-level use: notify, restore) ──

function _validPid(pid) {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
}

// ── Actuator Class (facade) ────────────────────────────────────────────

class Actuator {
  constructor(config) {
    this._config = config;

    // Shared modification tracker — passed to every controller so they
    // all log to a single unified registry that RollbackManager can read.
    // The tracker shape (log(), all entries, filter by pid/action) is
    // identical to the original _modificationLog so existing rollback
    // code keeps working.
    this._modificationLog = [];

    // Construct the shared CgroupManager. The Actuator exposes its
    // methods/getters as facade-level methods/getters so callers don't
    // need to know about the CgroupManager.
    this._cgroupManager = new CgroupManager(config);

    // cgroupsReady is a mutable field on the facade (mirroring v0.2.x
    // semantics where it was a plain data property). setupCgroups()
    // sets it from the CgroupManager's result. Tests and daemon.js
    // read `actuator.cgroupsReady` directly, and some tests set it
    // directly — so it must be writable.
    this.cgroupsReady = false;

    // Shared deps bundle passed to every controller.
    const deps = {
      config,
      logger,
      cgroupManager: this._cgroupManager,
      tracker: this._makeTracker(),
    };

    this._cpu = new CpuController(deps);
    this._memory = new MemoryController(deps);
    this._io = new IoController(deps);

    // v0.4.0 Phase 2: Network QoS controller — instantiated LAZILY only
    // when ENABLE_NETWORK_QOS is true, so that the default config (false)
    // produces zero behavior change from v0.3.x. When disabled, this._network
    // stays null and all getNetworkController() / networkSetup() / networkStop()
    // calls are no-ops.
    this._network = null;
    if (config.ENABLE_NETWORK_QOS) {
      this._network = new NetworkController(deps);
      debug('NetworkController instantiated (ENABLE_NETWORK_QOS=true)');
    }
  }

  /**
   * Build a tiny tracker object that wraps the _modificationLog array.
   * Controllers call tracker.log(pid, action, value); the Actuator's
   * public getModificationLog() / clearModificationLog() / _logModification()
   * methods read/write the same underlying array.
   */
  _makeTracker() {
    const self = this;
    return {
      log(pid, action, value) {
        self._modificationLog.push({
          pid,
          action,
          value,
          timestamp: Date.now(),
        });
        // Keep log bounded (same logic as v0.2.1)
        if (self._modificationLog.length > 10000) {
          self._modificationLog = self._modificationLog.slice(-5000);
        }
      },
    };
  }

  // ── Config / hot-reload ────────────────────────────────────────────

  get config() { return this._config; }

  /** Update config reference (for hot-reload). Propagates to all collaborators. */
  setConfig(config) {
    this._config = config;
    this._cgroupManager.setConfig(config);
    this._cpu.setConfig(config);
    this._memory.setConfig(config);
    this._io.setConfig(config);
  }

  get isDryRun() {
    return !!this._config.DRY_RUN;
  }

  // ── Basic process control (delegated to controllers) ──────────────

  /** @see CpuController.pinToCores */
  pinToCores(pid, cores) {
    return this._cpu.pinToCores(pid, cores);
  }

  /** @see CpuController.setNiceness */
  setNiceness(pid, niceValue) {
    return this._cpu.setNiceness(pid, niceValue);
  }

  /** @see IoController.setIoPriority */
  setIoPriority(pid, cls, level) {
    return this._io.setIoPriority(pid, cls, level);
  }

  /** @see MemoryController.setOomScoreAdj */
  setOomScoreAdj(pid, value) {
    return this._memory.setOomScoreAdj(pid, value);
  }

  // ── Desktop notification (kept on facade — not a resource control) ──

  notify(summary, body) {
    if (!this._config.ENABLE_NOTIFICATIONS || this.isDryRun) return;
    // Sanitize notification text (same logic as v0.2.1)
    const safeSummary = String(summary).slice(0, 100).replace(/[^\x20-\x7E]/g, '');
    const safeBody = String(body).slice(0, 200).replace(/[^\x20-\x7E]/g, '');
    debug(`Sending notification: ${safeSummary} / ${safeBody}`);
    execFile('notify-send', [safeSummary, safeBody], { timeout: 3000 }, (err) => {
      if (err) {
        if (!this._notifyFailureLogged) {
          warn(`Notification failed: ${err.message}`);
          this._notifyFailureLogged = true;
        }
      }
    });
  }

  // ── Cgroups v2 (facade forwards to CgroupManager) ──────────────────

  resolveOwnCgroupRelativePath() {
    return this._cgroupManager.resolveOwnCgroupRelativePath();
  }

  get cgroupBasePath() {
    return this._cgroupManager.cgroupBasePath;
  }

  detectCgroupsV2() {
    return this._cgroupManager.detectCgroupsV2();
  }

  detectOptionalControllers() {
    return this._cgroupManager.detectOptionalControllers();
  }

  get availableControllers() {
    return this._cgroupManager.availableControllers;
  }

  get foregroundCgroupPath() {
    return this._cgroupManager.foregroundCgroupPath;
  }

  get backgroundCgroupPath() {
    return this._cgroupManager.backgroundCgroupPath;
  }

  get parentCgroupPath() {
    return this._cgroupManager.parentCgroupPath;
  }

  // cgroupsReady is a plain mutable field on the facade (set in the
  // constructor, updated by setupCgroups). No getter — direct access.
  // This mirrors v0.2.x semantics where it was a data property.

  /**
   * Set up cgroup subtree + enable controllers + apply initial limits.
   * Forwards to CgroupManager.setupCgroups(), but preserves the v0.2.1
   * signature (no args) — the enable flags come from CONFIG, not from
   * the caller.
   */
  setupCgroups() {
    const ok = this._cgroupManager.setupCgroups({
      enableMemory: true,
      enableIo: true,
    });
    // Mirror cgroupsReady onto the facade for backward compat with
    // callers that read `actuator.cgroupsReady` directly.
    this.cgroupsReady = this._cgroupManager.cgroupsReady;
    return ok;
  }

  applyCgroupLimits() {
    return this._cgroupManager.applyCgroupLimits({
      enableMemory: true,
      enableIo: true,
    });
  }

  assignToCgroup(pid, cgroupDir) {
    // Pass the tracker so CgroupManager logs cgroup.procs writes to the
    // unified modification registry — same behavior as v0.2.1.
    return this._cgroupManager.assignToCgroup(pid, cgroupDir, this._makeTracker());
  }

  // ── High-level actions (kept on facade — they orchestrate multiple controllers) ──

  /**
   * Restore a process to neutral state (all cores, nice 0, default ioprio, oom 0).
   *
   * BUG FIX (v2.1.1) preserved: Always reset oom_score_adj to 0 if the
   * daemon EVER wrote a non-zero value (tracked via _modificationLog),
   * regardless of the current config flag.
   */
  restoreProcess(pid, allCores) {
    try {
      process.kill(pid, 0); // check alive
    } catch (_) {
      return; // process is dead
    }
    info(`RESTORE PID ${pid} -> normal`);
    if (this._cgroupManager.cgroupsReady) {
      this.assignToCgroup(pid, this._cgroupManager.cgroupBasePath);
    } else if (Array.isArray(allCores) && allCores.length > 0) {
      this.pinToCores(pid, allCores);
    }
    this.setNiceness(pid, 0);
    this.setIoPriority(pid, 2, 4);
    // Always reset oom_score_adj to 0 if we ever modified it. The
    // _modificationLog records every successful setOomScoreAdj call.
    const mods = this._modificationLog.filter(
      (m) => m.pid === pid && m.action === 'oom_score_adj'
    );
    if (mods.length > 0) {
      this.setOomScoreAdj(pid, 0);
    }
  }

  /**
   * Apply scheduler class settings to a process.
   * Orchestrates niceness + io priority + cgroup assignment / core pinning.
   */
  applySchedulerClass(pid, schedClass, classSettings, cores) {
    if (!_validPid(pid)) return;

    this.setNiceness(pid, classSettings.nice);
    this.setIoPriority(pid, classSettings.ioClass, classSettings.ioLevel);

    if (cores && cores.length > 0) {
      if (this._cgroupManager.cgroupsReady) {
        if (schedClass === 'BACKGROUND' || schedClass === 'IDLE') {
          this.assignToCgroup(pid, this._cgroupManager.backgroundCgroupPath);
        } else {
          this.assignToCgroup(pid, this._cgroupManager.foregroundCgroupPath);
        }
      } else {
        this.pinToCores(pid, cores);
      }
    }
  }

  // ── Modification Tracking (for rollback) ───────────────────────────

  /**
   * Public log method — kept for callers that need to record a manual
   * modification (e.g. daemon.js boost/throttle actions). Same shape
   * as v0.2.1.
   */
  _logModification(pid, action, value) {
    this._makeTracker().log(pid, action, value);
  }

  getModificationLog() {
    return [...this._modificationLog];
  }

  clearModificationLog() {
    this._modificationLog = [];
  }

  // ── Network QoS (Phase 2) ──────────────────────────────────────────
  //
  // These methods are no-ops when ENABLE_NETWORK_QOS is false (the default).
  // When true, they forward to the NetworkController. The daemon bootstrap
  // calls networkSetup() after setupCgroups(), and cleanupAndExit() calls
  // networkStop() before restoring cgroups.

  /**
   * Expose the internal CpuController instance.
   * Used by ResourceControllerManager to share controller instances
   * (single source of truth for modification tracking).
   */
  get cpuController() { return this._cpu; }

  /**
   * Expose the internal MemoryController instance.
   */
  get memoryController() { return this._memory; }

  /**
   * Expose the internal IoController instance.
   */
  get ioController() { return this._io; }

  /**
   * Expose the internal NetworkController instance (or null when disabled).
   */
  get networkController() { return this._network; }

  /**
   * Expose the internal CgroupManager instance.
   * Used by ResourceControllerManager for shared cgroup path resolution.
   */
  get cgroupManagerRef() { return this._cgroupManager; }

  /**
   * Set up the network QoS ruleset (HTB qdisc + nftables cgroup marking).
   * No-op when ENABLE_NETWORK_QOS is false.
   * @returns {boolean} true on success, false on unavailable / failure
   */
  networkSetup() {
    if (!this._network) return false;
    return this._network.setup();
  }

  /**
   * Tear down the network QoS ruleset. No-op when not set up.
   */
  networkStop() {
    if (!this._network) return;
    this._network.stop();
  }

  /**
   * Get the NetworkController instance (or null when disabled).
   * Used by the IPC `network` handler to expose status.
   */
  getNetworkController() {
    return this._network;
  }

  /**
   * Get network QoS status snapshot for IPC `status` / `network` commands.
   * Returns null when ENABLE_NETWORK_QOS is false.
   */
  getNetworkStatus() {
    if (!this._network) return null;
    return this._network.getStatus();
  }
}

module.exports = Actuator;
