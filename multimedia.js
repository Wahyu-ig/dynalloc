'use strict';

/**
 * DynAlloc — Multimedia Detector Module
 *
 * Detects processes that are actively playing audio or video.
 * These processes are NEVER throttled regardless of scheduler state.
 *
 * v2.1: Fixed dangling timeout in _execAsync, proper cleanup,
 *        single pactl call instead of two, PID validation.
 */

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const logger = require('./logger');
const { debug, info, warn, trace } = logger;

// ── Known multimedia processes (by name) ─────────────────────────────

const MULTIMEDIA_PROCESS_NAMES = new Set([
  // Video players
  'mpv', 'mpv.net', 'vlc', 'vlc-wrapper',
  'celluloid', 'parole', 'totem', 'gnome-videos', 'smplayer', 'dragon', 'haruna',
  // OBS / streaming
  'obs', 'obs-studio', 'obs64',
  // Comms (voice)
  'discord', 'Discord', 'discord-canary', 'discord-ptb',
  'teamspeak3', 'ts3client',
  'mumble', 'Mumble',
  'zoom', 'Zoom',
  'skype', 'Skype',
  'teams', 'Teams',
  // Audio players
  'spotify', 'spotifyd', 'ncspot',
  'audacity',
  'amarok', 'clementine', 'strawberry', 'rhythmbox', 'pragha',
  'mpd', 'ncmpcpp', 'cmus', 'mocp',
  // Audio system (always active, never throttle)
  'pipewire', 'pipewire-pulse', 'wireplumber', 'pulseaudio',
  // Wallpaper video (must never pause)
  'mpvpaper', 'xwinwrap', 'swww', 'hyprpaper', 'swaybg',
  'wpaperd', 'glpaper', 'wallpaper-engine-kde',
]);

// ── Multimedia PID cache ─────────────────────────────────────────────

const _activeMediaPids = new Map();
const MEDIA_CACHE_TTL_MS = 5000;
let _lastDetectionTime = 0;
let _detectionInProgress = false;

// ── Public API ───────────────────────────────────────────────────────

function isKnownMediaProcessName(comm) {
  if (typeof comm !== 'string') return false;
  return MULTIMEDIA_PROCESS_NAMES.has(comm) ||
    MULTIMEDIA_PROCESS_NAMES.has(comm.split('[')[0].trim());
}

/**
 * Get the set of PIDs currently actively playing media.
 */
async function getActiveMediaPids(allPids, pidToComm) {
  const pidSet = new Set(allPids);
  const now = Date.now();

  // Return cached result if fresh enough
  if (now - _lastDetectionTime < MEDIA_CACHE_TTL_MS && !_detectionInProgress) {
    return _filterAlivePids(pidSet);
  }

  if (_detectionInProgress) {
    return _filterAlivePids(pidSet);
  }

  _detectionInProgress = true;
  try {
    const detected = new Set();

    // Layer 1: Name-based detection (always available)
    for (const pid of allPids) {
      if (typeof pid !== 'number' || pid <= 0) continue;
      const comm = pidToComm && pidToComm.get ? pidToComm.get(pid) : '';
      if (isKnownMediaProcessName(comm)) {
        detected.add(pid);
      }
    }

    // Layer 2: PipeWire stream detection
    const pwPids = await detectPipeWireStreams();
    for (const pid of pwPids) {
      if (typeof pid === 'number' && pid > 0 && pidSet.has(pid)) detected.add(pid);
    }

    // Layer 3: PulseAudio detection (fallback if PipeWire not in use)
    const paPids = await detectPulseAudioStreams();
    for (const pid of paPids) {
      if (typeof pid === 'number' && pid > 0 && pidSet.has(pid)) detected.add(pid);
    }

    // Update cache
    _activeMediaPids.clear();
    for (const pid of detected) {
      _activeMediaPids.set(pid, now);
    }
    _lastDetectionTime = now;

    return detected;
  } finally {
    _detectionInProgress = false;
  }
}

async function isPlayingMedia(pid) {
  return _activeMediaPids.has(pid);
}

function invalidateCache() {
  _lastDetectionTime = 0;
  _activeMediaPids.clear();
}

function _filterAlivePids(pidSet) {
  const cached = new Set();
  for (const [pid] of _activeMediaPids) {
    if (pidSet.has(pid)) cached.add(pid);
    else _activeMediaPids.delete(pid);
  }
  return cached;
}

// ── PipeWire Detection ───────────────────────────────────────────────

async function detectPipeWireStreams() {
  const pids = new Set();
  try {
    const result = await _execAsync('pw-cli', ['list-objects'], 3000);
    if (!result) return pids;

    const lines = result.split('\n');
    let currentPid = null;
    let hasMedia = false;

    for (const line of lines) {
      const pidMatch = line.match(/process\.pid\s*=\s*"?(\d+)"?/);
      if (pidMatch) {
        const parsed = parseInt(pidMatch[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          currentPid = parsed;
        }
        hasMedia = false;
      }
      if (line.includes('media.class') &&
          (line.includes('Audio') || line.includes('Video') || line.includes('Stream'))) {
        hasMedia = true;
      }
      if (currentPid && hasMedia &&
          (line.includes('state = "running"') || line.includes('state\t"running"'))) {
        pids.add(currentPid);
      }
    }
  } catch (_) {
    // pw-cli not available
  }

  // Fallback: check pw-top for active streams
  if (pids.size === 0) {
    try {
      const pwTop = await _execPwTop();
      for (const pid of pwTop) pids.add(pid);
    } catch (_) { /* pw-top not available */ }
  }

  return pids;
}

async function _execPwTop() {
  // BUG FIX (v2.1.2): pw-top output's first column is the node NAME
  // (e.g. "alsa_output.pci-..."), NOT a PID. The previous parser tried
  // to parseInt(parts[0]) which always returned NaN for node names, so
  // this fallback NEVER found any PIDs — it was dead code.
  //
  // pw-top doesn't expose PIDs directly at all (it's a node-level view,
  // not a process-level view). The only way to get PIDs from PipeWire is
  // via `pw-cli list-objects` (which IS what detectPipeWireStreams uses
  // as the primary method). So this pw-top fallback is fundamentally
  // unable to produce PIDs.
  //
  // Rather than silently returning empty (which triggers the
  // PulseAudio fallback unnecessarily), we now explicitly return empty
  // with a debug log so operators know pw-top was tried but can't help.
  return new Promise((resolve) => {
    let resolved = false;
    const child = execFile('pw-top', ['-b', '-n', '1'], { timeout: 3000 }, (err) => {
      if (resolved) return;
      resolved = true;
      if (err) { resolve(new Set()); return; }
      // pw-top doesn't expose PIDs — see comment above.
      debug('pw-top fallback tidak bisa ekstrak PID (pw-top tidak expose PID per node)');
      resolve(new Set());
    });
    // Safety timeout - if execFile timeout doesn't fire
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch (_) { /* already dead */ }
      resolve(new Set());
    }, 4000);
    child.on('exit', () => { clearTimeout(timer); });
  });
}

// ── PulseAudio Detection (fallback) ───────────────────────────────────

async function detectPulseAudioStreams() {
  const pids = new Set();
  try {
    // Single call with full format
    const fullResult = await _execAsync('pactl', ['list', 'sink-inputs'], 3000);
    if (!fullResult) return pids;

    const blocks = fullResult.split('Sink Input #').filter(Boolean);
    for (const block of blocks) {
      if (!block.includes('State: RUNNING')) continue;

      const pidMatch = block.match(/application\.process\.id\s*=\s*"?(\d+)"?/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
        continue;
      }

      const binaryMatch = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/);
      if (binaryMatch) {
        const binary = binaryMatch[1].replace(/[^\w.\-]/g, '');
        if (!binary) continue;
        try {
          const pidOutput = execFileSync(
            'pgrep', ['-x', binary], { encoding: 'utf8', timeout: 1000 }
          ).trim();
          for (const line of pidOutput.split('\n')) {
            const pid = parseInt(line, 10);
            if (Number.isFinite(pid) && pid > 0) pids.add(pid);
          }
        } catch (_) { /* pgrep failed */ }
      }
    }
  } catch (_) {
    // PulseAudio not available
  }
  return pids;
}

// ── Helpers ───────────────────────────────────────────────────────────

function _execAsync(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let resolved = false;
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (err || !stdout) { resolve(null); return; }
      resolve(stdout);
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch (_) { /* already dead */ }
      resolve(null);
    }, timeoutMs + 500);
    child.on('exit', () => { clearTimeout(timer); });
  });
}

/**
 * Reset internal state (for testing).
 */
function resetState() {
  _activeMediaPids.clear();
  _lastDetectionTime = 0;
  _detectionInProgress = false;
}

module.exports = {
  MULTIMEDIA_PROCESS_NAMES,
  isKnownMediaProcessName,
  getActiveMediaPids,
  isPlayingMedia,
  invalidateCache,
  detectPipeWireStreams,
  detectPulseAudioStreams,
  resetState,
};