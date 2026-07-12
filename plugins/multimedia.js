'use strict';

/**
 * Plugin: Multimedia Detector (Plugin version)
 *
 * Bridges the core multimedia detection to the plugin system.
 */

const { isKnownMediaProcessName } = require('../multimedia');

module.exports = {
  name: 'multimedia',
  version: '1.0.0',
  description: 'Protects all multimedia processes via name matching',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      if (isKnownMediaProcessName(proc.comm) && !(context.mediaPids && context.mediaPids.has(proc.pid))) {
        // Only add if not already in media PIDs set (avoid duplicate protection logic)
        results.push({
          pid: proc.pid,
          action: 'PROTECT',
          reason: `Multimedia "${proc.comm}" (name-based)`,
        });
      }
    }
    return results;
  },
};