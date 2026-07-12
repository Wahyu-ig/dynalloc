'use strict';

/**
 * DynAlloc — Detector Layer :: Workload Detector
 * ===============================================
 *
 * Classifies the foreground process into a workload domain:
 *
 *   GAME       — Steam / Proton / Wine / Unity / Godot / native games
 *   IDE        — VS Code, JetBrains, Vim, Emacs, etc.
 *   BROWSER    — Firefox, Chrome, Chromium, Brave, etc.
 *   RENDERER   — OBS, Blender, Kdenlive, ffmpeg (audio/video production)
 *   VIRTUALIZATION — QEMU, VirtualBox, VMware, container runtime
 *   COMPILER   — gcc, rustc, javac, node, deno (build workload)
 *   MULTIMEDIA — mpv, vlc, spotify, audacity (media playback)
 *   COMMUNICATION — Discord, Slack, Teams, Zoom, Skype
 *   UNKNOWN    — unclassified
 *
 * This detector reads from the existing `classifier.js` patterns
 * (single source of truth for process-name regexes) rather than
 * duplicating them. It exposes a higher-level "workload" enum that
 * maps multiple classifier categories to one workload:
 *
 *   classifier category    → workload
 *   ─────────────────────────────────────────
 *   GAME, STEAM, LUTRIS, WINE, PROTON  → GAME
 *   IDE                                → IDE
 *   BROWSER, ELECTRON                  → BROWSER
 *   STREAMING                          → RENDERER
 *   VM, CONTAINER                      → VIRTUALIZATION
 *   COMPILER                           → COMPILER
 *   AUDIO, VIDEO, WALLPAPER            → MULTIMEDIA
 *   SYSTEM, DAEMON, FLATPAK, SNAP, UNKNOWN → UNKNOWN
 *
 * Detection logic:
 *
 *   1. Read foreground PID from context.
 *   2. Look up its comm in the process list (or use foregroundInfo).
 *   3. Classify via `classifier.classifyByComm()`.
 *   4. Map to workload domain.
 *   5. Emit `onWorkloadDetected` event when classification changes
 *      (hysteresis — only emit on transition, not every tick).
 *
 * Confidence:
 *
 *   - Direct name match (e.g. "firefox"): 0.95
 *   - Electron child of known parent: 0.85
 *   - Flatpak/Snap cgroup match: 0.80
 *   - UNKNOWN: 0.30 (low confidence — we just don't know)
 *
 * Backward compatibility: only runs when ENABLE_DETECTOR_LAYER=true.
 * Reads from `classifier.js` (existing module) without modifying it.
 */

const BaseDetector = require('./base-detector');
const classifier = require('../classifier');
const { debug, warn } = require('../logger');

// ── Constants ────────────────────────────────────────────────────────

// Classifier category → workload domain mapping.
// Categories not listed here default to UNKNOWN.
const CATEGORY_TO_WORKLOAD = Object.freeze({
  GAME: 'GAME',
  STEAM: 'GAME',
  LUTRIS: 'GAME',
  WINE: 'GAME',
  PROTON: 'GAME',
  IDE: 'IDE',
  BROWSER: 'BROWSER',
  ELECTRON: 'BROWSER',
  STREAMING: 'RENDERER',
  VM: 'VIRTUALIZATION',
  CONTAINER: 'VIRTUALIZATION',
  COMPILER: 'COMPILER',
  AUDIO: 'MULTIMEDIA',
  VIDEO: 'MULTIMEDIA',
  WALLPAPER: 'MULTIMEDIA',
  // SYSTEM, DAEMON, FLATPAK, SNAP, UNKNOWN → not a "workload"
});

const VALID_WORKLOADS = Object.freeze(new Set([
  'GAME', 'IDE', 'BROWSER', 'RENDERER', 'VIRTUALIZATION',
  'COMPILER', 'MULTIMEDIA', 'COMMUNICATION', 'UNKNOWN',
]));

// Confidence scores per classification path.
const CONFIDENCE = Object.freeze({
  DIRECT_NAME: 0.95,
  ELECTRON_CHILD: 0.85,
  FLATPAK_OR_SNAP: 0.80,
  UNKNOWN: 0.30,
});

// ── WorkloadDetector class ───────────────────────────────────────────

class WorkloadDetector extends BaseDetector {
  constructor(deps) {
    super('workload', deps);
    this._lastWorkload = null;        // last classification emitted
    this._lastForegroundPid = null;
    this._detectionCount = 0;
  }

  isAvailable() {
    // Always available — depends only on the classifier module,
    // which is a pure JS module with no system dependencies.
    return true;
  }

  setup() {
    // Emit baseline on first tick (lazy — handled in detect()).
  }

  detect(context) {
    if (!context || context.foregroundPid === null) {
      // No foreground — emit a "NONE" classification if we had one before.
      if (this._lastWorkload !== null) {
        this._lastWorkload = null;
        this._lastForegroundPid = null;
        const detection = this._makeDetection({
          workload: 'NONE',
          confidence: 1.0,
          pid: null,
          comm: '',
          category: 'UNKNOWN',
          source: 'no-foreground',
        });
        this._emitWorkloadEvent(detection);
        return [detection];
      }
      return [];
    }

    // Foreground changed — reset last classification so we emit a new event.
    if (context.foregroundPid !== this._lastForegroundPid) {
      this._lastWorkload = null;
      this._lastForegroundPid = context.foregroundPid;
    }

    // Find the foreground process info
    let comm = '';
    let cmdline = '';
    if (context.foregroundInfo) {
      comm = context.foregroundInfo.comm || '';
      cmdline = context.foregroundInfo.cmdline || '';
    } else if (context.procs.length > 0) {
      const proc = context.findProc(context.foregroundPid);
      if (proc) comm = proc.comm || '';
    }

    if (!comm) {
      // Cannot determine comm this tick. This happens on every
      // fastTick (which doesn't populate foregroundInfo or procs)
      // and on slowTicks where the foreground process exited between
      // detection and classification.
      //
      // Behavior:
      //   - If we already have a classification, KEEP it (return []).
      //     Downgrading to UNKNOWN just because fastTick can't see
      //     the comm would cause spurious transitions.
      //   - If we have NO classification yet (first tick), emit
      //     UNKNOWN so consumers know we tried but couldn't classify.
      if (this._lastWorkload !== null && this._lastWorkload !== 'UNKNOWN') {
        // Preserve existing classification — fastTick doesn't have
        // enough info to override it.
        return [];
      }
      // No classification yet (or already UNKNOWN) — emit UNKNOWN
      // only if not already UNKNOWN (hysteresis).
      if (this._lastWorkload !== 'UNKNOWN') {
        const detection = this._makeDetection({
          workload: 'UNKNOWN',
          confidence: CONFIDENCE.UNKNOWN,
          pid: context.foregroundPid,
          comm: '',
          category: 'UNKNOWN',
          source: 'no-comm',
        });
        this._lastWorkload = 'UNKNOWN';
        this._lastComm = '';
        this._emitWorkloadEvent(detection);
        return [detection];
      }
      return [];
    }

    // Classify via the existing classifier module
    let category = 'UNKNOWN';
    let source = 'name';
    try {
      category = classifier.classifyByComm(comm);
    } catch (err) {
      warn(`WorkloadDetector: classifyByComm threw for "${comm}": ${err.message}`);
      category = 'UNKNOWN';
      source = 'classify-error';
    }

    // Override category for Flatpak/Snap processes
    if (context.procs.length > 0 && context.foregroundPid) {
      try {
        if (classifier.isFlatpakProcess(context.foregroundPid)) {
          category = 'FLATPAK';
          source = 'flatpak-cgroup';
        } else if (classifier.isSnapProcess(context.foregroundPid)) {
          category = 'SNAP';
          source = 'snap-cgroup';
        }
      } catch (_) { /* best-effort — keep name-based classification */ }
    }

    // Check for Electron child of a known parent (only if we have procs)
    if (category === 'UNKNOWN' && context.procs.length > 0) {
      const proc = context.findProc(context.foregroundPid);
      if (proc && proc.ppid) {
        const parent = context.findProc(proc.ppid);
        if (parent) {
          try {
            const electronCat = classifier.classifyElectronChild(comm, parent.comm);
            if (electronCat === 'ELECTRON') {
              category = 'ELECTRON';
              source = 'electron-child';
            }
          } catch (_) { /* keep UNKNOWN */ }
        }
      }
    }

    // Map category → workload
    const workload = CATEGORY_TO_WORKLOAD[category] || 'UNKNOWN';

    // Compute confidence
    let confidence = CONFIDENCE.DIRECT_NAME;
    if (source === 'electron-child') confidence = CONFIDENCE.ELECTRON_CHILD;
    else if (source === 'flatpak-cgroup' || source === 'snap-cgroup') {
      confidence = CONFIDENCE.FLATPAK_OR_SNAP;
    }
    else if (workload === 'UNKNOWN') confidence = CONFIDENCE.UNKNOWN;

    // Hysteresis: only emit when workload changes (or comm changes
    // within the same workload, so the audit log captures app switches).
    const prevWorkload = this._lastWorkload;
    const changed = (prevWorkload !== workload) ||
                    (prevWorkload === workload && this._lastComm !== comm);

    if (!changed) {
      // Same workload + same comm — no new detection this tick.
      return [];
    }

    this._lastWorkload = workload;
    this._lastComm = comm;

    const detection = this._makeDetection({
      workload,
      confidence,
      pid: context.foregroundPid,
      comm,
      cmdline,
      category,
      source,
    });

    this._detectionCount++;
    this._emitWorkloadEvent(detection);
    return [detection];
  }

  // ── Internal ──────────────────────────────────────────────────────

  _makeDetection(fields) {
    return {
      detector: this.name,
      domain: 'workload',
      classification: fields.workload,
      confidence: fields.confidence,
      payload: {
        pid: fields.pid,
        comm: fields.comm,
        cmdline: fields.cmdline || '',
        category: fields.category,
        source: fields.source,
      },
      timestamp: new Date().toISOString(),
    };
  }

  _emitWorkloadEvent(detection) {
    if (!this.bus) return;
    try {
      this.bus.emit('onWorkloadDetected', {
        workload: detection.classification,
        confidence: detection.confidence,
        pid: detection.payload.pid,
        comm: detection.payload.comm,
        category: detection.payload.category,
        source: detection.payload.source,
        prevWorkload: this._lastWorkload,
        timestamp: detection.timestamp,
      });
    } catch (err) {
      debug(`WorkloadDetector: bus emit failed: ${err.message}`);
    }

    // Update shared state store so other detectors / rules can read it.
    if (this.stateStore) {
      try {
        this.stateStore.set('workload.classification', detection.classification);
        this.stateStore.set('workload.confidence', detection.confidence);
        this.stateStore.set('workload.comm', detection.payload.comm);
        this.stateStore.set('workload.pid', detection.payload.pid);
      } catch (_) { /* state store failure is non-fatal */ }
    }
  }

  getStatus() {
    return {
      name: this.name,
      available: this.isAvailable(),
      running: this.isRunning,
      lastWorkload: this._lastWorkload,
      lastForegroundPid: this._lastForegroundPid,
      detectionCount: this._detectionCount,
    };
  }
}

module.exports = WorkloadDetector;
module.exports.CATEGORY_TO_WORKLOAD = CATEGORY_TO_WORKLOAD;
module.exports.VALID_WORKLOADS = VALID_WORKLOADS;
module.exports.CONFIDENCE = CONFIDENCE;
