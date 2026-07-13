'use strict';

/**
 * Plugin: KDE Plasma Wayland Foreground Detector (v1.1.0)
 * =========================================================
 *
 * Detects the foreground window process on KDE Plasma Wayland sessions
 * using KWin's DBus interface (qdbus) and returns it for boosting.
 *
 * Session detection (auto-activate):
 *   - XDG_CURRENT_DESKTOP contains "KDE" (case-insensitive)
 *   - XDG_SESSION_TYPE is "wayland" OR WAYLAND_DISPLAY is set
 *
 * If either condition fails, the plugin returns an empty result and
 * does NOT interfere with GNOME, Hyprland, Sway, or X11 detection.
 *
 * Detection strategies (tried in order, first non-null wins):
 *   1. Plasma 6: qdbus org.kde.KWin /org/kde/KWin/WindowManagement
 *      → property ActiveWindow → GetWindowInfo → "pid"
 *   2. Plasma 5.27+: qdbus org.kde.KWin /Scripting
 *      → evaluateScript("workspace.activeClient.pid")
 *
 * The plugin exposes:
 *   - name, version, description           — required plugin manifest
 *   - init(config)                          — initializes the plugin
 *   - detect(procs, context)                — standard plugin interface;
 *                                              returns BOOST for the
 *                                              currently focused process
 *                                              (so the scheduler's
 *                                              plugin layer excludes it
 *                                              from throttling)
 *   - getForegroundPid()                    — async foreground PID query
 *                                              (used by sensor.js as a
 *                                              drop-in source; the
 *                                              daemon already integrates
 *                                              qdbus detection in
 *                                              sensor.js, but exposing
 *                                              it here lets the plugin
 *                                              layer share the same
 *                                              implementation)
 *   - isSupported()                         — synchronous check for
 *                                              whether this plugin can
 *                                              run in the current session
 *   - destroy()                             — cleanup (no-op; the plugin
 *                                              is stateless)
 *
 * Performance:
 *   - getForegroundPid() has a 2-second timeout per call
 *   - detect() caches the foreground PID for 500ms to avoid hammering
 *     DBus on every scheduler tick (which may run multiple times per
 *     second under load)
 *   - qdbus is invoked via execFile (no shell), with a strict timeout
 *
 * Backward compatibility:
 *   - This plugin ONLY activates on KDE Plasma Wayland sessions. On
 *     any other session (GNOME, Hyprland, Sway, X11, etc.), detect()
 *     returns [] and getForegroundPid() returns null — leaving the
 *     existing foreground detection chain in sensor.js untouched.
 *   - This plugin does NOT register any new IPC handlers, config keys,
 *     or daemon modules. It is purely additive.
 *
 * Fail-safe behavior:
 *   - If qdbus is not installed, detect() returns [] and
 *     getForegroundPid() returns null.
 *   - If qdbus times out, same — no error is thrown.
 *   - If KWin is not running (no Plasma session), same.
 *   - If the DBus reply is malformed, same.
 *
 * The plugin never throws — all errors are caught and downgraded to
 * "no foreground detected". This matches the convention of existing
 * plugins (see plugins/browser.js, plugins/game.js).
 */

// Use child_process.execFile (not destructured) so tests can mock it
// via mock.method(child_process, 'execFile', ...). Destructuring at
// module-load would capture the original function and make mocking
// ineffective.
const child_process = require('child_process');

const PLUGIN_NAME = 'kde-wayland';
const PLUGIN_VERSION = '1.0.0';
const PLUGIN_DESCRIPTION =
  'Foreground detection for KDE Plasma Wayland via KWin DBus (qdbus)';

// Detection cache duration: 500ms.
// The scheduler tick can fire multiple times per second under load;
// we don't want to spawn a qdbus process on every tick.
const CACHE_TTL_MS = 500;

// qdbus per-call timeout: 2 seconds.
const QDBUS_TIMEOUT_MS = 2000;

/**
 * Detect whether the current session is KDE Plasma Wayland.
 * Pure env-var check — no I/O, no side effects.
 *
 * @returns {boolean}
 */
function isKdeWaylandSession() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  const waylandDisplay = !!process.env.WAYLAND_DISPLAY;

  const isKde = desktop.split(':').some((d) => d.trim() === 'kde');
  const isWayland = sessionType === 'wayland' || waylandDisplay;

  return isKde && isWayland;
}

/**
 * Plugin module export. Follows the same shape as plugins/browser.js,
 * plugins/game.js, plugins/obs.js, etc., with two additions:
 *   - getForegroundPid() — async, for foreground source integration
 *   - isSupported()      — sync session check
 *
 * State:
 *   - _cachePid: cached foreground PID (or null)
 *   - _cacheTs:  cache timestamp (ms)
 *   - _enabled:  true iff we are on a KDE Plasma Wayland session
 *   - _qdbusAvailable: true iff the qdbus binary is on PATH (probed once)
 *   - _qdbusProbed:    true iff the probe has run
 */
const plugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: PLUGIN_DESCRIPTION,

  // ── State (initialized in init()) ─────────────────────────────────
  _cachePid: null,
  _cacheTs: 0,
  _enabled: false,
  _qdbusAvailable: false,
  _qdbusProbed: false,

  /**
   * Initialize the plugin. Called once by PluginManager.initAll().
   * @param {object} config - daemon config (unused — we use env vars)
   */
  init(config) {
    this._enabled = isKdeWaylandSession();
    // Reset cache
    this._cachePid = null;
    this._cacheTs = 0;
    // Probe qdbus lazily on first use, not here — init() must be fast.
    this._qdbusProbed = false;
    this._qdbusAvailable = false;
  },

  /**
   * Synchronously check whether this plugin can run in the current
   * session. Returns true iff:
   *   - XDG_CURRENT_DESKTOP indicates KDE
   *   - XDG_SESSION_TYPE is wayland (or WAYLAND_DISPLAY is set)
   *
   * This does NOT probe for qdbus — that's done lazily on first call
   * to getForegroundPid().
   *
   * @returns {boolean}
   */
  isSupported() {
    return isKdeWaylandSession();
  },

  /**
   * Standard plugin detect() interface.
   *
   * Returns an array of detection results: one BOOST entry for the
   * currently focused process (if any). This integrates with the
   * existing plugin layer so the scheduler's classifyProcesses()
   * excludes the foreground PID from throttling.
   *
   * On non-KDE-Wayland sessions, returns [] — does not interfere
   * with GNOME/Hyprland/Sway/X11.
   *
   * @param {Array} procs - process list from ps
   * @param {object} context - scheduler context (foregroundPid,
   *   mediaPids, gameModeActive)
   * @returns {Array<{pid:number, action:string, reason:string}>}
   */
  detect(procs, context) {
    if (!this._enabled) return [];

    // The scheduler already tracks the foreground PID via sensor.js's
    // chain (which includes qdbus for KDE Wayland). We don't want to
    // spawn a qdbus process on every detect() call — that would be
    // wasteful. Instead, we use the foregroundPid from context (which
    // is already populated by sensor.js) and emit a BOOST detection
    // for it, so the plugin layer can apply additional protection.
    //
    // If context.foregroundPid is missing (e.g. foreground detection
    // failed in sensor.js), we fall back to a cached qdbus query — but
    // only if the cache is stale (>= CACHE_TTL_MS old).
    let fgPid = context && context.foregroundPid ? context.foregroundPid : null;

    if (!fgPid) {
      // Try the cache (no I/O)
      const now = Date.now();
      if (this._cachePid && (now - this._cacheTs) < CACHE_TTL_MS) {
        fgPid = this._cachePid;
      }
      // Do NOT call getForegroundPid() synchronously here — it's async
      // and detect() is sync. The cache will be refreshed on the next
      // getForegroundPid() call (e.g. from sensor.js).
    } else {
      // Update the cache with the value from context
      this._cachePid = fgPid;
      this._cacheTs = Date.now();
    }

    if (!fgPid) return [];

    // Find the comm for this PID from the procs list
    let comm = null;
    if (Array.isArray(procs)) {
      for (const p of procs) {
        if (p && p.pid === fgPid) { comm = p.comm || null; break; }
      }
    }

    // Emit a BOOST detection so the scheduler's plugin-merge logic
    // excludes this PID from throttling. See daemon.js:803-808.
    return [{
      pid: fgPid,
      action: 'BOOST',
      reason: `KDE Plasma Wayland foreground process${comm ? ` (${comm})` : ''}`,
    }];
  },

  /**
   * Async foreground PID query. Used by sensor.js as a foreground
   * source for KDE Plasma Wayland sessions.
   *
   * Tries two strategies in order:
   *   1. Plasma 6: WindowManagement DBus interface
   *   2. Plasma 5.27+: Scripting.evaluateScript
   *
   * @returns {Promise<number|null>} the foreground PID, or null if
   *   unavailable (not on KDE Wayland, qdbus missing, KWin not
   *   running, DBus timeout, malformed reply, etc.)
   */
  async getForegroundPid() {
    if (!this._enabled) return null;

    // Probe qdbus once (lazy)
    if (!this._qdbusProbed) {
      this._qdbusProbed = true;
      this._qdbusAvailable = await this._probeQdbus();
    }
    if (!this._qdbusAvailable) return null;

    // Try Plasma 6 first, then Plasma 5
    let pid = await this._queryPlasma6();
    if (typeof pid !== 'number' || pid <= 0) {
      pid = await this._queryPlasma5();
    }

    if (typeof pid === 'number' && pid > 0) {
      this._cachePid = pid;
      this._cacheTs = Date.now();
      return pid;
    }

    this._cachePid = null;
    this._cacheTs = Date.now();
    return null;
  },

  /**
   * Probe whether the qdbus binary is available on PATH.
   * @returns {Promise<boolean>}
   */
  _probeQdbus() {
    return new Promise((resolve) => {
      // `qdbus --version` exits 0 on most systems; on some it may
      // print to stderr. We just check that the binary exists.
      child_process.execFile('qdbus', ['--version'], { timeout: 1000 }, (err) => {
        resolve(!err);
      });
    });
  },

  /**
   * Plasma 6: query the WindowManagement DBus interface.
   *
   * Step 1: get the active window id (uint32)
   *   qdbus org.kde.KWin /org/kde/KWin/WindowManagement \
   *         org.freedesktop.DBus.Properties.Get \
   *         org.kde.KWin.WindowManagement ActiveWindow
   *
   * Step 2: query the window info for the PID
   *   qdbus org.kde.KWin /org/kde/KWin/WindowManagement \
   *         org.kde.KWin.WindowManagement.GetWindowInfo <windowId>
   *
   * @returns {Promise<number|null>}
   */
  _queryPlasma6() {
    return new Promise((resolve) => {
      // Step 1: get the active window id
      child_process.execFile('qdbus', [
        'org.kde.KWin', '/org/kde/KWin/WindowManagement',
        'org.freedesktop.DBus.Properties.Get',
        'org.kde.KWin.WindowManagement', 'ActiveWindow',
      ], { timeout: QDBUS_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve(null);
        // Output is like: "uint32 12345" or just "12345"
        const match = stdout.match(/(\d+)/);
        if (!match) return resolve(null);
        const windowId = parseInt(match[1], 10);
        if (!Number.isFinite(windowId) || windowId === 0) return resolve(null);

        // Step 2: query the window info for the PID
        child_process.execFile('qdbus', [
          'org.kde.KWin', '/org/kde/KWin/WindowManagement',
          'org.kde.KWin.WindowManagement.GetWindowInfo',
          String(windowId),
        ], { timeout: QDBUS_TIMEOUT_MS }, (err2, stdout2) => {
          if (err2) return resolve(null);
          // Output contains a dict variant — look for "pid" entry
          const pidMatch = stdout2.match(/pid[^\d]*(\d+)/i);
          if (pidMatch) {
            const pid = parseInt(pidMatch[1], 10);
            if (Number.isFinite(pid) && pid > 0) return resolve(pid);
          }
          resolve(null);
        });
      });
    });
  },

  /**
   * Plasma 5.27+: use KWin scripting interface to evaluate JS and
   * return PID.
   *
   *   qdbus org.kde.KWin /Scripting \
   *         org.kde.kwin.Scripting.evaluateScript \
   *         "workspace.activeClient.pid"
   *
   * @returns {Promise<number|null>}
   */
  _queryPlasma5() {
    return new Promise((resolve) => {
      child_process.execFile('qdbus', [
        'org.kde.KWin', '/Scripting',
        'org.kde.kwin.Scripting.evaluateScript',
        'workspace.activeClient.pid',
      ], { timeout: QDBUS_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve(null);
        const match = stdout.match(/(\d+)/);
        if (match) {
          const pid = parseInt(match[1], 10);
          if (Number.isFinite(pid) && pid > 0) return resolve(pid);
        }
        resolve(null);
      });
    });
  },

  /**
   * Cleanup. No-op — the plugin is stateless (no timers, no listeners,
   * no file handles).
   */
  destroy() {
    this._cachePid = null;
    this._cacheTs = 0;
  },
};

module.exports = plugin;
