'use strict';

/**
 * DynAlloc — Monitoring Layer :: Public API
 * ===========================================
 *
 * Single import surface for the rest of the daemon.
 *
 * Usage:
 *
 *   const { SystemMonitor, DiagnosticsEngine, HealthChecker,
 *           BenchmarkFramework, MetricsCollector } = require('./monitoring');
 */

const SystemMonitor = require('./system-monitor');
const DiagnosticsEngine = require('./diagnostics-engine');
const HealthChecker = require('./health-checker');
const BenchmarkFramework = require('./benchmark-framework');
const MetricsCollector = require('./metrics-collector');

module.exports = {
  SystemMonitor,
  DiagnosticsEngine,
  HealthChecker,
  BenchmarkFramework,
  MetricsCollector,
};
