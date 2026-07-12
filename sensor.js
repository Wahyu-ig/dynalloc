'use strict';

/**
 * DynAlloc — Sensor Module
 *
 * Reads system telemetry: PSI, process list, foreground window,
 * and GameMode status. Also provides CPU history with moving average.
 *
 * v2.1: Fixed path import ordering, added timeout cleanup in exec helpers,
 *        proper error handling, no dangling timers.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const logger = require('./logger');

const { debug, info, warn, error } = logger;

// ── CPU History (circular buffer with moving average) ────────────────

class CpuHistory {
  constructor(size = 5) {
    this._maxSize = Math.max(1, Math.min(size, 60));
    this._cpuSamples = [];
    this._memSamples = [];
  }

  resize(newSize) {
    this._maxSize = Math.max(1, Math.min(newSize, 60));
    while (this._cpuSamples.length > this._maxSize) this._cpuSamples.shift();
    while (this._memSamples.length > this._maxSize) this._memSamples.shift();
  }

  push(sample) {
    if (typeof sample.cpuAvg10 !== 'number' || typeof sample.memAvg10 !== 'number') return;
    this._cpuSamples.push(sample.cpuAvg10);
    this._memSamples.push(sample.memAvg10);
    while (this._cpuSamples.length > this._maxSize) this._cpuSamples.shift();
    while (this._memSamples.length > this._maxSize) this._memSamples.shift();
  }

  get cpuAvg() {
    if (this._cpuSamples.length === 0) return 0;
    return this._cpuSamples.reduce((a, b) => a + b, 0) / this._cpuSamples.length;
  }

  get memAvg() {
    if (this._memSamples.length === 0) return 0;
    return this._memSamples.reduce((a, b) => a + b, 0) / this._memSamples.length;
  }

  get count() { return this._cpuSamples.length; }
  get size() { return this._maxSize; }

  get cpuSamples() { return [...this._cpuSamples]; }
  get memSamples() { return [...this._memSamples]; }

  clear() {
    this._cpuSamples = [];
    this._memSamples = [];
  }
}

// ── PSI Reader ───────────────────────────────────────────────────────

function readPSI(psiPath) {
  try {
    const validatedPath = validateSysPath(psiPath);
    if (!validatedPath) return null;

    const raw = fs.readFileSync(validatedPath, 'utf8');
    const result = {};
    for (const line of raw.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 0) continue;
      const kind = parts[0];
      const parsed = {};
      for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split('=');
        if (k && v !== undefined) {
          parsed[k] = parseFloat(v);
        }
      }
      result[kind] = parsed;
    }
    return result;
  } catch (err) {
    warn(`Gagal membaca PSI dari ${psiPath}: ${err.message}`);
    return null;
  }
}

function readCpuPSI() {
  return readPSI('/proc/pressure/cpu');
}

function readMemPSI() {
  return readPSI('/proc/pressure/memory');
}

// ── Foreground PID Detection ─────────────────────────────────────────
//
// v2.1.4: Universal foreground detection — supports Hyprland, GNOME/Wayland,
// KDE Plasma (X11 & Wayland), Sway, River, and any X11 desktop.
//
// Detection order (per session):
//   1. Hyprland            — hyprctl activewindow -j
//   2. Sway                — swaymsg -t get_tree (parse focused window)
//   3. KDE Plasma Wayland  — qdbus org.kde.KWin (Plasma 5.27+) OR kdotool
//   4. GNOME/Wayland       — gdbus Window Calls Extended extension
//   5. X11 (any DE)        — xdotool getactivewindow getwindowpid
//
// Each detector has a 3s timeout and gracefully rejects on failure so the
// next in the chain can try. If all fail, resolve(null) — the daemon
// continues without foreground tracking (throttling still works by name).

function _detectSession() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const sessionType = process.env.XDG_SESSION_TYPE || '';
  const waylandDisplay = !!process.env.WAYLAND_DISPLAY;
  return {
    isHyprland: !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
    isSway: !!process.env.SWAYSOCK || desktop.includes('sway'),
    isKde: desktop.includes('kde'),
    isGnome: desktop.includes('gnome'),
    isWayland: sessionType === 'wayland' || waylandDisplay,
    isX11: sessionType === 'x11',
    desktop,
    sessionType,
  };
}

function getForegroundPID() {
  return new Promise((resolve) => {
    const s = _detectSession();
    // Build the chain of detectors to try, in priority order.
    const chain = [];
    if (s.isHyprland) {
      chain.push(_hyprlandFocus);
    }
    if (s.isSway) {
      chain.push(_swayFocus);
    }
    if (s.isKde && s.isWayland) {
      chain.push(_kdeWaylandFocus);
      chain.push(_kdotoolFocus);
    }
    if (s.isGnome && s.isWayland) {
      chain.push(_gnomeFocusPid);
    }
    // X11 / generic / last-resort fallback
    chain.push(_xdotoolFocus);

    // Run detectors sequentially; resolve on first non-null result.
    const runNext = (idx) => {
      if (idx >= chain.length) {
        resolve(null);
        return;
      }
      const detector = chain[idx];
      detector()
        .then((pid) => {
          if (typeof pid === 'number' && pid > 0) {
            resolve(pid);
          } else {
            runNext(idx + 1);
          }
        })
        .catch(() => runNext(idx + 1));
    };
    runNext(0);
  });
}

function getProcessInfo(pid) {
  if (typeof pid !== 'number' || pid <= 0) return null;
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    const rawCmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const cmdline = rawCmdline.replace(/\0+/g, ' ').trim();
    const name = comm || (cmdline.split(' ')[0] || '').split('/').pop() || `PID ${pid}`;
    return { pid, comm, cmdline, name };
  } catch (_) {
    return null;
  }
}

/**
 * Get the start-time of a process from /proc/<pid>/stat.
 *
 * The start-time is field 22 (clock ticks since boot). It is unique per
 * process invocation — when a PID is reused by a different process, the
 * start-time changes. This makes it safe to use as a "process identity
 * token" for crash-recovery validation.
 *
 * Returns:
 *   - number (clock ticks) on success
 *   - null if the PID is dead, /proc is unavailable, or parsing fails
 *
 * Used by rollback.js to detect PID reuse: if the saved start-time
 * doesn't match the current process at that PID, the original process
 * has exited and the PID was recycled — we MUST NOT restore state to
 * the new (unrelated) process.
 *
 * v2.1.5: added to fix PID reuse vulnerability in recoverFromCrash().
 */
function getPidStartTime(pid) {
  if (typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) return null;
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (_) {
    return null; // PID dead or /proc not mounted
  }
  // /proc/<pid>/stat format:
  //   pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt
  //   majflt cmajflt utime stime cutime cstime priority nice num_threads
  //   itrealvalue starttime ...
  //
  // The comm field is in parentheses AND MAY CONTAIN SPACES OR PARENS
  // (e.g. "(chrome (renderer))"). The safe parse is to find the LAST ')'
  // and split the rest by whitespace. After the closing paren, the fields
  // are: state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5) flags(6)
  //   minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12)
  //   cutime(13) cstime(14) priority(15) nice(16) num_threads(17)
  //   itrealvalue(18) starttime(19)
  const lastParen = raw.lastIndexOf(')');
  if (lastParen === -1) return null;
  const afterComm = raw.slice(lastParen + 1).trim().split(/\s+/);
  if (afterComm.length < 20) return null;
  const starttime = parseInt(afterComm[19], 10);
  return Number.isFinite(starttime) ? starttime : null;
}

function _hyprlandFocus() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('hyprctl timeout'));
    }, 3000);
    execFile('hyprctl', ['activewindow', '-j'], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        if (data && typeof data.pid === 'number' && data.pid > 0) return resolve(data.pid);
      } catch (_) { /* parse failed */ }
      reject(new Error('hyprctl parse failed'));
    });
  });
}

function _gnomeFocusPid() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('gdbus timeout'));
    }, 3000);
    execFile(
      'gdbus',
      [
        'call', '--session',
        '--dest', 'org.gnome.Shell',
        '--object-path', '/org/gnome/Shell/Extensions/WindowsExt',
        '--method', 'org.gnome.Shell.Extensions.WindowsExt.FocusPID',
      ],
      { timeout: 3000 },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) {
          return reject(
            new Error('GNOME FocusPID gagal — pastikan extension "Window Calls Extended" terpasang.')
          );
        }
        const match = stdout.match(/(\d+)/);
        if (!match) return reject(new Error('Tidak bisa parse output FocusPID'));
        const pid = parseInt(match[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) return reject(new Error('Invalid PID from FocusPID'));
        resolve(pid);
      }
    );
  });
}

/**
 * Sway foreground detection via `swaymsg -t get_tree`.
 * Returns a JSON tree of all windows; we walk it to find the focused one.
 *
 * Output structure (simplified):
 *   { nodes: [...], focus: [id1, id2, ...] }
 * Each node has the same shape. The first entry in `focus` is the
 * active one at that level. We recurse into focused nodes until we
 * find a node with a `pid` (actual window, not a container).
 */
function _swayFocus() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('swaymsg timeout'));
    }, 3000);
    execFile('swaymsg', ['-t', 'get_tree'], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) return reject(err);
      try {
        const tree = JSON.parse(stdout);
        const pid = _swayFindFocusedPid(tree);
        if (typeof pid === 'number' && pid > 0) return resolve(pid);
        reject(new Error('swaymsg: no focused window with PID'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('swaymsg parse failed'));
      }
    });
  });
}

function _swayFindFocusedPid(node) {
  if (!node || typeof node !== 'object') return null;
  // If this node is a window with a PID and is focused, return it.
  // `focused: true` is set on the actual active window.
  if (node.focused === true && typeof node.pid === 'number' && node.pid > 0) {
    return node.pid;
  }
  // Walk focus list first (the order sway reports focus = stacking order)
  if (Array.isArray(node.focus)) {
    for (const id of node.focus) {
      // Find the node with this id
      const child = _swayFindNodeById(node, id);
      if (child) {
        const pid = _swayFindFocusedPid(child);
        if (pid) return pid;
      }
    }
  }
  // Walk nodes and floating_nodes recursively
  for (const key of ['nodes', 'floating_nodes']) {
    if (Array.isArray(node[key])) {
      for (const child of node[key]) {
        const pid = _swayFindFocusedPid(child);
        if (pid) return pid;
      }
    }
  }
  return null;
}

function _swayFindNodeById(root, id) {
  if (!root || typeof root !== 'object') return null;
  if (root.id === id) return root;
  for (const key of ['nodes', 'floating_nodes']) {
    if (Array.isArray(root[key])) {
      for (const child of root[key]) {
        const found = _swayFindNodeById(child, id);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * KDE Plasma Wayland foreground detection.
 *
 * Strategy (try each in order):
 *   1. Plasma 6: qdbus org.kde.KWin /org/kde/KWin WindowManagement
 *      → property ActiveWindow → GetWindowInfo → "pid"
 *   2. Plasma 5.27+: qdbus org.kde.KWin /Scripting runScript
 *      → returns JS output with workspace.activeClient.pid
 *   3. kdotool (third-party, mirrors xdotool for KWin):
 *      → kdotool search --active --name ""
 *
 * Each sub-strategy has its own timeout; first one to return a valid PID wins.
 */
function _kdeWaylandFocus() {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const tryStrategy = (fn) => new Promise((res, rej) => {
      fn().then(res).catch(rej);
    });

    // Run strategies in order
    const strategies = [
      _kdePlasma6ActiveWindow,
      _kdePlasma5Scripting,
    ];

    const runNext = (idx) => {
      if (resolved || idx >= strategies.length) {
        if (!resolved) reject(new Error('all KDE strategies failed'));
        return;
      }
      tryStrategy(strategies[idx])
        .then((pid) => {
          if (resolved) return;
          if (typeof pid === 'number' && pid > 0) {
            resolved = true;
            resolve(pid);
          } else {
            runNext(idx + 1);
          }
        })
        .catch(() => runNext(idx + 1));
    };
    runNext(0);
  });
}

/**
 * Plasma 6: query the WindowManagement DBus interface.
 * Property: ActiveWindow (uint32 window id)
 * Method: GetWindowInfo(uint32) → a{sv} dict with "pid" key
 */
function _kdePlasma6ActiveWindow() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('qdbus Plasma 6 timeout')), 3000);
    // Step 1: get active window id
    execFile('qdbus', [
      'org.kde.KWin', '/org/kde/KWin/WindowManagement',
      'org.freedesktop.DBus.Properties.Get',
      'org.kde.KWin.WindowManagement', 'ActiveWindow',
    ], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) return reject(err);
      // Output is like: "uint32 12345"
      const match = stdout.match(/(\d+)/);
      if (!match) return reject(new Error('no active window id'));
      const windowId = parseInt(match[1], 10);
      if (!Number.isFinite(windowId) || windowId === 0) {
        return reject(new Error('invalid window id'));
      }
      // Step 2: query window info for the PID
      execFile('qdbus', [
        'org.kde.KWin', '/org/kde/KWin/WindowManagement',
        'org.kde.KWin.WindowManagement.GetWindowInfo',
        String(windowId),
      ], { timeout: 3000 }, (err2, stdout2) => {
        if (err2) return reject(err2);
        // Output contains a dict variant — look for "pid" entry
        const pidMatch = stdout2.match(/pid[^\d]*(\d+)/i);
        if (pidMatch) {
          const pid = parseInt(pidMatch[1], 10);
          if (Number.isFinite(pid) && pid > 0) return resolve(pid);
        }
        reject(new Error('no pid in window info'));
      });
    });
  });
}

/**
 * Plasma 5.27+: use KWin scripting interface to evaluate JS and return PID.
 * The script writes to KWin's console log, which we capture via --literal.
 */
function _kdePlasma5Scripting() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('qdbus Plasma 5 timeout')), 3000);
    // workspace.activeClient returns the active Client object
    // .pid is the process ID
    execFile('qdbus', [
      'org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.evaluateScript',
      'workspace.activeClient.pid',
    ], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) return reject(err);
      const match = stdout.match(/(\d+)/);
      if (match) {
        const pid = parseInt(match[1], 10);
        if (Number.isFinite(pid) && pid > 0) return resolve(pid);
      }
      reject(new Error('no pid from KWin scripting'));
    });
  });
}

/**
 * kdotool — third-party tool that mirrors xdotool for KWin (Wayland).
 * Available in some distros as `kdotool` package (from kdotools project).
 * `kdotool getactivewindow getwindowpid` mirrors xdotool's interface.
 */
function _kdotoolFocus() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, 3000);
    execFile('kdotool', ['getactivewindow', 'getwindowpid'], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) { resolve(null); return; }
      const pid = parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

function _xdotoolFocus() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, 3000);
    execFile('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 3000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err) { resolve(null); return; }
      const pid = parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

// ── Process Listing ──────────────────────────────────────────────────

function listProcesses() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('ps timeout'));
    }, 10000);
    execFile(
      'ps',
      ['-eo', 'pid,ppid,pcpu,comm', '--no-headers'],
      { maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) return reject(err);
        const procs = stdout
          .trim()
          .split('\n')
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) return null;
            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);
            const pcpu = parseFloat(parts[2]);
            const comm = parts.slice(3).join(' ');
            if (!Number.isFinite(pid) || pid <= 0) return null;
            return { pid, ppid, pcpu, comm };
          })
          .filter(Boolean);
        resolve(procs);
      }
    );
  });
}

// ── GameMode Query ───────────────────────────────────────────────────

function isGameModeActive(pid) {
  return new Promise((resolve) => {
    if (typeof pid !== 'number' || pid <= 0) { resolve(0); return; }
    const timeout = setTimeout(() => {
      resolve(0);
    }, 3000);
    execFile(
      'gdbus',
      [
        'call', '--session',
        '--dest', 'com.feralinteractive.GameMode',
        '--object-path', '/com/feralinteractive/GameMode',
        '--method', 'com.feralinteractive.GameMode.QueryStatus',
        String(pid),
      ],
      { timeout: 3000 },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) { resolve(0); return; }
        const match = stdout.match(/\((-?\d+),?\)/);
        resolve(match ? parseInt(match[1], 10) : 0);
      }
    );
  });
}

// ── Power Profiles Daemon (PPD) Detection ────────────────────────────
//
// v2.1.7: power-profiles-daemon (PPD) is the default power management
// daemon on Fedora, Ubuntu, GNOME, and KDE Plasma. It manages CPU
// governor switching via its own DBus interface. If DynAlloc also
// switches governors, the two daemons fight — PPD sets "powersave",
// DynAlloc sets "performance" 5 seconds later, PPD sets "powersave"
// again, etc.
//
// To avoid this conflict, we detect PPD at startup. If it's running,
// we mute DynAlloc's governor switching (set ENABLE_GOVERNOR_SWITCH=false
// at runtime) and log a warning so the user knows.
//
// PPD DBus interface:
//   Bus:       system
//   Service:   net.hadess.PowerProfiles
//   Object:    /net/hadess/PowerProfiles
//   Property:  ActiveProfile (string: "power-saver" | "balanced" | "performance")
//   Property:  Profiles (array of dicts with "Profile" key)

/**
 * Synchronously check if power-profiles-daemon (PPD) is running and
 * accessible on the system DBus.
 *
 * Returns:
 *   - { active: true, profile: "balanced" } if PPD is running
 *   - { active: false } if PPD is not running or DBus is unavailable
 *
 * This is synchronous because it's called during bootstrap (before the
 * event loop is fully spun up) and we need the result before deciding
 * whether to enable governor switching.
 *
 * v2.1.7: added to coordinate with PPD and avoid governor conflicts.
 */
function checkPowerProfilesDaemon() {
  try {
    const result = execFileSync(
      'gdbus',
      [
        'call', '--system',
        '--dest', 'net.hadess.PowerProfiles',
        '--object-path', '/net/hadess/PowerProfiles',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'net.hadess.PowerProfiles', 'ActiveProfile',
      ],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    // Output format: (<uint32 0>, '<"balanced">')  — the profile is in
    // the second element, wrapped in single quotes inside angle brackets.
    const profileMatch = result.match(/<["']([^"']+)["']>/);
    if (profileMatch) {
      return { active: true, profile: profileMatch[1] };
    }
    // If we got a response but couldn't parse the profile, PPD is still
    // running — we just don't know which profile.
    return { active: true, profile: 'unknown' };
  } catch (_) {
    // gdbus not installed, PPD not running, or DBus unavailable.
    return { active: false };
  }
}

/**
 * Async version of checkPowerProfilesDaemon — for use in tick loops
 * or when you want to avoid blocking the event loop.
 */
function isPowerProfilesDaemonActive() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ active: false });
    }, 3000);
    execFile(
      'gdbus',
      [
        'call', '--system',
        '--dest', 'net.hadess.PowerProfiles',
        '--object-path', '/net/hadess/PowerProfiles',
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'net.hadess.PowerProfiles', 'ActiveProfile',
      ],
      { timeout: 3000 },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) { resolve({ active: false }); return; }
        const profileMatch = (stdout || '').match(/<["']([^"']+)["']>/);
        if (profileMatch) {
          resolve({ active: true, profile: profileMatch[1] });
        } else {
          resolve({ active: true, profile: 'unknown' });
        }
      }
    );
  });
}

// ── D-Bus Focus Monitor (event-driven) ───────────────────────────────

function watchFocusChanges(onFocusChanged) {
  const { spawn } = require('child_process');
  let child;
  try {
    child = spawn('gdbus', [
      'monitor', '--session',
      '--dest', 'org.gnome.Shell',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return null;
  }

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.includes('WindowsExt') && /FocusChanged|FocusPID|focus/i.test(line)) {
        _gnomeFocusPid().then((pid) => {
          if (pid) onFocusChanged(pid);
        }).catch(() => { /* query failed, skip */ });
      }
    }
  });

  child.on('error', (err) => {
    warn(`gdbus monitor error: ${err.message}`);
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch (_) { /* already dead */ }
    }
  });

  return child;
}

// ── Battery & Thermal (for adaptive scheduler) ───────────────────────

function readBatteryStatus(batteryPath) {
  try {
    const validated = validateSysPath(batteryPath);
    if (!validated) return null;

    const type = fs.readFileSync(path.join(validated, 'type'), 'utf8').trim();
    if (type !== 'Battery') return null;

    // NOTE: The `online` attribute only exists on AC adapter (Mains) nodes
    // (e.g. /sys/class/power_supply/ADP1/online), NOT on Battery nodes
    // (/sys/class/power_supply/BAT0/). Reading `online` on a Battery node
    // throws ENOENT and used to short-circuit the whole function to null,
    // disabling every battery-aware feature on real hardware.
    //
    // The correct attribute on a Battery node is `status`, which is one of
    // "Discharging" | "Charging" | "Full" | "Not charging" | "Unknown".
    // We treat "Discharging" as on-battery; anything else (including the
    // file being missing) is treated as on AC power.
    const capacity = parseInt(
      fs.readFileSync(path.join(validated, 'capacity'), 'utf8').trim(), 10
    );

    let onBattery = false;
    try {
      const status = fs.readFileSync(path.join(validated, 'status'), 'utf8').trim();
      onBattery = status === 'Discharging';
    } catch (_) {
      // No status file — assume plugged in (safer default than falsely
      // triggering battery-low rules on a desktop without battery).
      onBattery = false;
    }

    return {
      onBattery,
      capacity: Number.isFinite(capacity) ? capacity : 100,
    };
  } catch (_) {
    return null;
  }
}

function readThermalTemp(zoneIndex = 0) {
  try {
    const idx = typeof zoneIndex === 'number' && zoneIndex >= 0 ? zoneIndex : 0;
    const tempRaw = fs.readFileSync(
      `/sys/class/thermal/thermal_zone${idx}/temp`, 'utf8'
    ).trim();
    const tempMilliC = parseInt(tempRaw, 10);
    if (!Number.isFinite(tempMilliC)) return null;
    return tempMilliC / 1000;
  } catch (_) {
    return null;
  }
}

// ── Path Validation ──────────────────────────────────────────────────

/**
 * Validate sysfs/proc paths to prevent path traversal.
 * Only allows paths starting with /proc/ or /sys/.
 */
function validateSysPath(p) {
  if (typeof p !== 'string') return null;
  if (p.includes('\0') || p.includes('..')) return null;
  const normalized = path.resolve(p);
  if (normalized.startsWith('/proc/') || normalized.startsWith('/sys/')) {
    return normalized;
  }
  return null;
}

// ── systemd Unit Name Detection (v2.1.10) ────────────────────────────
//
// Read /proc/<pid>/cgroup to extract the systemd service name. The cgroup
// path looks like:
//   0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-firefox@1000.service
//   0::/system.slice/sshd.service
//
// We extract the last ".service" component, which is the systemd unit name.
// This is more reliable than comm name (which can be truncated to 15 chars
// or renamed via prctl).

function getSystemdUnit(pid) {
  if (typeof pid !== 'number' || pid <= 0) return null;
  try {
    const cgroupRaw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    for (const line of cgroupRaw.trim().split('\n')) {
      // cgroup v2 format: "0::/path/to/cgroup"
      // cgroup v1 format: "ID:controllers:/path/to/cgroup"
      const parts = line.split(':');
      const path = parts[parts.length - 1];
      // Look for the last component ending in .service
      const serviceMatch = path.match(/\/([^/]+\.service)(?:\/|$)/);
      if (serviceMatch) {
        return serviceMatch[1];
      }
    }
  } catch (_) { /* PID dead or /proc unavailable */ }
  return null;
}

// ── GPU Utilization Detection (v2.1.10) ──────────────────────────────
//
// Detect GPU type and read utilization. Supports:
//   - NVIDIA: nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits
//   - Intel:  intel_gpu_top -l 1 (parse "GFX FIFO:  XX%")
//   - AMD:    radeontop -d -1 (parse "gpu XX%")
//
// Returns: { type: 'nvidia'|'intel'|'amd'|'none', utilization: number|null }
// utilization is 0-100 or null if unavailable.

let _gpuType = null; // cache: 'nvidia' | 'intel' | 'amd' | 'none'

function getGpuUtilization() {
  // Detect GPU type on first call, then cache
  if (_gpuType === null) {
    _gpuType = _detectGpuType();
  }
  if (_gpuType === 'none') return { type: 'none', utilization: null };

  try {
    if (_gpuType === 'nvidia') {
      const out = execFileSync('nvidia-smi',
        ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      const util = parseInt(out, 10);
      return { type: 'nvidia', utilization: Number.isFinite(util) ? util : null };
    }
    if (_gpuType === 'intel') {
      const out = execFileSync('intel_gpu_top', ['-l', '1'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const match = out.match(/GFX[^\d]*(\d+)%/);
      if (match) {
        const util = parseInt(match[1], 10);
        return { type: 'intel', utilization: util };
      }
      return { type: 'intel', utilization: null };
    }
    if (_gpuType === 'amd') {
      const out = execFileSync('radeontop', ['-d', '-1'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const match = out.match(/gpu\s+(\d+)%/i);
      if (match) {
        const util = parseInt(match[1], 10);
        return { type: 'amd', utilization: util };
      }
      return { type: 'amd', utilization: null };
    }
  } catch (_) { /* GPU tool unavailable or failed */ }
  return { type: _gpuType, utilization: null };
}

function _detectGpuType() {
  // Check for NVIDIA
  try {
    execFileSync('nvidia-smi', ['--version'],
      { stdio: 'ignore', timeout: 1000, encoding: 'utf8' });
    return 'nvidia';
  } catch (_) { /* not NVIDIA */ }
  // Check for Intel
  try {
    execFileSync('intel_gpu_top', ['--version'],
      { stdio: 'ignore', timeout: 1000, encoding: 'utf8' });
    return 'intel';
  } catch (_) { /* not Intel */ }
  // Check for AMD
  try {
    execFileSync('radeontop', ['--version'],
      { stdio: 'ignore', timeout: 1000, encoding: 'utf8' });
    return 'amd';
  } catch (_) { /* not AMD */ }
  return 'none';
}

// ── Network RX Rate Detection (v2.1.10) ──────────────────────────────
//
// Read /proc/net/dev to get system-wide RX byte counters. When called
// twice with a time interval, compute the RX rate in KB/s. This is a
// system-wide metric — per-process network detection would require
// `ss -tunp` or /proc/<pid>/net/dev (which is system-wide on Linux).
//
// For per-process detection, use `ss -tunp` to find PIDs with active
// TCP/UDP connections and correlate with /proc/net/dev rate changes.
//
// Returns: { rxBytes: number, txBytes: number } or null on error.

let _lastNetDev = null;
let _lastNetDevTime = 0;

function getNetworkRxBytes() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    let rxTotal = 0;
    let txTotal = 0;
    for (const line of raw.trim().split('\n').slice(2)) { // skip headers
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      // Skip lo (loopback) — it's not real network traffic
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') continue;
      rxTotal += parseInt(parts[1], 10) || 0;
      txTotal += parseInt(parts[9], 10) || 0;
    }
    return { rxBytes: rxTotal, txBytes: txTotal };
  } catch (_) {
    return null;
  }
}

module.exports = {
  CpuHistory,
  readPSI,
  readCpuPSI,
  readMemPSI,
  getForegroundPID,
  getProcessInfo,
  getPidStartTime,
  listProcesses,
  isGameModeActive,
  watchFocusChanges,
  readBatteryStatus,
  readThermalTemp,
  validateSysPath,
  checkPowerProfilesDaemon,
  isPowerProfilesDaemonActive,
  getSystemdUnit,
  getGpuUtilization,
  getNetworkRxBytes,
  // Exported for testing / diagnostics
  _detectSession,
  _swayFindFocusedPid,
  _swayFindNodeById,
};