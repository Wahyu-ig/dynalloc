'use strict';

/**
 * DynAlloc — Policy Engine :: Public API
 * ======================================
 *
 * Single import surface for the rest of the daemon. Backward
 * compatibility is enforced by ensuring that no module outside this
 * directory ever imports a sub-module directly — they all go through
 * this file.
 *
 * Usage:
 *
 *   const { PolicyEngine, EVENTS } = require('./policy-engine');
 *   const engine = new PolicyEngine({ actuator, governor, scheduler, config, metrics });
 *   await engine.start();
 *   engine.setState('battery.capacity', 15);
 *   engine.emit(EVENTS.ON_BATTERY_LOW, { level: 15 });
 *   await engine.stop();
 *
 * For daemon integration, see `daemon.js` — the PolicyEngine is
 * constructed only when CONFIG.ENABLE_POLICY_ENGINE is true.
 */

const { PolicyEngine, EVENTS, getEventBus, resetEventBus } = require('./policy-engine');
const { EventBus } = require('./event-bus');
const { StateStore, getStateStore, resetStateStore } = require('./state-store');
const { RuleEngine, normalizeRule } = require('./rule-engine');
const { ActionExecutor } = require('./action-executor');
const { PolicyLogger } = require('./policy-logger');
const { PolicyLoader, validatePolicy } = require('./policy-loader');
const matcher = require('./matcher');

module.exports = {
  // Main orchestrator
  PolicyEngine,
  EVENTS,
  // Subsystem classes (mainly for tests)
  EventBus,
  StateStore,
  RuleEngine,
  ActionExecutor,
  PolicyLogger,
  PolicyLoader,
  // Utilities
  normalizeRule,
  validatePolicy,
  matcher,
  // Singletons (rarely needed — most code uses the engine's own bus)
  getEventBus,
  resetEventBus,
  getStateStore,
  resetStateStore,
};
