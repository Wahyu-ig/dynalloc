'use strict';

/**
 * DynAlloc — Adaptive Layer :: Public API
 * ========================================
 *
 * Single import surface for the rest of the daemon.
 *
 * Usage:
 *
 *   const { AdaptiveEngine } = require('./adaptive');
 *   const engine = new AdaptiveEngine({ config, bus, profileManager, metrics });
 *   engine.setup();
 *   engine.start();
 *   // ... events flow, transitions are debounced/cooldown'd/rolled-back ...
 *   engine.destroy();
 */

const TransitionManager = require('./transition-manager');
const AdaptiveEngine = require('./adaptive-engine');

module.exports = {
  TransitionManager,
  AdaptiveEngine,
};
