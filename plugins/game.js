'use strict';

/**
 * Plugin: Game Detector
 *
 * Detects game processes and suggests boosting them.
 */

module.exports = {
  name: 'game',
  version: '1.0.0',
  description: 'Detects game processes for boosting',

  detect(procs, context) {
    const results = [];
    const GAME_PATTERNS = [
      /^SteamApp/i, /^UnityPlayer/i, /^godot/i,
      /^wine(64)?$/i, /^proton/i,
    ];
    for (const proc of procs) {
      for (const re of GAME_PATTERNS) {
        if (re.test(proc.comm)) {
          results.push({
            pid: proc.pid,
            action: 'BOOST',
            reason: `Game process "${proc.comm}"`,
          });
          break;
        }
      }
    }
    return results;
  },
};