'use strict';

/**
 * Plugin: Discord Detector
 *
 * Protects Discord from throttling when voice is active.
 */

module.exports = {
  name: 'discord',
  version: '1.0.0',
  description: 'Protects Discord from throttling during voice activity',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      if (!/^discord$/i.test(proc.comm)) continue;
      // Discord is always protected via multimedia (voice), but also protect
      // its renderer processes
      if (context.mediaPids && context.mediaPids.has(proc.pid)) {
        results.push({
          pid: proc.pid,
          action: 'PROTECT',
          reason: 'Discord voice aktif',
        });
      }
    }
    return results;
  },
};