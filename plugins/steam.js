'use strict';

/**
 * Plugin: Steam Detector
 *
 * Detects Steam processes. Steam downloads should be throttled.
 * Steam game processes should be boosted (INTERACTIVE).
 */

module.exports = {
  name: 'steam',
  version: '1.0.0',
  description: 'Detects Steam and Steam game processes',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      // Steam main process
      if (/^steam$/i.test(proc.comm)) {
        results.push({
          pid: proc.pid,
          action: 'MONITOR',
          reason: 'Steam client aktif',
        });
      }
      // Steam game via GameMode
      if (context && context.gameModeActive && context.foregroundPid === proc.pid) {
        results.push({
          pid: proc.pid,
          action: 'BOOST',
          reason: 'Steam game aktif (GameMode)',
        });
      }
    }
    return results;
  },
};