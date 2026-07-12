'use strict';

/**
 * DynAlloc — Scheduler Module
 *
 * Multi-level scheduler with:
 *   - 5 priority classes: REALTIME, INTERACTIVE, MULTIMEDIA, BACKGROUND, IDLE
 *   - Hysteresis (minimum dwell time per state transition)
 *   - CPU History (moving average via sensor.CpuHistory)
 *   - Adaptive scoring (CPU, memory, foreground, media, battery, thermal)
 *   - Auto-restore (restore throttled processes when stress ends)
 *   - CPU topology awareness (P-Core/E-Core pinning for hybrid CPUs)
 *
 * v2.1: Fixed encapsulation (no private field access), feature flag support,
 *        metrics integration, plugin integration.
 */

const classifier = require('./classifier');
const logger = require('./logger');
const { log, debug, info, warn, trace } = logger;

// ── Stress Levels ─────────────────────────────────────────────────────

const STRESS_LEVELS = ['NORMAL', 'WARN', 'CRITICAL'];
const STRESS_ORDER = { NORMAL: 0, WARN: 1, CRITICAL: 2 };

// ── Scheduler Class Constants ─────────────────────────────────────────

const SCHED_CLASSES = ['REALTIME', 'INTERACTIVE', 'MULTIMEDIA', 'BACKGROUND', 'IDLE'];
const SCHED_CLASS_ORDER = { REALTIME: 0, INTERACTIVE: 1, MULTIMEDIA: 2, BACKGROUND: 3, IDLE: 4 };

// ── Hysteresis State ──────────────────────────────────────────────────

class HysteresisState {
  constructor() {
    this._currentLevel = 'NORMAL';
    this._lastTransitionTime = Date.now();
    this._pendingLevel = null;
    this._pendingSince = null;
  }

  get current() { return this._currentLevel; }

  evaluate(desiredLevel, config) {
    // If hysteresis is disabled, allow immediate transitions
    if (!config.ENABLE_HYSTERESIS) {
      if (desiredLevel !== this._currentLevel) {
        const old = this._currentLevel;
        this._currentLevel = desiredLevel;
        this._lastTransitionTime = Date.now();
        this._pendingLevel = null;
        this._pendingSince = null;
        return { level: desiredLevel, changed: true };
      }
      return { level: this._currentLevel, changed: false };
    }

    if (desiredLevel === this._currentLevel) {
      this._pendingLevel = null;
      this._pendingSince = null;
      return { level: this._currentLevel, changed: false };
    }

    const now = Date.now();
    const requiredMs = this._getRequiredDwellTime(this._currentLevel, desiredLevel, config);

    if (this._pendingLevel !== desiredLevel) {
      this._pendingLevel = desiredLevel;
      this._pendingSince = now;
    }

    const pendingElapsed = now - this._pendingSince;

    if (pendingElapsed >= requiredMs) {
      this._currentLevel = desiredLevel;
      this._lastTransitionTime = now;
      this._pendingLevel = null;
      this._pendingSince = null;
      return { level: desiredLevel, changed: true };
    }

    return { level: this._currentLevel, changed: false };
  }

  _getRequiredDwellTime(from, to, config) {
    if (from === 'NORMAL' && to === 'WARN') return config.HYSTERESIS_NORMAL_TO_WARN_MS;
    if (from === 'WARN' && to === 'CRITICAL') return config.HYSTERESIS_WARN_TO_CRITICAL_MS;
    if (from === 'WARN' && to === 'NORMAL') return config.HYSTERESIS_NORMAL_TO_WARN_MS;
    if (from === 'CRITICAL' && to === 'NORMAL') return config.HYSTERESIS_CRITICAL_TO_NORMAL_MS;
    if (from === 'CRITICAL' && to === 'WARN') return config.HYSTERESIS_WARN_TO_CRITICAL_MS;
    if (from === 'NORMAL' && to === 'CRITICAL') {
      return config.HYSTERESIS_NORMAL_TO_WARN_MS + config.HYSTERESIS_WARN_TO_CRITICAL_MS;
    }
    return 0;
  }

  reset() {
    this._currentLevel = 'NORMAL';
    this._lastTransitionTime = Date.now();
    this._pendingLevel = null;
    this._pendingSince = null;
  }
}

// ── Auto-Restore Tracker ──────────────────────────────────────────────

class AutoRestoreTracker {
  constructor() {
    this._throttledPids = new Map();
  }

  markThrottled(pid, info) {
    this._throttledPids.set(pid, { ...info, timestamp: Date.now() });
  }

  getThrottledPids() {
    return new Set(this._throttledPids.keys());
  }

  getThrottledPidsWithInfo() {
    return new Map(this._throttledPids);
  }

  isThrottled(pid) {
    return this._throttledPids.has(pid);
  }

  remove(pid) {
    this._throttledPids.delete(pid);
  }

  pruneDead(alivePids) {
    for (const pid of this._throttledPids.keys()) {
      if (!alivePids.has(pid)) {
        this._throttledPids.delete(pid);
      }
    }
  }

  getInfo(pid) {
    return this._throttledPids.get(pid) || null;
  }

  clear() {
    this._throttledPids.clear();
  }

  get size() {
    return this._throttledPids.size;
  }
}

// ── Adaptive Score Calculator ─────────────────────────────────────────

function calculateAdaptiveScore(factors, config) {
  if (!config.ENABLE_ADAPTIVE_SCHEDULER || !config.ENABLE_SMART_SCHEDULER) {
    return 0;
  }

  let score = 0;
  let maxPossible = 0;

  const cpuNorm = Math.min(factors.cpuPressure / config.PSI_CPU_CRITICAL, 1.0);
  score += cpuNorm * config.ADAPTIVE_WEIGHT_CPU;
  maxPossible += config.ADAPTIVE_WEIGHT_CPU;

  const memNorm = Math.min(factors.memPressure / config.PSI_MEM_CRITICAL, 1.0);
  score += memNorm * config.ADAPTIVE_WEIGHT_MEM;
  maxPossible += config.ADAPTIVE_WEIGHT_MEM;

  const fgActive = factors.hasForeground ? 1 : 0;
  score += fgActive * config.ADAPTIVE_WEIGHT_FOREGROUND;
  maxPossible += config.ADAPTIVE_WEIGHT_FOREGROUND;

  // Media penalty reduces score (media playing = less urgency to throttle)
  if (factors.mediaPlaying) {
    score -= config.ADAPTIVE_WEIGHT_MEDIA;
  }
  maxPossible += config.ADAPTIVE_WEIGHT_MEDIA;

  if (factors.onBattery) {
    score -= 0.5 * config.ADAPTIVE_WEIGHT_BATTERY;
  }
  maxPossible += config.ADAPTIVE_WEIGHT_BATTERY;

  const thermalNorm = factors.thermalTemp !== null
    ? Math.min(Math.max(factors.thermalTemp - 50, 0) / 30, 1.0)
    : 0;
  score += thermalNorm * config.ADAPTIVE_WEIGHT_THERMAL;
  maxPossible += config.ADAPTIVE_WEIGHT_THERMAL;

  return maxPossible > 0 ? Math.max(0, Math.min(1, score / maxPossible)) : 0;
}

// ── Main Scheduler Class ──────────────────────────────────────────────

class Scheduler {
  constructor(config, cpuTopology, cpuHistory) {
    this._config = config;
    this._topology = cpuTopology;
    this._cpuHistory = cpuHistory;
    this._hysteresis = new HysteresisState();
    this._autoRestore = new AutoRestoreTracker();
    this._stressLevel = 'NORMAL';
    this._adaptiveScore = 0;
    this._lastForegroundPid = null;
    this._decisionCount = 0;

    this._setupCoreLayout();
  }

  get stressLevel() { return this._stressLevel; }
  get adaptiveScore() { return this._adaptiveScore; }
  get autoRestore() { return this._autoRestore; }
  get hysteresis() { return this._hysteresis; }
  get decisionCount() { return this._decisionCount; }

  setConfig(config) {
    this._config = config;
  }

  _setupCoreLayout() {
    const total = this._topology.logicalCount;
    const reserve = this._config.FOREGROUND_CORE_RESERVE
      ?? Math.max(1, Math.floor(total * 0.5));

    if (this._topology.isHybrid && this._config.ENABLE_CPU_TOPOLOGY && this._config.ENABLE_TOPOLOGY) {
      this._foregroundCores = this._topology.pCores;
      this._backgroundCores = this._topology.eCores.length > 0
        ? this._topology.eCores
        : Array.from({ length: total }, (_, i) => i).filter((c) => !this._foregroundCores.includes(c));
      info(`Hybrid CPU terdeteksi: P-Cores [${this._foregroundCores.join(',')}] E-Cores [${this._backgroundCores.join(',')}]`);
    } else {
      this._foregroundCores = Array.from(
        { length: reserve }, (_, i) => total - 1 - i
      ).sort((a, b) => a - b);
      this._backgroundCores = Array.from({ length: total }, (_, i) => i)
        .filter((c) => !this._foregroundCores.includes(c));
    }

    this._allCores = Array.from({ length: total }, (_, i) => i);
  }

  get foregroundCores() { return this._foregroundCores; }
  get backgroundCores() { return this._backgroundCores; }
  get allCores() { return this._allCores; }

  tick(psiData, context) {
    const cpuAvg10 = psiData.cpuPSI?.some?.avg10 ?? 0;
    const memAvg10 = psiData.memPSI?.some?.avg10 ?? 0;

    // CPU history
    if (this._config.ENABLE_CPU_HISTORY) {
      this._cpuHistory.push({ cpuAvg10, memAvg10 });
    }

    // BUG FIX (v2.1.2): When ENABLE_CPU_HISTORY is false, the cpuHistory
    // buffer stays empty (or holds stale samples from when the flag was
    // last true). Using cpuAvg in that case returns 0 (or stale data),
    // which silently disables ALL throttling — the scheduler always sees
    // zero pressure and never transitions to WARN/CRITICAL.
    //
    // Now we use the instantaneous PSI reading when history is disabled,
    // and the moving average when it's enabled. This matches the intent
    // of the CPU_HISTORY feature (a smoothing filter, not a gate).
    const cpuPressure = this._config.ENABLE_CPU_HISTORY
      ? this._cpuHistory.cpuAvg
      : cpuAvg10;
    const memPressure = this._config.ENABLE_CPU_HISTORY
      ? this._cpuHistory.memAvg
      : memAvg10;

    // Raw stress level
    let rawStress = 'NORMAL';
    if (cpuPressure >= this._config.PSI_CPU_CRITICAL || memPressure >= this._config.PSI_MEM_CRITICAL) {
      rawStress = 'CRITICAL';
    } else if (cpuPressure >= this._config.PSI_CPU_WARN || memPressure >= this._config.PSI_MEM_WARN) {
      rawStress = 'WARN';
    }

    // Adaptive scoring
    this._adaptiveScore = calculateAdaptiveScore({
      cpuPressure,
      memPressure,
      hasForeground: !!context.foregroundPid,
      mediaPlaying: (context.mediaPids?.size || 0) > 0,
      onBattery: context.onBattery || false,
      thermalTemp: context.thermalTemp,
    }, this._config);

    if (rawStress === 'NORMAL' && this._adaptiveScore > 0.6) {
      rawStress = 'WARN';
    }

    // Hysteresis
    const { level: newStress, changed } = this._hysteresis.evaluate(rawStress, this._config);
    if (changed) {
      info(`Stress level: ${this._stressLevel} -> ${newStress} (adaptive=${this._adaptiveScore.toFixed(2)})`);
      this._stressLevel = newStress;
    }

    // Auto-restore
    const actions = [];
    if (this._stressLevel === 'NORMAL' && this._config.AUTO_RESTORE) {
      actions.push(...this._generateAutoRestoreActions());
    }

    this._decisionCount++;

    return { stressLevel: this._stressLevel, changed, actions, cpuPressure, memPressure };
  }

  classifyProcesses(procs, foregroundPid, mediaPids) {
    if (this._stressLevel === 'NORMAL') return [];

    const fgTree = this._buildDescendantSet(procs, foregroundPid);
    const pidToComm = new Map(procs.map((p) => [p.pid, p.comm]));
    const actions = [];

    for (const proc of procs) {
      if (proc.pid === process.pid) continue;
      if (typeof proc.pid !== 'number' || proc.pid <= 0) continue;

      const category = classifier.classifyByComm(proc.comm);

      let effectiveCategory = category;
      if (classifier.isFlatpakProcess(proc.pid)) {
        effectiveCategory = 'FLATPAK';
      } else if (classifier.isSnapProcess(proc.pid)) {
        effectiveCategory = 'SNAP';
      }

      if (effectiveCategory === 'UNKNOWN' && proc.ppid) {
        const parentComm = pidToComm.get(proc.ppid);
        if (parentComm) {
          effectiveCategory = classifier.classifyElectronChild(proc.comm, parentComm);
        }
      }

      const schedClass = classifier.categoryToSchedulerClass(effectiveCategory);

      if (schedClass === 'REALTIME' || schedClass === 'MULTIMEDIA') continue;
      if (fgTree.has(proc.pid)) continue;
      if (mediaPids && mediaPids.has(proc.pid)) continue;

      const isHeavy = this._isHeavyBackground(proc, effectiveCategory);
      if (!isHeavy) continue;

      // Already throttled — skip (the autoRestore tracker handles re-throttle).
      if (this._autoRestore.isThrottled(proc.pid)) {
        continue;
      }

      const nice = classifier.schedulerClassNice('BACKGROUND', this._config);
      const [ioClass, ioLevel] = classifier.schedulerClassIoPrio('BACKGROUND', this._config);

      actions.push({
        type: 'THROTTLE',
        pid: proc.pid,
        comm: proc.comm,
        schedClass: 'BACKGROUND',
        nice,
        ioClass,
        ioLevel,
        cores: this._backgroundCores,
      });
    }

    const alivePids = new Set(procs.map((p) => p.pid));
    this._autoRestore.pruneDead(alivePids);

    return actions;
  }

  generateForegroundBoost(pid, procs, gameModeActive) {
    if (!pid) return null;

    const pidToComm = new Map(procs.map((p) => [p.pid, p.comm]));
    const comm = pidToComm.get(pid) || '';
    const category = classifier.classifyByComm(comm);
    const schedClass = classifier.categoryToSchedulerClass(category);

    const nice = gameModeActive ? 0 : classifier.schedulerClassNice(schedClass, this._config);
    const [ioClass, ioLevel] = classifier.schedulerClassIoPrio(schedClass, this._config);

    return {
      type: 'BOOST',
      pid,
      comm,
      schedClass,
      nice,
      ioClass,
      ioLevel,
      cores: this._foregroundCores,
      gameModeActive,
    };
  }

  _isHeavyBackground(proc, category) {
    const schedClass = classifier.categoryToSchedulerClass(category);
    if (schedClass === 'BACKGROUND') return true;

    if (typeof proc.pcpu === 'number' && proc.pcpu >= this._config.HEAVY_BG_CPU_THRESHOLD) return true;

    if (category === 'COMPILER' || category === 'CONTAINER' || category === 'VM') return true;

    return false;
  }

  _buildDescendantSet(procs, rootPid) {
    if (!rootPid) return new Set();
    const byPpid = new Map();
    for (const p of procs) {
      if (typeof p.pid !== 'number' || typeof p.ppid !== 'number') continue;
      if (!byPpid.has(p.ppid)) byPpid.set(p.ppid, []);
      byPpid.get(p.ppid).push(p.pid);
    }
    const result = new Set([rootPid]);
    const queue = [rootPid];
    while (queue.length) {
      const cur = queue.pop();
      for (const child of byPpid.get(cur) || []) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
    return result;
  }

  _generateAutoRestoreActions() {
    const actions = [];
    if (this._autoRestore.size === 0) return actions;

    info(`Auto-restore: mengembalikan ${this._autoRestore.size} proses ke normal`);
    // Use public API (getThrottledPidsWithInfo) instead of private field
    for (const [pid, entry] of this._autoRestore.getThrottledPidsWithInfo()) {
      actions.push({
        type: 'RESTORE',
        pid,
        comm: entry.comm || '',
      });
    }
    this._autoRestore.clear();
    return actions;
  }
}

module.exports = {
  Scheduler,
  HysteresisState,
  AutoRestoreTracker,
  calculateAdaptiveScore,
  STRESS_LEVELS,
  SCHED_CLASSES,
  SCHED_CLASS_ORDER,
  STRESS_ORDER,
};