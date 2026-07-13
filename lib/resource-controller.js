'use strict';

/**
 * ResourceController — abstract base class for all Dynalloc resource
 * controllers.
 *
 * Introduced in Phase 1 (ADR-0001). Each concrete subclass owns a single
 * resource domain (CPU, Memory, IO, Network, GPU, ...). The Actuator
 * facade instantiates the active set of controllers and forwards calls
 * to them.
 *
 * Lifecycle (driven by the daemon bootstrap):
 *
 *     new Controller(name, deps)
 *         ↓
 *     setup()       — one-time init (cgroup subtree, sysfs probes, ...)
 *         ↓
 *     start()       — begin any periodic work (most controllers do nothing)
 *         ↓
 *     ... applyToProcess / restoreProcess / setXxx calls ...
 *         ↓
 *     stop()        — graceful shutdown, restore originals
 *
 * Capability model:
 *
 *     isAvailable() — returns true iff the controller can actually act on
 *                     this system (e.g. IOController returns false if the
 *                     `io` cgroup controller is not exposed). When false,
 *                     the Actuator silently skips calls to it rather than
 *                     throwing.
 *
 * Modification tracking:
 *
 *     All controllers share a single ModificationTracker (passed in via
 *     `deps.tracker`) so that the RollbackManager has one unified log
 *     to recover from on crash. Controllers must call
 *     `deps.tracker.log(pid, action, value)` after every successful
 *     state-changing operation.
 *
 * This base class is intentionally minimal. It provides:
 *   - constructor with name + deps validation
 *   - default no-op lifecycle hooks
 *   - a default isAvailable() that returns true
 *   - a default getStatus() returning {name, available}
 *   - a setConfig() that updates deps.config
 *
 * Subclasses are expected to override applyToProcess() / restoreProcess()
 * with resource-specific logic. The base class does NOT enforce a
 * per-process API shape — that's left to the Actuator facade, which
 * adapts the scheduler's classification into per-controller calls.
 */

class ResourceController {
  /**
   * @param {string} name       Short identifier ('cpu', 'memory', 'io', ...).
   * @param {object} deps       Shared dependencies.
   * @param {object} deps.config         The global CONFIG object (hot-reloadable).
   * @param {object} deps.logger         The structured logger module.
   * @param {object} deps.cgroupManager  The shared CgroupManager instance.
   * @param {object} deps.tracker        The shared ModificationTracker.
   */
  constructor(name, deps) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('ResourceController: name must be a non-empty string');
    }
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('ResourceController: deps must be an object');
    }
    this.name = name;
    this.deps = deps;
  }

  /** Convenience accessor for the current config. */
  get config() {
    return this.deps.config;
  }

  /** Convenience accessor for the dry-run flag. */
  get isDryRun() {
    return !!(this.deps.config && this.deps.config.DRY_RUN);
  }

  /** Convenience accessor for the shared tracker. */
  get tracker() {
    return this.deps.tracker;
  }

  /** Convenience accessor for the shared cgroup manager. */
  get cgroupManager() {
    return this.deps.cgroupManager;
  }

  /** Convenience accessor for the logger. */
  get log() {
    return this.deps.logger;
  }

  // ── Lifecycle hooks (subclasses override as needed) ─────────────────

  /**
   * One-time initialization. Called once during daemon bootstrap,
   * AFTER the CgroupManager has been set up but BEFORE the scheduler
   * starts ticking. Must be idempotent — bootstrap may call it again
   * after a hot-reload trigger.
   *
   * Default: no-op.
   */
  setup() {}

  /**
   * Begin any periodic work. Most controllers have no periodic work
   * (they only act when the scheduler tells them to). Called after
   * setup(). Default: no-op.
   */
  start() {}

  /**
   * Graceful shutdown. Restore any persistent state the controller
   * changed (e.g. cgroup limits, sysfs files). Called once during
   * daemon shutdown. Default: no-op.
   */
  stop() {}

  /**
   * Permanent teardown. After destroy, the controller cannot be
   * restarted. Used by tests and on daemon shutdown. Default: no-op.
   * Subclasses may override to release resources (file handles,
   * watchers, etc.).
   */
  destroy() {}

  // ── Capability probe ────────────────────────────────────────────────

  /**
   * Returns true iff this controller can actually act on the current
   * system. The Actuator uses this to skip calls gracefully when
   * (e.g.) the `io` cgroup controller is not exposed.
   *
   * Default: true. Subclasses override to probe sysfs/cgroup/cmd availability.
   */
  isAvailable() {
    return true;
  }

  // ── Introspection ───────────────────────────────────────────────────

  /**
   * Return a status snapshot for the IPC `status` command.
   * Subclasses may extend with resource-specific fields.
   */
  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
    };
  }

  // ── Hot-reload support ──────────────────────────────────────────────

  /**
   * Update the controller's config reference. Called by the Actuator
   * facade when config is hot-reloaded. Subclasses may override to
   * re-probe capabilities or refresh cached state.
   */
  setConfig(config) {
    this.deps.config = config;
  }
}

module.exports = ResourceController;
