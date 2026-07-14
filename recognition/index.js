'use strict';

/**
 * DynAlloc — Recognition Layer :: Public API
 * ===========================================
 *
 * Single import surface for the rest of the daemon.
 *
 * Usage:
 *
 *   const { RecognitionEngine } = require('./recognition');
 *   const engine = new RecognitionEngine({ config, bus, profileManager, metrics });
 *   engine.setup();
 *   engine.start();
 *   // ... events flow, workloads recognized, profiles demanded ...
 *   engine.destroy();
 *
 * Plugin extensibility:
 *
 *   const { WorkloadRecognizer } = require('./recognition');
 *   engine.recognizer.registerRule({
 *     id: 'my-plugin-rule',
 *     workload: 'custom-workload',
 *     profile: 'my-profile',
 *     match: (ctx) => ctx.foregroundComm === 'my-app',
 *     confidence: (ctx) => 0.80,
 *   });
 */

const WorkloadRecognizer = require('./workload-recognizer');
const RecognitionEngine = require('./recognition-engine');
const { OPTIMIZATION_STRATEGIES, getStrategy, getWorkloadCategories } = require('./optimization-strategies');

module.exports = {
  WorkloadRecognizer,
  RecognitionEngine,
  OPTIMIZATION_STRATEGIES,
  getStrategy,
  getWorkloadCategories,
};
