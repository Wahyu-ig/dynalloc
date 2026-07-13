'use strict';

/**
 * DynAlloc — Detector Layer :: Public API
 * ========================================
 *
 * Single import surface for the rest of the daemon. Mirrors the
 * `policy-engine/index.js` shape.
 *
 * Usage:
 *
 *   const { DetectorManager, DetectionContext } = require('./detectors');
 *   const mgr = new DetectorManager({ config, bus, metrics });
 *   mgr.register(new WorkloadDetector(deps));
 *   mgr.setupAll();
 *   mgr.startAll();
 *   const results = mgr.tick({ foregroundPid: 1234, ... });
 *   mgr.destroy();
 *
 * For daemon integration, see `daemon.js` — the DetectorManager is
 * constructed only when `ENABLE_DETECTOR_LAYER` is true.
 *
 * Backward compatibility: this module is only required when
 * ENABLE_DETECTOR_LAYER is true. The daemon never imports sub-modules
 * directly — it goes through this file.
 */

const { DetectorManager, DetectionContext } = require('./detector-manager');
const BaseDetector = require('./base-detector');
const WorkloadDetector = require('./workload-detector');
const PowerStateDetector = require('./power-state-detector');
const IdleStateDetector = require('./idle-state-detector');

/**
 * Built-in detectors, in registration order.
 * DetectorManager registers these on first setup unless the caller
 * has already registered detectors with the same names.
 *
 * @param {object} deps - shared deps bundle (config, logger, bus, stateStore, metrics)
 * @returns {BaseDetector[]} array of detector instances
 */
function createBuiltinDetectors(deps) {
  return [
    new WorkloadDetector(deps),
    new PowerStateDetector(deps),
    new IdleStateDetector(deps),
  ];
}

module.exports = {
  // Manager
  DetectorManager,
  DetectionContext,
  // Base class (for custom detectors)
  BaseDetector,
  // Built-in concrete detectors
  WorkloadDetector,
  PowerStateDetector,
  IdleStateDetector,
  // Factory
  createBuiltinDetectors,
};
