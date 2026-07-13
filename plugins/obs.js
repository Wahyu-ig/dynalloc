'use strict';

/**
 * Plugin: OBS Detector
 *
 * Protects OBS Studio from throttling during recording/streaming.
 */

module.exports = {
  name: 'obs',
  version: '1.0.0',
  description: 'Protects OBS Studio during recording/streaming',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      if (!/^obs(-studio|64)?$/i.test(proc.comm)) continue;
      // OBS is always a heavy process, protect from throttle
      if (context.mediaPids && context.mediaPids.has(proc.pid)) {
        results.push({
          pid: proc.pid,
          action: 'PROTECT',
          reason: 'OBS sedang recording/streaming',
        });
      } else if (proc.pcpu > 5) {
        results.push({
          pid: proc.pid,
          action: 'MONITOR',
          reason: 'OBS aktif (CPU usage tinggi)',
        });
      }
    }
    return results;
  },
};