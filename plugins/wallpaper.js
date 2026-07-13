'use strict';

/**
 * Plugin: Wallpaper Video Detector
 *
 * Protects video wallpaper processes from throttling.
 */

module.exports = {
  name: 'wallpaper',
  version: '1.0.0',
  description: 'Protects video wallpaper processes from throttling',

  detect(procs) {
    const results = [];
    const WALLPAPER_PATTERNS = [
      /^mpvpaper$/i, /^xwinwrap$/i, /^swww$/i, /^hyprpaper$/i,
      /^swaybg$/i, /^wpaperd$/i, /^glpaper$/i,
      /^wallpaper-engine-kde$/i, /gnome-video-wallpaper/i,
    ];
    for (const proc of procs) {
      for (const re of WALLPAPER_PATTERNS) {
        if (re.test(proc.comm)) {
          results.push({
            pid: proc.pid,
            action: 'PROTECT',
            reason: `Wallpaper video "${proc.comm}"`,
          });
          break;
        }
      }
    }
    return results;
  },
};