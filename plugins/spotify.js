'use strict';

/**
 * Plugin: Spotify Detector
 *
 * Protects Spotify from throttling.
 */

module.exports = {
  name: 'spotify',
  version: '1.0.0',
  description: 'Protects Spotify from throttling during playback',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      if (!/^spotify(d)?$/i.test(proc.comm)) continue;
      if (context.mediaPids && context.mediaPids.has(proc.pid)) {
        results.push({
          pid: proc.pid,
          action: 'PROTECT',
          reason: 'Spotify sedang memutar musik',
        });
      }
    }
    return results;
  },
};