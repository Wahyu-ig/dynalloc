'use strict';

/**
 * GovernorController — per-core CPU frequency governor switching.
 *
 * Phase 1 (ADR-0001) wraps the existing standalone `governor.js` module
 * so it conforms to the ResourceController interface. The actual logic
 * (capture originals, set per-core, restore) remains in `governor.js`
 * unchanged — this class is a thin adapter.
 *
 * Why an adapter rather than a rewrite: governor.js already has well-tested
 * capture/restore semantics (BUG FIX v2.1.1 for "captureOriginals only ran
 * once"). Re-implementing that logic risks regression. The adapter gives
 * us the ResourceController shape without touching the working code.
 */

const ResourceController = require('../resource-controller');

class GovernorController extends ResourceController {
  constructor(deps) {
    super('governor', deps);
    // Delegate to the existing GovernorManager instance passed in via deps.
    // If none is provided, the controller is a no-op (isAvailable() returns false).
    this._governor = deps.governorManager || null;
  }

  isAvailable() {
    return !!(this._governor && this.config && this.config.ENABLE_GOVERNOR_SWITCH);
  }

  /** Forward to GovernorManager.setGovernor(cores, governor, config). */
  applyGovernor(cores, governor) {
    if (!this.isAvailable()) return false;
    return this._governor.setGovernor(cores, governor, this.config);
  }

  /** Forward to GovernorManager.restoreAll(config). */
  restoreGovernors() {
    if (!this._governor) return false;
    return this._governor.restoreAll(this.config);
  }

  /** Expose the underlying GovernorManager for callers that need it (rollback). */
  get manager() {
    return this._governor;
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      captured: this._governor ? this._governor.getOriginalGovernors().size > 0 : false,
    };
  }
}

module.exports = GovernorController;
