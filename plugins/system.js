'use strict';

/**
 * Plugin: System Detector
 *
 * Monitors system health indicators.
 */

module.exports = {
  name: 'system',
  version: '1.0.0',
  description: 'System health monitoring plugin',

  detect(procs, context) {
    // This plugin doesn't detect specific processes but could
    // report system-level events. Currently a placeholder for
    // future system health integration.
    return [];
  },
};