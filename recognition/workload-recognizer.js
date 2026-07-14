'use strict';

/**
 * DynAlloc — Recognition Layer :: Workload Recognizer
 * ====================================================
 *
 * The core recognition module. Takes detector events + system signals
 * and produces a confidence-scored workload classification.
 *
 * Recognition is DETERMINISTIC (no ML). It uses:
 *   - Process name patterns (from classifier.js via Phase 1 detector)
 *   - CPU/GPU/memory/IO utilization signals
 *   - Battery/AC state
 *   - Process count + process tree analysis
 *
 * Confidence model:
 *
 *   Each recognition source contributes a confidence boost (0.0-1.0).
 *   The final confidence is the weighted sum, clamped to [0, 1].
 *
 *   Sources:
 *     - Process name match:    0.50 (strong signal)
 *     - CPU utilization match: 0.20 (e.g. >50% CPU for compiler)
 *     - GPU utilization match: 0.15 (e.g. >80% GPU for gaming/rendering)
 *     - Memory pattern match:  0.10 (e.g. high RSS for VM)
 *     - I/O pattern match:     0.05 (e.g. high IO for compression)
 *
 *   If confidence < RECOGNITION_CONFIDENCE_THRESHOLD (default 0.60),
 *   the recognition is "low confidence" and the recognizer returns
 *   null — the caller should NOT switch profiles.
 *
 * Multi-workload detection:
 *
 *   The recognizer can detect multiple simultaneous workloads (e.g.
 *   Gaming + Streaming). The caller receives an array of detections,
 *   sorted by confidence descending. Conflict resolution is handled
 *   by the RecognitionEngine (which maps to profiles and uses the
 *   Profile Manager's priority system).
 *
 * Extensibility:
 *
 *   Plugins can register custom recognition rules via
 *   `registerRule(rule)`. A rule has the shape:
 *
 *     {
 *       id: 'my-rule',
 *       workload: 'custom-workload',
 *       match: (context) => boolean,   // does this rule apply?
 *       confidence: (context) => number, // 0.0-1.0
 *       profile: 'my-profile',         // which profile to activate
 *     }
 *
 * Backward compatibility: only used when ENABLE_WORKLOAD_RECOGNITION
 * is true.
 */

const logger = require('../logger');
const { debug, warn } = logger;

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_CONFIDENCE_THRESHOLD = 0.60;

// Confidence contribution weights
const WEIGHTS = Object.freeze({
  PROCESS_NAME: 0.50,
  CPU_PATTERN: 0.20,
  GPU_PATTERN: 0.15,
  MEMORY_PATTERN: 0.10,
  IO_PATTERN: 0.05,
});

// ── Built-in recognition rules ───────────────────────────────────────
//
// Each rule checks the DetectionContext and returns a confidence (0-1).
// The rule's `workload` field maps to an optimization strategy.
// The rule's `profile` field maps to a Profile Manager profile ID.

const BUILTIN_RULES = [
  // ── Gaming ─────────────────────────────────────────────────────
  {
    id: 'gaming-name',
    workload: 'gaming',
    profile: 'gaming',
    match: (ctx) => ctx.workloadClassification === 'GAME',
    confidence: (ctx) => {
      // Gaming classification from the detector is a strong signal —
      // base 0.65 so it meets threshold even without GPU signal.
      let c = WEIGHTS.PROCESS_NAME + 0.15;  // 0.65
      if (ctx.gpuUtilization !== null && ctx.gpuUtilization > 50) c += WEIGHTS.GPU_PATTERN;
      if (ctx.cpuPressure > 10) c += WEIGHTS.CPU_PATTERN * 0.5;
      return Math.min(c, 1.0);
    },
  },

  // ── Software Development ───────────────────────────────────────
  {
    id: 'development-name',
    workload: 'development',
    profile: 'development',
    match: (ctx) => ctx.workloadClassification === 'IDE' || ctx.workloadClassification === 'COMPILER',
    confidence: (ctx) => {
      // IDE/compiler classification is a strong signal — base 0.65
      let c = WEIGHTS.PROCESS_NAME + 0.15;  // 0.65
      if (ctx.cpuPressure > 15) c += WEIGHTS.CPU_PATTERN; // compiling
      if (ctx.foregroundComm && /^(cc1|rustc|cargo|gcc|g\+\+|clang|node|deno|tsc)$/.test(ctx.foregroundComm)) {
        c = Math.min(c + 0.1, 1.0); // compiler running — high confidence
      }
      return Math.min(c, 1.0);
    },
  },

  // ── Web Browsing ───────────────────────────────────────────────
  {
    id: 'browsing-name',
    workload: 'web-browsing',
    profile: 'balanced', // browsers use balanced profile
    match: (ctx) => ctx.workloadClassification === 'BROWSER',
    confidence: (ctx) => {
      // Browsing is a strong signal from process name alone — bump to 0.65
      let c = WEIGHTS.PROCESS_NAME + 0.15;  // 0.65 base
      if (ctx.gpuUtilization !== null && ctx.gpuUtilization < 20) c += WEIGHTS.GPU_PATTERN * 0.5;
      return Math.min(c, 1.0);
    },
  },

  // ── Office Productivity ────────────────────────────────────────
  {
    id: 'office-name',
    workload: 'office-productivity',
    profile: 'balanced',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(libreoffice|soffice|writer|calc|impress|gimp|inkscape|calligra|onlyoffice)$/.test(ctx.foregroundComm);
    },
    confidence: (ctx) => WEIGHTS.PROCESS_NAME,
  },

  // ── Video Editing ──────────────────────────────────────────────
  {
    id: 'video-editing-name',
    workload: 'video-editing',
    profile: 'rendering',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(kdenlive|openshot|pitivi|davinci|resolve|olive|shotcut|ffmpeg)$/.test(ctx.foregroundComm);
    },
    confidence: (ctx) => {
      let c = WEIGHTS.PROCESS_NAME;
      if (ctx.gpuUtilization !== null && ctx.gpuUtilization > 30) c += WEIGHTS.GPU_PATTERN;
      if (ctx.cpuPressure > 20) c += WEIGHTS.CPU_PATTERN;
      return Math.min(c, 1.0);
    },
  },

  // ── Audio Production ───────────────────────────────────────────
  {
    id: 'audio-production-name',
    workload: 'audio-production',
    profile: 'streaming',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(ardour|audacity|bitwig|reaper|lmms|hydrogen|rosegarden|zrythm|qtractor)$/.test(ctx.foregroundComm);
    },
    confidence: (ctx) => WEIGHTS.PROCESS_NAME,
  },

  // ── 3D Rendering ───────────────────────────────────────────────
  {
    id: 'rendering-3d-name',
    workload: '3d-rendering',
    profile: 'rendering',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(blender|maya|houdini|3ds|max|octane|vray|cycles)$/.test(ctx.foregroundComm) &&
             (ctx.gpuUtilization !== null && ctx.gpuUtilization > 60);
    },
    confidence: (ctx) => {
      let c = WEIGHTS.PROCESS_NAME * 0.8;
      if (ctx.gpuUtilization !== null && ctx.gpuUtilization > 60) c += WEIGHTS.GPU_PATTERN;
      if (ctx.cpuPressure > 30) c += WEIGHTS.CPU_PATTERN;
      return Math.min(c, 1.0);
    },
  },

  // ── Streaming ──────────────────────────────────────────────────
  {
    id: 'streaming-name',
    workload: 'streaming',
    profile: 'streaming',
    match: (ctx) => ctx.workloadClassification === 'MULTIMEDIA',
    confidence: (ctx) => {
      let c = WEIGHTS.PROCESS_NAME;
      if (ctx.mediaPidsCount > 0) c += 0.1; // actively playing media
      return Math.min(c, 1.0);
    },
  },

  // ── Virtual Machines ───────────────────────────────────────────
  {
    id: 'vm-name',
    workload: 'virtual-machines',
    profile: 'balanced',
    match: (ctx) => ctx.workloadClassification === 'VIRTUALIZATION',
    confidence: (ctx) => {
      let c = WEIGHTS.PROCESS_NAME;
      if (ctx.memoryUsage > 50) c += WEIGHTS.MEMORY_PATTERN; // VMs use lots of RAM
      return Math.min(c, 1.0);
    },
  },

  // ── Containers ─────────────────────────────────────────────────
  {
    id: 'containers-name',
    workload: 'containers',
    profile: 'balanced',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(docker|podman|containerd|ctr|nerdctl|buildah|buildkitd)$/.test(ctx.foregroundComm);
    },
    confidence: (ctx) => WEIGHTS.PROCESS_NAME,

  },

  // ── AI / Machine Learning ──────────────────────────────────────
  {
    id: 'ai-ml-name',
    workload: 'ai-ml',
    profile: 'performance',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(python3?|jupyter|jupyter-lab|jupyter-notebook|ipython|tensorflow|torch|ollama|llama|stable-diffusion)$/.test(ctx.foregroundComm) &&
             (ctx.gpuUtilization !== null && ctx.gpuUtilization > 70);
    },
    confidence: (ctx) => {
      // AI/ML with high GPU is a strong signal — base 0.50 + GPU 0.15 = 0.65
      let c = WEIGHTS.PROCESS_NAME;  // 0.50
      if (ctx.gpuUtilization !== null && ctx.gpuUtilization > 70) c += WEIGHTS.GPU_PATTERN;
      return Math.min(c, 1.0);
    },
  },

  // ── File Compression ───────────────────────────────────────────
  {
    id: 'compression-name',
    workload: 'file-compression',
    profile: 'balanced',
    match: (ctx) => {
      if (!ctx.foregroundComm) return false;
      return /^(gzip|bzip2|xz|zstd|7z|zip|unzip|tar|lz4|pigz)$/.test(ctx.foregroundComm);
    },
    confidence: (ctx) => {
      let c = WEIGHTS.PROCESS_NAME;
      if (ctx.cpuPressure > 30) c += WEIGHTS.CPU_PATTERN;
      return Math.min(c, 1.0);
    },
  },

  // ── Idle ───────────────────────────────────────────────────────
  {
    id: 'idle-signal',
    workload: 'idle',
    profile: 'idle',
    match: (ctx) => ctx.idleState === 'IDLE',
    confidence: (_ctx) => 0.90, // idle is high-confidence when detected
  },

  // ── Background Tasks ───────────────────────────────────────────
  {
    id: 'background-tasks',
    workload: 'background-tasks',
    profile: 'balanced',
    match: (ctx) => {
      // No specific foreground, but system is busy (high process count + moderate CPU)
      if (!ctx.foregroundComm || ctx.foregroundComm === '') return false;
      return ctx.workloadClassification === 'UNKNOWN' && ctx.cpuPressure > 5 && ctx.processCount > 100;
    },
    confidence: (ctx) => {
      let c = 0.40; // lower base confidence — we're guessing
      if (ctx.cpuPressure > 10) c += WEIGHTS.CPU_PATTERN * 0.5;
      return Math.min(c, 0.55); // cap below threshold — background tasks shouldn't override
    },
  },
];

// ── WorkloadRecognizer class ─────────────────────────────────────────

class WorkloadRecognizer {
  /**
   * @param {object} opts
   * @param {object} opts.config   - main CONFIG
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('WorkloadRecognizer: opts.config is required');
    }
    this._config = opts.config;
    this._rules = [];
    this._customRules = [];
    this._lastRecognition = null;
    this._recognitionCount = 0;

    // Load built-in rules
    this._loadBuiltinRules();
  }

  /**
   * Register a custom recognition rule (for plugins).
   * @param {object} rule - { id, workload, profile, match(ctx), confidence(ctx) }
   * @returns {boolean} true on success
   */
  registerRule(rule) {
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0) {
      warn('WorkloadRecognizer: rule must have a non-empty id');
      return false;
    }
    if (typeof rule.match !== 'function' || typeof rule.confidence !== 'function') {
      warn(`WorkloadRecognizer: rule "${rule.id}" must have match() and confidence() functions`);
      return false;
    }
    if (this._customRules.some((r) => r.id === rule.id)) {
      warn(`WorkloadRecognizer: rule "${rule.id}" already registered`);
      return false;
    }
    this._customRules.push(rule);
    debug(`WorkloadRecognizer: custom rule registered: ${rule.id}`);
    return true;
  }

  /**
   * Unregister a custom rule by ID.
   */
  unregisterRule(id) {
    const idx = this._customRules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this._customRules.splice(idx, 1);
    return true;
  }

  /**
   * Recognize workloads from the given context.
   *
   * @param {object} context - recognition context (see _buildContext)
   * @returns {Array<Detection>} sorted by confidence descending; empty if none match
   */
  recognize(context) {
    if (!context || typeof context !== 'object') return [];

    const ctx = this._buildContext(context);
    const allRules = [...this._rules, ...this._customRules];
    const detections = [];

    for (const rule of allRules) {
      try {
        if (!rule.match(ctx)) continue;
        const confidence = rule.confidence(ctx);
        if (typeof confidence !== 'number' || confidence <= 0) continue;

        detections.push({
          workload: rule.workload,
          profile: rule.profile,
          confidence: Math.min(Math.max(confidence, 0), 1),
          source: rule.id,
          ruleId: rule.id,
          timestamp: Date.now(),
          reason: this._buildReason(rule, ctx),
          context: {
            foregroundComm: ctx.foregroundComm,
            workloadClassification: ctx.workloadClassification,
            cpuPressure: ctx.cpuPressure,
            gpuUtilization: ctx.gpuUtilization,
            memoryUsage: ctx.memoryUsage,
            processCount: ctx.processCount,
            idleState: ctx.idleState,
          },
        });
      } catch (err) {
        warn(`WorkloadRecognizer: rule "${rule.id}" threw: ${err.message}`);
      }
    }

    // Sort by confidence descending
    detections.sort((a, b) => b.confidence - a.confidence);

    // Filter by confidence threshold
    const threshold = this._getConfidenceThreshold();
    const confident = detections.filter((d) => d.confidence >= threshold);

    this._lastRecognition = {
      timestamp: Date.now(),
      totalDetected: detections.length,
      confidentCount: confident.length,
      detections: confident,
      allDetections: detections,
    };
    this._recognitionCount++;

    return confident;
  }

  /**
   * Get the last recognition result (for status / IPC).
   */
  get lastRecognition() {
    return this._lastRecognition;
  }

  get recognitionCount() {
    return this._recognitionCount;
  }

  get ruleCount() {
    return this._rules.length + this._customRules.length;
  }

  get customRuleCount() {
    return this._customRules.length;
  }

  getStatus() {
    return {
      ruleCount: this.ruleCount,
      customRuleCount: this.customRuleCount,
      recognitionCount: this._recognitionCount,
      confidenceThreshold: this._getConfidenceThreshold(),
      lastRecognition: this._lastRecognition ? {
        timestamp: new Date(this._lastRecognition.timestamp).toISOString(),
        totalDetected: this._lastRecognition.totalDetected,
        confidentCount: this._lastRecognition.confidentCount,
        topWorkload: this._lastRecognition.detections[0]?.workload || null,
        topConfidence: this._lastRecognition.detections[0]?.confidence || 0,
      } : null,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  _loadBuiltinRules() {
    this._rules = BUILTIN_RULES.map((r) => ({ ...r }));
    debug(`WorkloadRecognizer: loaded ${this._rules.length} built-in rules`);
  }

  _buildContext(raw) {
    return {
      foregroundComm: raw.foregroundComm || '',
      foregroundPid: raw.foregroundPid || null,
      workloadClassification: raw.workloadClassification || 'UNKNOWN',
      cpuPressure: typeof raw.cpuPressure === 'number' ? raw.cpuPressure : 0,
      memPressure: typeof raw.memPressure === 'number' ? raw.memPressure : 0,
      gpuUtilization: typeof raw.gpuUtilization === 'number' ? raw.gpuUtilization : null,
      memoryUsage: typeof raw.memoryUsage === 'number' ? raw.memoryUsage : 0,
      processCount: typeof raw.processCount === 'number' ? raw.processCount : 0,
      mediaPidsCount: typeof raw.mediaPidsCount === 'number' ? raw.mediaPidsCount : 0,
      idleState: raw.idleState || 'ACTIVE',
      onBattery: !!raw.onBattery,
      batteryCapacity: typeof raw.batteryCapacity === 'number' ? raw.batteryCapacity : 100,
    };
  }

  _buildReason(rule, ctx) {
    const parts = [rule.id];
    if (ctx.foregroundComm) parts.push(`comm=${ctx.foregroundComm}`);
    if (ctx.workloadClassification !== 'UNKNOWN') parts.push(`class=${ctx.workloadClassification}`);
    if (ctx.gpuUtilization !== null) parts.push(`gpu=${ctx.gpuUtilization}%`);
    if (ctx.cpuPressure > 0) parts.push(`cpu=${ctx.cpuPressure}%`);
    return parts.join(' ');
  }

  _getConfidenceThreshold() {
    const t = this._config.RECOGNITION_CONFIDENCE_THRESHOLD;
    return typeof t === 'number' && t >= 0 && t <= 1 ? t : DEFAULT_CONFIDENCE_THRESHOLD;
  }
}

module.exports = WorkloadRecognizer;
module.exports.WEIGHTS = WEIGHTS;
module.exports.BUILTIN_RULES = BUILTIN_RULES;
module.exports.DEFAULT_CONFIDENCE_THRESHOLD = DEFAULT_CONFIDENCE_THRESHOLD;
