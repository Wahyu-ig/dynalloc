'use strict';

/**
 * Plugin: Browser Detector
 *
 * Detects browser processes and classifies their tabs/content.
 * Browsers playing media should be protected.
 */

// BUG FIX (v2.1.1): Removed unused `isKnownMediaProcessName` import
// (was imported from ../multimedia but never referenced in this file).

const BROWSER_COMM = /^(chrome|chromium|firefox|brave|vivaldi|opera|edge|msedge|firefox-esr)$/i;

module.exports = {
  name: 'browser',
  version: '1.0.0',
  description: 'Detects browser processes and protects media-playing tabs',

  detect(procs, context) {
    const results = [];
    for (const proc of procs) {
      if (!BROWSER_COMM.test(proc.comm)) continue;
      // If browser is in the media PIDs set, mark it as protected
      if (context.mediaPids && context.mediaPids.has(proc.pid)) {
        results.push({
          pid: proc.pid,
          action: 'PROTECT',
          reason: `Browser "${proc.comm}" memainkan media`,
        });
      }
    }
    return results;
  },
};