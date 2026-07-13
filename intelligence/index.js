'use strict';

/**
 * DynAlloc — Intelligence Module Index
 *
 * Public API surface for the intelligence subsystem.
 * All external code must import through this file.
 *
 * v2.0: Initial release — learning, recommendation, explainability, timeline.
 */

const { LearningEngine } = require('./learning-engine');
const { RecommendationEngine } = require('./recommendation-engine');
const { ExplainabilityEngine } = require('./explainability-engine');
const { TimelineEngine, CATEGORIES, SEVERITIES } = require('./timeline-engine');

module.exports = {
  LearningEngine,
  RecommendationEngine,
  ExplainabilityEngine,
  TimelineEngine,
  CATEGORIES,
  SEVERITIES,
};