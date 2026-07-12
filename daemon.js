'use strict';

/**
 * DynAlloc — Daemon Module
 *
 * Main daemon loop: fastTick (PSI), slowTick (process scan + scheduling),
 * event-driven focus, hot-reload, and cleanup on shutdown.
 *
 * v2.1: Plugin architecture, metrics, self-check, rollback, feature flags,
 *        proper error handling, fs.watch cleanup, no resource leaks.
 */

const fs = require('fs');
const path = require('path');
const { TOTAL_CORES, loadConfig, HOT_RELOADABLE_FIELDS, DEFAULT_CONFIG } = require('./config');
const logger = require('./logger');
const { setLevel: setLogLevel, info, warn, error, debug, trace, fatal, setupFileLogging, closeFileLogging, setSchedulerStateProvider } = logger;
const { CpuHistory, readCpuPSI, readMemPSI, getForegroundPID, getProcessInfo, listProcesses, isGameModeActive, watchFocusChanges, readBatteryStatus, readThermalTemp, checkPowerProfilesDaemon, getSystemdUnit, getGpuUtilization, getNetworkRxBytes } = require('./sensor');
const { detect: detectTopology } = require('./cpu-topology');
const classifier = require('./classifier');
const { isKnownMediaProcessName, getActiveMediaPids, invalidateCache: invalidateMediaCache, resetState: resetMultimediaState } = require('./multimedia');
const GovernorManager = require('./governor');
const Actuator = require('./actuator');
const { Scheduler } = require('./scheduler');
const { getMetrics, resetMetrics } = require('./metrics');
const { getPluginManager, resetPluginManager } = require('./plugin-manager');
const { runSelfCheck, printReport } = require('./self-check');
const RollbackManager = require('./rollback');
const { IpcServer } = require('./ipc-server');
const { PerAppProfiles } = require('./per-app-profiles');
const { LearningLogger } = require('./learning-logger');

// ── Policy Engine (v2.2, optional) ───────────────────────────────────
// Loaded lazily inside bootstrap() only when ENABLE_POLICY_ENGINE is
// true. This keeps the module completely inert for users who do not
// opt in, preserving backward compatibility.
let PolicyEngine = null;
let EventSources = null;
let PolicyEvents = null;

// ── Detector Layer (v0.5.0 Phase 1, optional) ───────────────────────
// Loaded lazily inside bootstrap() only when ENABLE_DETECTOR_LAYER is
// true. Purely observational — never modifies system state. Emits
// events on the bus (PE bus when PE is enabled, isolated bus otherwise).
let DetectorModule = null;

// ── Resource Controller Layer (v0.5.0 Phase 2, optional) ────────────
// Loaded lazily inside bootstrap() only when ENABLE_RESOURCE_CONTROLLER_LAYER
// is true. Aggregates all resource controllers (CPU, Memory, IO, Network,
// Governor, Thermal, Power) into a unified entry point for the Policy Engine.
let ResourceControllerManager = null;

// ── Profile Manager (v0.5.0 Phase 3, optional) ──────────────────────
// Loaded lazily inside bootstrap() only when ENABLE_PROFILE_MANAGER is
// true. Subscribes to detector events and activates profiles via the RCM.
let ProfileManagerModule = null;

// ── Adaptive Switching Engine (v0.5.0 Phase 4, optional) ────────────
// Loaded lazily inside bootstrap() only when ENABLE_ADAPTIVE_SWITCHING
// is true. Wraps the Profile Manager with debounce/cooldown/rollback.
let AdaptiveModule = null;

// ── Workload Recognition Engine (v0.5.0 Phase 5, optional) ──────────
// Loaded lazily inside bootstrap() only when ENABLE_WORKLOAD_RECOGNITION
// is true. Identifies workload categories and demands profiles.
let RecognitionModule = null;

// ── Monitoring Framework (v0.5.0 Phase 6, optional) ─────────────────
// Loaded lazily inside bootstrap() only when ENABLE_MONITORING_FRAMEWORK
// is true. Provides system monitoring, diagnostics, health checks,
// benchmarks, and a metrics collector.
let MonitoringModule = null;

// ── Plugin SDK (v0.5.0 Phase 7, optional) ───────────────────────────
// Loaded lazily inside bootstrap() only when ENABLE_PLUGIN_SDK is true.
// Provides a stable, versioned Public API for third-party plugins.
let SdkModule = null;

// ── State ─────────────────────────────────────────────────────────────

const SELF_PID = process.pid;
let shuttingDown = false;

let actuator = null;
let governorMgr = null;
let scheduler = null;
let cpuHistory = null;
let rollbackMgr = null;
let pluginMgr = null;
let metrics = null;
let policyEngine = null;
let policySources = null;
let detectorMgr = null;
let resourceControllerMgr = null;
let profileMgr = null;
let adaptiveEngine = null;
let recognitionEngine = null;
let systemMonitor = null;
let diagnosticsEngine = null;
let healthChecker = null;
let benchmarkFramework = null;
let metricsCollector = null;
let pluginSdkManager = null;
let ipcServer = null;
let daemonStartTime = null;
let perAppProfiles = null;
let learningLogger = null;
let watchdogTimer = null;
let lastFastTickTime = 0;
let lastNetRxBytes = null;
let lastNetRxTime = 0;

let CONFIG = null;
let CONFIG_FILE_PATH = null;
let HEAVY_BG_REGEXES = [];
let CRITICAL_PROCESS_REGEXES = [];

let fastTimer = null;
let slowTimer = null;
let metricsTimer = null;
let fileWatcher = null;

const State = {
  currentForegroundPid: null,
  eventDrivenFocusActive: false,
  focusWatcherProcess: null,
  currentFastInterval: 1000,
  consecutiveNormalTicks: 0,
  currentMediaPids: new Set(),
  lastCpuPressure: 0,
  lastMemPressure: 0,
  selfCheckReport: null,
  // v2.1.8: Thermal protection state
  thermalPausedUntil: 0,        // timestamp (ms) — governor boost paused until this time
  thermalLastTemp: null,        // last thermal reading (°C) for diagnostics
  thermalPauseCount: 0,         // total times thermal pause has been triggered
};

// ── Config Loading ────────────────────────────────────────────────────

function initConfig() {
  const { config, configPath } = loadConfig();
  CONFIG = config;
  CONFIG_FILE_PATH = configPath;
  _rebuildRegexes();
  setLogLevel(CONFIG.LOG_LEVEL);

  // Setup file logging if configured
  if (CONFIG.LOG_FILE_PATH) {
    setupFileLogging({
      filePath: CONFIG.LOG_FILE_PATH,
      maxSizeBytes: (CONFIG.LOG_FILE_MAX_SIZE_MB || 10) * 1024 * 1024,
      maxFiles: CONFIG.LOG_FILE_MAX_FILES || 3,
    });
  }

  return { config, configPath };
}

function _rebuildRegexes() {
  HEAVY_BG_REGEXES = CONFIG.HEAVY_BG_PATTERNS.map((src) => new RegExp(src, 'i'));
  CRITICAL_PROCESS_REGEXES = CONFIG.CRITICAL_PROCESS_PATTERNS.map((src) => new RegExp(src, 'i'));
}

// ── Hot Reload ────────────────────────────────────────────────────────

function setupHotReload() {
  if (!CONFIG.HOT_RELOAD || !CONFIG_FILE_PATH) return;

  let debounceTimer = null;

  try {
    fileWatcher = fs.watch(CONFIG_FILE_PATH, { persistent: false }, (eventType) => {
      if (shuttingDown) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        info(`Config file berubah, reload: ${CONFIG_FILE_PATH}`);

        const { readJsonFile } = require('./config');
        const fileConfig = readJsonFile(CONFIG_FILE_PATH);
        if (!fileConfig) {
          warn('Reload dibatalkan karena file config tidak valid.');
          return;
        }

        const { validateAndMerge } = require('./config');
        const { config: merged, warnings: validationWarnings } = validateAndMerge(DEFAULT_CONFIG, fileConfig, true);
        let intervalsChanged = false;

        for (const w of validationWarnings) {
          warn(`Config reload: ${w}`);
        }

        for (const field of HOT_RELOADABLE_FIELDS) {
          if (CONFIG[field] !== merged[field] && JSON.stringify(CONFIG[field]) !== JSON.stringify(merged[field])) {
            if (['FAST_TICK_MS', 'SLOW_TICK_MS', 'FAST_TICK_IDLE_MS'].includes(field)) {
              intervalsChanged = true;
            }
            CONFIG[field] = merged[field];
          }
        }

        _rebuildRegexes();
        setLogLevel(CONFIG.LOG_LEVEL);

        if (scheduler) scheduler.setConfig(CONFIG);
        if (actuator) {
          actuator.setConfig(CONFIG);
          if (actuator.cgroupsReady) actuator.applyCgroupLimits();
        }

        if (cpuHistory && CONFIG.ENABLE_CPU_HISTORY) cpuHistory.resize(CONFIG.CPU_HISTORY_SIZE);

        // Propagate config to policy engine (so actions see new thresholds)
        if (policyEngine && policyEngine.executor) {
          policyEngine.executor.setConfig(CONFIG);
        }

        // v0.5.0 Phase 1: propagate config to detector layer
        if (detectorMgr) {
          detectorMgr.setConfig(CONFIG);
        }

        // v0.5.0 Phase 2: propagate config to resource controller layer
        if (resourceControllerMgr) {
          resourceControllerMgr.setConfig(CONFIG);
        }

        // v0.5.0 Phase 3: propagate config to profile manager
        if (profileMgr) {
          profileMgr.setConfig(CONFIG);
        }

        // v0.5.0 Phase 4: propagate config to adaptive engine
        if (adaptiveEngine) {
          adaptiveEngine.setConfig(CONFIG);
        }

        // v0.5.0 Phase 5: propagate config to recognition engine
        if (recognitionEngine) {
          recognitionEngine.setConfig(CONFIG);
        }

        info('Config berhasil di-reload.');
        if (intervalsChanged) restartTimers();
      }, 300);
    });

    fileWatcher.on('error', (err) => {
      warn(`Config file watch error: ${err.message}`);
    });

    info(`Hot-reload aktif, memantau: ${CONFIG_FILE_PATH}`);
  } catch (err) {
    warn(`Tidak bisa memantau config file: ${err.message}`);
  }
}

function closeFileWatcher() {
  if (fileWatcher) {
    try { fileWatcher.close(); } catch (_) { /* noop */ }
    fileWatcher = null;
  }
}

// ── Event-Driven Focus ────────────────────────────────────────────────

function setupEventDrivenFocus() {
  if (!CONFIG.ENABLE_EVENT_DRIVEN_FOCUS || !CONFIG.ENABLE_EVENT_ENGINE) {
    info('Event-driven focus detection tidak aktif, memakai polling.');
    return;
  }

  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const isGnomeWayland = desktop.includes('gnome') && process.env.XDG_SESSION_TYPE === 'wayland';

  if (!isGnomeWayland) {
    info('Event-driven focus hanya tersedia untuk GNOME/Wayland, memakai polling.');
    return;
  }

  const child = watchFocusChanges((pid) => {
    handleForegroundChange(pid).catch((err) => {
      debug('handleForegroundChange error:', err?.message);
    });
  });
  if (!child) {
    warn('Gagal subscribe sinyal D-Bus fokus, fallback ke polling.');
    return;
  }

  child.on('exit', () => {
    if (!shuttingDown) {
      warn('Proses gdbus monitor berhenti tak terduga, fallback ke polling fokus.');
      State.eventDrivenFocusActive = false;
    }
  });

  State.eventDrivenFocusActive = true;
  State.focusWatcherProcess = child;
  info('Event-driven focus detection aktif (D-Bus signal, GNOME/Wayland).');
}

// ── Foreground Handling ───────────────────────────────────────────────

async function handleForegroundChange(fgPid) {
  if (!fgPid || fgPid === State.currentForegroundPid) return;

  const prevPid = State.currentForegroundPid;
  const prevInfo = prevPid ? getProcessInfo(prevPid) : null;
  const newInfo = getProcessInfo(fgPid);
  const prevLabel = prevInfo ? `${prevInfo.name}\nPID ${prevInfo.pid}` : prevPid ? `PID ${prevPid}` : '(tidak ada)';
  const newLabel = newInfo ? `${newInfo.name}\nPID ${newInfo.pid}` : `PID ${fgPid}`;

  State.currentForegroundPid = fgPid;

  info(`Foreground:\n${prevLabel}\n\n↓\n\n${newLabel}`);

  if (metrics) {
    metrics.counter('foreground_changes').increment();
    metrics.gauge('foreground_pid').set(fgPid);
  }

  // ── Policy Engine: emit foreground-changed event ────────────────
  if (policySources) {
    try {
      policySources.updateForeground(fgPid, newInfo);
    } catch (err) {
      debug(`policySources.updateForeground error: ${err?.message}`);
    }
  }

  if (actuator && scheduler && prevPid && pidAlive(prevPid)) {
    actuator.restoreProcess(prevPid, scheduler.allCores);
    if (metrics) metrics.counter('restore_count').increment();
  }

  if (!(actuator && scheduler)) return;

  try {
    process.kill(fgPid, 0);
  } catch (_) {
    return;
  }

  let procs = [];
  try {
    procs = await listProcesses();
  } catch (_) { /* proceed without proc list */ }

  let gameModeActive = false;
  if (CONFIG.ENABLE_GAMEMODE_COEXIST) {
    try {
      const status = await isGameModeActive(fgPid);
      gameModeActive = status === 1;
      if (gameModeActive) {
        info(`GameMode Feral aktif untuk PID ${fgPid} — DynAlloc tidak mengubah niceness/governor.`);
      }
    } catch (_) { /* GameMode not available */ }
  }

  const boost = scheduler.generateForegroundBoost(fgPid, procs, gameModeActive);
  if (!boost) return;

  _executeBoost(boost);

  const actionLines = [
    `Class: ${boost.schedClass || 'Unknown'}`,
    'Decision: Boost',
    `CPU Pressure: ${Math.round(State.lastCpuPressure)}%`,
    `Memory Pressure: ${Math.round(State.lastMemPressure)}%`,
    `Affinity -> [${boost.cores.join(', ')}]`,
    `Nice -> ${boost.nice}`,
    `Governor -> ${CONFIG.ENABLE_GOVERNOR_SWITCH && !boost.gameModeActive ? CONFIG.GOVERNOR_BOOST : 'unchanged'}`,
    `IO -> class ${boost.ioClass}, level ${boost.ioLevel}`,
  ];

  if (CONFIG.ENABLE_OOM_PROTECTION) {
    actionLines.push(`OOM -> ${CONFIG.FOREGROUND_OOM_SCORE_ADJ}`);
  }

  info(actionLines.join('\n'));

  if (metrics) {
    metrics.gauge('foreground_application').set(boost.comm || '');
  }
}

/**
 * v2.1.8: Check if the daemon is currently in a thermal pause.
 * During thermal pause, governor switching is skipped to prevent
 * thermal throttle death spirals.
 *
 * @returns {boolean} true if governor boost should be skipped
 */
function isThermalPaused() {
  if (!CONFIG.ENABLE_THERMAL_PROTECTION) return false;
  return Date.now() < State.thermalPausedUntil;
}

/**
 * v2.1.8: Update thermal pause state based on current temperature.
 *
 * Called from fastTick() on every tick. When temp exceeds
 * THERMAL_PAUSE_THRESHOLD, we enter a pause for THERMAL_PAUSE_DURATION_MS.
 * The pause does NOT end early even if temp drops — we wait the full
 * duration (hysteresis). After the pause expires, we check the resume
 * threshold: if temp is still above THERMAL_RESUME_THRESHOLD, we
 * re-trigger the pause.
 *
 * @param {number|null} temp - current CPU temperature in °C
 */
function updateThermalPause(temp) {
  if (!CONFIG.ENABLE_THERMAL_PROTECTION) return;
  State.thermalLastTemp = temp;

  if (temp === null || typeof temp !== 'number') return;

  const now = Date.now();
  const isPaused = now < State.thermalPausedUntil;

  if (isPaused) {
    // Already in pause — check if we should re-trigger after expiry.
    // We don't end the pause early even if temp drops — hysteresis.
    // The pause will naturally expire; if temp is still high at that
    // point, the next tick will re-trigger.
    return;
  }

  // Not currently paused. Check if we should enter pause.
  if (temp >= CONFIG.THERMAL_PAUSE_THRESHOLD) {
    State.thermalPausedUntil = now + CONFIG.THERMAL_PAUSE_DURATION_MS;
    State.thermalPauseCount++;
    warn(`Thermal protection: CPU ${temp.toFixed(1)}°C ≥ ${CONFIG.THERMAL_PAUSE_THRESHOLD}°C — ` +
         `pausing governor boost for ${CONFIG.THERMAL_PAUSE_DURATION_MS / 1000}s ` +
         `(count: ${State.thermalPauseCount}).`);
    if (metrics) {
      metrics.counter('thermal_pause_count').increment();
      metrics.gauge('thermal_pause_active').set(1);
    }
  }
}

/**
 * v2.1.8: Check if thermal pause has just expired and log resume.
 * Called from fastTick() to detect transition from paused → active.
 */
function checkThermalPauseExpiry() {
  if (!CONFIG.ENABLE_THERMAL_PROTECTION) return;
  if (State.thermalPausedUntil === 0) return;

  const now = Date.now();
  const wasPaused = (now - 1000) < State.thermalPausedUntil; // roughly paused last tick
  const isPausedNow = now < State.thermalPausedUntil;

  if (wasPaused && !isPausedNow) {
    // Pause just expired — log and check if we can resume
    const temp = State.thermalLastTemp;
    if (temp !== null && temp >= CONFIG.THERMAL_RESUME_THRESHOLD) {
      // Still too hot — re-trigger pause on next updateThermalPause call
      info(`Thermal protection: pause expired but CPU still ${temp.toFixed(1)}°C ≥ resume threshold ${CONFIG.THERMAL_RESUME_THRESHOLD}°C — extending pause.`);
    } else {
      info(`Thermal protection: pause expired, resuming governor boost (temp: ${temp !== null ? temp.toFixed(1) + '°C' : 'unknown'}).`);
      if (metrics) metrics.gauge('thermal_pause_active').set(0);
    }
  }
}

function _executeBoost(boost) {
  if (actuator.cgroupsReady) {
    actuator.assignToCgroup(boost.pid, actuator.foregroundCgroupPath);
    if (rollbackMgr) rollbackMgr.trackProcess(boost.pid, 'cgroup', actuator.foregroundCgroupPath);
  } else {
    actuator.pinToCores(boost.pid, boost.cores);
    if (rollbackMgr) rollbackMgr.trackProcess(boost.pid, 'affinity', boost.cores.join(','));
  }

  if (!boost.gameModeActive) {
    actuator.setNiceness(boost.pid, boost.nice);
    if (rollbackMgr) rollbackMgr.trackProcess(boost.pid, 'nice', boost.nice);

    // v2.1.8: Skip governor switch during thermal pause to prevent
    // thermal throttle death spirals. The foreground process still
    // gets cgroups/nice/io priority — only the governor is skipped.
    // This is a deliberate trade-off: slightly lower single-core boost
    // in exchange for not making the CPU hotter when it's already
    // thermal-throttling.
    if (CONFIG.ENABLE_GOVERNOR_SWITCH && governorMgr && !isThermalPaused()) {
      governorMgr.setGovernor(scheduler.foregroundCores, CONFIG.GOVERNOR_BOOST, CONFIG);
      // Sync any newly-captured governor originals into the rollback
      // manager so crash recovery can restore them.
      _syncGovernorRollbackState();
    } else if (CONFIG.ENABLE_GOVERNOR_SWITCH && governorMgr && isThermalPaused()) {
      debug(`Thermal pause active — skipping governor boost for PID ${boost.pid}`);
      if (metrics) metrics.counter('thermal_pause_boost_skipped').increment();
    }
  }

  actuator.setIoPriority(boost.pid, boost.ioClass, boost.ioLevel);
  if (rollbackMgr) rollbackMgr.trackProcess(boost.pid, 'ionice', [boost.ioClass, boost.ioLevel]);
  if (CONFIG.ENABLE_OOM_PROTECTION) {
    actuator.setOomScoreAdj(boost.pid, CONFIG.FOREGROUND_OOM_SCORE_ADJ);
    if (rollbackMgr) rollbackMgr.trackProcess(boost.pid, 'oom_score_adj', CONFIG.FOREGROUND_OOM_SCORE_ADJ);
  }

  actuator.notify('DynAlloc', `Boost aktif untuk PID ${boost.pid}${boost.gameModeActive ? ' (coexist GameMode)' : ''}`);

  if (metrics) {
    metrics.counter('boost_count').increment();
  }
}

/**
 * Sync any cores captured by GovernorManager into the RollbackManager's
 * state file so crash recovery can restore them. Idempotent: only adds
 * entries for cores the rollback manager doesn't already know about.
 *
 * BUG FIX (v2.1.1): Previously the rollback manager's governorOriginals
 * map was never populated, so recoverFromCrash() had nothing to restore
 * even though GovernorManager had captured the originals in-memory.
 */
function _syncGovernorRollbackState() {
  if (!rollbackMgr || !governorMgr) return;
  try {
    const originals = governorMgr.getOriginalGovernors();
    for (const [core, gov] of originals) {
      rollbackMgr.trackGovernor(core, gov);
    }
  } catch (_) { /* best-effort — never crash the tick */ }
}

// ── Fast Tick (PSI reading) ───────────────────────────────────────────

function fastTick() {
  if (shuttingDown) return;
  lastFastTickTime = Date.now();

  const tickStart = Date.now();

  const cpuPSI = readCpuPSI();
  const memPSI = readMemPSI();

  let onBattery = false;
  let thermalTemp = null;

  // v2.1.10: GPU utilization (for GPU-aware boosting)
  let gpuUtil = null;
  if (CONFIG.ENABLE_GPU_AWARENESS) {
    try {
      const gpu = getGpuUtilization();
      if (gpu && gpu.utilization !== null) gpuUtil = gpu.utilization;
    } catch (_) { /* GPU monitoring unavailable */ }
  }

  // v2.1.10: Network RX rate (for network awareness)
  let networkRxKbps = 0;
  if (CONFIG.ENABLE_NETWORK_AWARENESS) {
    try {
      const netDev = getNetworkRxBytes();
      if (netDev) {
        const now = Date.now();
        if (lastNetRxBytes !== null && lastNetRxTime > 0) {
          const elapsedSec = (now - lastNetRxTime) / 1000;
          if (elapsedSec > 0) {
            const rxBytesDiff = netDev.rxBytes - lastNetRxBytes;
            networkRxKbps = Math.max(0, Math.round((rxBytesDiff / 1024) / elapsedSec));
          }
        }
        lastNetRxBytes = netDev.rxBytes;
        lastNetRxTime = now;
      }
    } catch (_) { /* /proc/net/dev unavailable */ }
  }

  let batteryStatus = null;
  try {
    const bat = readBatteryStatus(CONFIG.BATTERY_CHECK_PATH);
    if (bat) { onBattery = bat.onBattery; batteryStatus = bat; }
  } catch (_) { /* battery sysfs not available */ }
  try {
    thermalTemp = readThermalTemp(CONFIG.THERMAL_ZONE_INDEX);
  } catch (_) { /* thermal sysfs not available */ }

  const result = scheduler.tick(
    { cpuPSI, memPSI },
    {
      foregroundPid: State.currentForegroundPid,
      mediaPids: State.currentMediaPids,
      onBattery,
      thermalTemp,
    }
  );

  State.lastCpuPressure = result.cpuPressure || 0;
  State.lastMemPressure = result.memPressure || 0;

  // v2.1.8: Update thermal pause state BEFORE any boost might fire.
  // checkThermalPauseExpiry detects pause→active transitions for logging.
  // updateThermalPause detects active→paused transitions (temp exceeded threshold).
  checkThermalPauseExpiry();
  updateThermalPause(thermalTemp);

  // Update metrics for thermal state
  if (metrics) {
    metrics.gauge('thermal_temp_celsius').set(
      typeof thermalTemp === 'number' ? Number(thermalTemp.toFixed(1)) : 0
    );
    metrics.gauge('thermal_pause_active').set(isThermalPaused() ? 1 : 0);
  }

  // ── Policy Engine: push sensor data into event sources ──────────
  // These calls update the state store AND emit transition events
  // (e.g. onBatteryLow, onCpuHigh, onThermalHigh). They are no-ops
  // when the policy engine is disabled.
  if (policySources) {
    try {
      if (batteryStatus) policySources.updateBattery(batteryStatus);
      if (thermalTemp !== null) policySources.updateThermal(thermalTemp);
      policySources.updatePressure(
        State.lastCpuPressure, State.lastMemPressure, result.stressLevel
      );
    } catch (err) {
      debug(`policySources update error: ${err?.message}`);
    }
  }

  // ── Detector Layer (v0.5.0 Phase 1): run detectors on every fastTick ──
  // Purely observational — never modifies system state. No-op when
  // ENABLE_DETECTOR_LAYER is false (detectorMgr stays null).
  if (detectorMgr) {
    try {
      detectorMgr.tick({
        foregroundPid: State.currentForegroundPid,
        foregroundInfo: null,  // populated on slowTick only
        procs: [],             // populated on slowTick only
        mediaPids: State.currentMediaPids,
        stressLevel: result.stressLevel,
        cpuPressure: State.lastCpuPressure,
        memPressure: State.lastMemPressure,
        thermalTemp,
        battery: batteryStatus,
        onBattery,
        adaptiveScore: scheduler.adaptiveScore,
        gpuUtilization: gpuUtil,
        networkRxKbps,
      });
    } catch (err) {
      debug(`detectorMgr.tick error: ${err?.message}`);
    }
  }

  // Update metrics
  if (metrics) {
    metrics.gauge('scheduler_stress_level').set(result.stressLevel);
    metrics.gauge('cpu_pressure').set(result.cpuPressure || 0);
    metrics.gauge('memory_pressure').set(result.memPressure || 0);
    metrics.gauge('adaptive_score').set(scheduler.adaptiveScore);
    metrics.gauge('cpu_history_cpu_avg').set(cpuHistory.cpuAvg);
    metrics.gauge('cpu_history_mem_avg').set(cpuHistory.memAvg);
    metrics.histogram('scheduler_tick_latency_ms').record(Date.now() - tickStart);
    if (result.changed) {
      metrics.counter('scheduler_state_transitions').increment();
    }
    // v2.1.10: GPU + network metrics
    if (gpuUtil !== null) metrics.gauge('gpu_utilization').set(gpuUtil);
    if (CONFIG.ENABLE_NETWORK_AWARENESS) {
      metrics.gauge('network_rx_kbps').set(networkRxKbps);
    }
  }

  // Handle auto-restore actions
  for (const action of result.actions) {
    if (action.type === 'RESTORE') {
      actuator.restoreProcess(action.pid, scheduler.allCores);
      if (metrics) metrics.counter('restore_count').increment();
    }
  }

  // Track consecutive normal ticks for idle backoff
  if (result.stressLevel === 'NORMAL') {
    State.consecutiveNormalTicks++;
  } else {
    State.consecutiveNormalTicks = 0;
  }

  metrics?.gauge('consecutive_normal_ticks').set(State.consecutiveNormalTicks);

  // Adaptive fast tick interval
  const desiredInterval =
    State.consecutiveNormalTicks > 10 ? CONFIG.FAST_TICK_IDLE_MS : CONFIG.FAST_TICK_MS;

  if (desiredInterval !== State.currentFastInterval) {
    State.currentFastInterval = desiredInterval;
    clearInterval(fastTimer);
    fastTimer = setInterval(fastTick, State.currentFastInterval);
    debug(`Fast tick interval disesuaikan ke ${desiredInterval}ms`);
    metrics?.gauge('fast_tick_interval_ms').set(desiredInterval);
  }

  // Force slowTick on CRITICAL for faster response
  if (result.stressLevel === 'CRITICAL') {
    slowTick().catch(() => { /* handled internally */ });
  }
}

// ── Slow Tick (process scan + scheduling) ─────────────────────────────

let _slowTickRunning = false;

async function slowTick() {
  if (_slowTickRunning || shuttingDown) return;
  _slowTickRunning = true;
  try {
    try {
      const fgStart = Date.now();
      const fgPid = await getForegroundPID();
      if (metrics) metrics.histogram('foreground_detect_latency_ms').record(Date.now() - fgStart);
      if (!fgPid) {
        debug('Foreground PID tidak ditemukan pada slowTick');
      } else if (fgPid === State.currentForegroundPid) {
        debug(`Foreground PID tetap: ${fgPid}`);
      } else {
        await handleForegroundChange(fgPid);
      }
    } catch (err) {
      debug(err?.message || 'Foreground PID tidak terdeteksi');
    }

    if (scheduler.stressLevel === 'NORMAL') return;

    // List processes
    let procs;
    try {
      const scanStart = Date.now();
      procs = await listProcesses();
      if (metrics) metrics.histogram('process_scan_latency_ms').record(Date.now() - scanStart);
    } catch (err) {
      warn('Gagal listing proses:', err.message);
      return;
    }

    // Detect multimedia processes
    if (CONFIG.ENABLE_MULTIMEDIA_PROTECTION && CONFIG.ENABLE_MULTIMEDIA_DETECTOR) {
      const pidToComm = new Map(procs.map((p) => [p.pid, p.comm]));
      try {
        const mediaStart = Date.now();
        State.currentMediaPids = await getActiveMediaPids(
          procs.map((p) => p.pid), pidToComm
        );
        if (metrics) {
          metrics.histogram('media_detect_latency_ms').record(Date.now() - mediaStart);
          metrics.counter('media_detections').increment();
          metrics.gauge('media_protected_pids').set(State.currentMediaPids.size);
          metrics.gauge('media_protected_count').set(State.currentMediaPids.size);
        }
      } catch (_) {
        State.currentMediaPids = new Set();
        for (const p of procs) {
          if (isKnownMediaProcessName(p.comm)) {
            State.currentMediaPids.add(p.pid);
          }
        }
      }
    }

    // Run plugins
    //
    // BUG FIX (v2.1.1): Previously the return value of runDetection()
    // was discarded — plugins were called but their PROTECT/BOOST/MONITOR
    // recommendations had zero effect on scheduling. The plugin system
    // was effectively dead code.
    //
    // Now we collect the detections and:
    //   * Build a `protectedPids` set from PROTECT and BOOST actions
    //     and merge it into the mediaPids set passed to
    //     classifyProcesses() so those PIDs are excluded from throttling.
    //   * Log MONITOR detections at debug level for observability.
    //   * Emit per-action counters to metrics.
    let pluginDetections = null;
    if (CONFIG.ENABLE_PLUGINS && pluginMgr && pluginMgr.size > 0) {
      try {
        pluginDetections = pluginMgr.runDetection(procs, {
          mediaPids: State.currentMediaPids,
          foregroundPid: State.currentForegroundPid,
          gameModeActive: false,
        });
      } catch (_) { /* plugin errors are non-fatal */ }
    }

    // Merge plugin-protected PIDs into the media PIDs set so the
    // scheduler's classifyProcesses() excludes them from throttling.
    // We make a shallow copy so we don't mutate State.currentMediaPids
    // (which is also used by metrics/fastTick).
    let effectiveMediaPids = State.currentMediaPids;
    if (pluginDetections && pluginDetections.size > 0) {
      effectiveMediaPids = new Set(State.currentMediaPids);
      let monitorCount = 0;
      let protectCount = 0;
      let boostCount = 0;
      for (const [pid, info] of pluginDetections) {
        const actions = info.actions || [];
        if (actions.includes('PROTECT')) {
          effectiveMediaPids.add(pid);
          protectCount++;
        }
        if (actions.includes('BOOST')) {
          // BOOST PIDs also shouldn't be throttled — they want foreground
          // treatment, so exclude them from the throttle pass too.
          effectiveMediaPids.add(pid);
          boostCount++;
        }
        if (actions.includes('MONITOR')) {
          monitorCount++;
          debug(`[plugin] MONITOR PID ${pid}: ${(info.reasons || []).join('; ')}`);
        }
      }
      if (metrics) {
        if (protectCount > 0) metrics.counter('plugin_protect_count').increment(protectCount);
        if (boostCount > 0)  metrics.counter('plugin_boost_count').increment(boostCount);
        if (monitorCount > 0) metrics.counter('plugin_monitor_count').increment(monitorCount);
      }
    }

    // ── Policy Engine: push process list to event sources ──────────
    // Emits onProcessStarted / onProcessExited transitions and updates
    // the state store. No-op when the policy engine is disabled.
    if (policySources) {
      try {
        policySources.updateProcesses(procs);
      } catch (err) {
        debug(`policySources.updateProcesses error: ${err?.message}`);
      }
    }

    // ── Detector Layer (v0.5.0 Phase 1): slowTick pass with full process list ──
    // slowTick has the foreground info + procs list, which fastTick
    // doesn't. We re-run the detectors here with the richer context
    // so workload / process detectors can do deep classification.
    // No-op when ENABLE_DETECTOR_LAYER is false.
    if (detectorMgr) {
      try {
        const fgInfo = State.currentForegroundPid
          ? getProcessInfo(State.currentForegroundPid) : null;
        detectorMgr.tick({
          foregroundPid: State.currentForegroundPid,
          foregroundInfo: fgInfo,
          procs,
          mediaPids: State.currentMediaPids,
          stressLevel: scheduler.stressLevel,
          cpuPressure: State.lastCpuPressure,
          memPressure: State.lastMemPressure,
          adaptiveScore: scheduler.adaptiveScore,
        });
      } catch (err) {
        debug(`detectorMgr.tick (slow) error: ${err?.message}`);
      }
    }

    // Get scheduling actions
    const actions = scheduler.classifyProcesses(
      procs, State.currentForegroundPid, effectiveMediaPids
    );

    // Execute throttle actions
    for (const action of actions) {
      if (action.type === 'THROTTLE') {
        _executeThrottle(action);
      }
    }

    // Persist rollback state periodically
    if (CONFIG.ENABLE_SAFE_ROLLBACK && rollbackMgr && scheduler.autoRestore.size > 0) {
      rollbackMgr.persist();
    }
  } finally {
    _slowTickRunning = false;
  }
}

function _executeThrottle(action) {
  debug(`THROTTLE background "${action.comm}" PID ${action.pid}`);
  if (actuator.cgroupsReady) {
    actuator.assignToCgroup(action.pid, actuator.backgroundCgroupPath);
    if (rollbackMgr) rollbackMgr.trackProcess(action.pid, 'cgroup', actuator.backgroundCgroupPath);
  } else {
    actuator.pinToCores(action.pid, action.cores);
    if (rollbackMgr) rollbackMgr.trackProcess(action.pid, 'affinity', action.cores.join(','));
  }
  actuator.setNiceness(action.pid, action.nice);
  if (rollbackMgr) rollbackMgr.trackProcess(action.pid, 'nice', action.nice);
  actuator.setIoPriority(action.pid, action.ioClass, action.ioLevel);
  if (rollbackMgr) rollbackMgr.trackProcess(action.pid, 'ionice', [action.ioClass, action.ioLevel]);

  scheduler.autoRestore.markThrottled(action.pid, { comm: action.comm });

  if (metrics) {
    metrics.counter('throttle_count').increment();
    metrics.gauge('throttled_process_count').set(scheduler.autoRestore.size);
  }
}

// ── Timer Management ──────────────────────────────────────────────────

function restartTimers() {
  clearInterval(fastTimer);
  clearInterval(slowTimer);
  State.currentFastInterval = CONFIG.FAST_TICK_MS;
  fastTimer = setInterval(fastTick, State.currentFastInterval);
  slowTimer = setInterval(slowTick, CONFIG.SLOW_TICK_MS);
  debug('Timer di-restart karena perubahan interval dari config.');
}

function clearAllTimers() {
  if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
  if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

// ── IPC Server (CLI interface) ────────────────────────────────────────

/**
 * Manual boost: boost any PID as if it were the foreground process.
 * Used by `dynalloc boost <pid>`.
 */
function manualBoost(pid) {
  if (!actuator || !scheduler) {
    throw new Error('daemon not fully initialized');
  }
  if (typeof pid !== 'number' || pid <= 0) {
    throw new Error('invalid PID');
  }
  // Check process is alive
  try { process.kill(pid, 0); } catch (_) {
    throw new Error(`PID ${pid} is not running`);
  }

  const boost = scheduler.generateForegroundBoost(pid, [], false);
  if (!boost) throw new Error('could not generate boost plan');

  _executeBoost(boost);

  // v2.1.10: Log to learning mode if enabled
  if (learningLogger) {
    learningLogger.logAction('boost', {
      pid: boost.pid,
      comm: boost.comm,
      schedClass: boost.schedClass,
      stressLevel: scheduler?.stressLevel,
      cpuPressure: State.lastCpuPressure,
      foregroundPid: State.currentForegroundPid,
    });
  }

  return {
    pid: boost.pid,
    comm: boost.comm,
    schedClass: boost.schedClass,
    nice: boost.nice,
    ioClass: boost.ioClass,
    ioLevel: boost.ioLevel,
    cores: boost.cores,
    governor: (CONFIG.ENABLE_GOVERNOR_SWITCH && !boost.gameModeActive)
      ? CONFIG.GOVERNOR_BOOST : null,
  };
}

/**
 * Manual throttle: throttle any PID to background class.
 * Used by `dynalloc throttle <pid>`.
 */
function manualThrottle(pid) {
  if (!actuator || !scheduler) {
    throw new Error('daemon not fully initialized');
  }
  if (typeof pid !== 'number' || pid <= 0) {
    throw new Error('invalid PID');
  }
  try { process.kill(pid, 0); } catch (_) {
    throw new Error(`PID ${pid} is not running`);
  }

  const nice = classifier.schedulerClassNice('BACKGROUND', CONFIG);
  const [ioClass, ioLevel] = classifier.schedulerClassIoPrio('BACKGROUND', CONFIG);
  const action = {
    type: 'THROTTLE',
    pid,
    comm: '',
    schedClass: 'BACKGROUND',
    nice,
    ioClass,
    ioLevel,
    cores: scheduler.backgroundCores,
  };

  // Try to get the comm for better logging
  try {
    const info = getProcessInfo(pid);
    if (info) action.comm = info.comm;
  } catch (_) { /* ignore */ }

  _executeThrottle(action);

  // v2.1.10: Log to learning mode if enabled
  if (learningLogger) {
    learningLogger.logAction('throttle', {
      pid: action.pid,
      comm: action.comm,
      schedClass: 'BACKGROUND',
      stressLevel: scheduler?.stressLevel,
      cpuPressure: State.lastCpuPressure,
      foregroundPid: State.currentForegroundPid,
    });
  }

  return {
    pid: action.pid,
    comm: action.comm,
    nice: action.nice,
    ioClass: action.ioClass,
    ioLevel: action.ioLevel,
    cores: action.cores,
  };
}

/**
 * Manual restore: restore a PID to default state.
 * Used by `dynalloc restore <pid>`.
 */
function manualRestore(pid) {
  if (!actuator || !scheduler) {
    throw new Error('daemon not fully initialized');
  }
  if (typeof pid !== 'number' || pid <= 0) {
    throw new Error('invalid PID');
  }
  try { process.kill(pid, 0); } catch (_) {
    throw new Error(`PID ${pid} is not running`);
  }

  actuator.restoreProcess(pid, scheduler.allCores);
  scheduler.autoRestore.remove(pid);

  return { pid, restored: true };
}

/**
 * Set up the IPC server and register all command handlers.
 */
async function setupIpcServer() {
  if (!CONFIG.ENABLE_IPC) {
    info('IPC server dinonaktifkan lewat config (ENABLE_IPC=false).');
    return;
  }

  ipcServer = new IpcServer({
    socketPath: CONFIG.IPC_SOCKET_PATH || undefined,
  });

  // ── ping ──────────────────────────────────────────────────────────
  ipcServer.registerHandler('ping', () => ({
    pong: true,
    version: '1.0.0',
    pid: process.pid,
    uptime: daemonStartTime ? Math.floor((Date.now() - daemonStartTime) / 1000) : 0,
  }));

  // ── status ────────────────────────────────────────────────────────
  ipcServer.registerHandler('status', () => {
    const throttledProcs = [];
    if (scheduler) {
      for (const [pid, info] of scheduler.autoRestore.getThrottledPidsWithInfo()) {
        throttledProcs.push({ pid, comm: info.comm || '', timestamp: info.timestamp });
      }
    }
    return {
      stressLevel: scheduler?.stressLevel,
      foregroundPid: State.currentForegroundPid,
      eventDrivenFocus: State.eventDrivenFocusActive,
      cgroupsReady: actuator?.cgroupsReady,
      adaptiveScore: scheduler?.adaptiveScore,
      throttledCount: scheduler?.autoRestore.size || 0,
      throttledProcesses: throttledProcs,
      mediaProtectedCount: State.currentMediaPids.size,
      plugins: pluginMgr?.registeredPlugins || [],
      policyEngine: policyEngine ? policyEngine.getStatus() : null,
      uptime: daemonStartTime ? Math.floor((Date.now() - daemonStartTime) / 1000) : 0,
      // v2.1.8: thermal protection state
      thermal: {
        enabled: CONFIG.ENABLE_THERMAL_PROTECTION,
        paused: isThermalPaused(),
        pausedUntil: State.thermalPausedUntil > 0 ? State.thermalPausedUntil : null,
        pausedRemainingMs: isThermalPaused() ? Math.max(0, State.thermalPausedUntil - Date.now()) : 0,
        lastTemp: State.thermalLastTemp,
        pauseCount: State.thermalPauseCount,
        pauseThreshold: CONFIG.THERMAL_PAUSE_THRESHOLD,
        resumeThreshold: CONFIG.THERMAL_RESUME_THRESHOLD,
      },
    };
  });

  // ── stats ─────────────────────────────────────────────────────────
  ipcServer.registerHandler('stats', () => ({
    report: getMetricsReport(),
    snapshot: metrics ? metrics.snapshot() : null,
  }));

  // ── metrics ───────────────────────────────────────────────────────
  ipcServer.registerHandler('metrics', () => metrics ? metrics.snapshot() : {});

  // ── throttled ─────────────────────────────────────────────────────
  ipcServer.registerHandler('throttled', () => {
    const list = [];
    if (scheduler) {
      for (const [pid, info] of scheduler.autoRestore.getThrottledPidsWithInfo()) {
        list.push({ pid, comm: info.comm || '', timestamp: info.timestamp });
      }
    }
    return { list, count: list.length };
  });

  // ── boost ─────────────────────────────────────────────────────────
  ipcServer.registerHandler('boost', (args) => {
    const pid = parseInt(args.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error('invalid or missing "pid" argument');
    }
    return manualBoost(pid);
  });

  // ── throttle ──────────────────────────────────────────────────────
  ipcServer.registerHandler('throttle', (args) => {
    const pid = parseInt(args.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error('invalid or missing "pid" argument');
    }
    return manualThrottle(pid);
  });

  // ── restore ───────────────────────────────────────────────────────
  ipcServer.registerHandler('restore', (args) => {
    const pid = parseInt(args.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error('invalid or missing "pid" argument');
    }
    return manualRestore(pid);
  });

  // ── doctor ────────────────────────────────────────────────────────
  ipcServer.registerHandler('doctor', () => {
    const report = State.selfCheckReport || runSelfCheck();
    return {
      ...report,
      daemonState: {
        stressLevel: scheduler?.stressLevel,
        foregroundPid: State.currentForegroundPid,
        throttledCount: scheduler?.autoRestore.size || 0,
        cgroupsReady: actuator?.cgroupsReady,
      },
    };
  });

  // ── shutdown (graceful) ───────────────────────────────────────────
  ipcServer.registerHandler('shutdown', (args) => {
    // Require a confirm token to prevent accidental shutdown via scripting
    if (args.confirm !== 'yes') {
      throw new Error('shutdown requires args.confirm="yes"');
    }
    info('Shutdown requested via IPC');
    setImmediate(() => cleanupAndExit('IPC shutdown', 0));
    return { shuttingDown: true };
  });

  // ── learn (v2.1.10: learning mode rule suggestions) ─────────────
  ipcServer.registerHandler('learn', (args) => {
    if (!learningLogger) {
      throw new Error('learning mode is not enabled (set ENABLE_LEARNING_MODE=true)');
    }
    if (args.action === 'clear') {
      learningLogger.clear();
      return { cleared: true };
    }
    // Default: suggest rules
    return learningLogger.suggestRules();
  });

  // ── profiles (v2.1.10: per-app profile management) ──────────────
  ipcServer.registerHandler('profiles', () => {
    if (!perAppProfiles) {
      return { enabled: false, profiles: [] };
    }
    return {
      enabled: true,
      count: perAppProfiles.profileCount,
      profiles: perAppProfiles.profiles,
    };
  });

  // ── network (v0.4.0 Phase 2) ─────────────────────────────────────
  // Returns the NetworkController status, or {enabled: false} when
  // ENABLE_NETWORK_QOS is false.
  ipcServer.registerHandler('network', () => {
    if (!actuator) return { enabled: false, error: 'actuator not initialized' };
    const status = actuator.getNetworkStatus();
    if (!status) return { enabled: false };
    return status;
  });

  // ── detectors (v0.5.0 Phase 1) ──────────────────────────────────
  // Returns the Detector Layer status, or {enabled: false} when
  // ENABLE_DETECTOR_LAYER is false.
  ipcServer.registerHandler('detectors', () => {
    if (!detectorMgr) return { enabled: false };
    return detectorMgr.getStatus();
  });

  // ── resources (v0.5.0 Phase 2) ──────────────────────────────────
  // Returns the Resource Controller Layer status, or {enabled: false}
  // when ENABLE_RESOURCE_CONTROLLER_LAYER is false.
  ipcServer.registerHandler('resources', () => {
    if (!resourceControllerMgr) return { enabled: false };
    return resourceControllerMgr.getStatus();
  });

  // ── profiles (v0.5.0 Phase 3) ───────────────────────────────────
  // Returns the Profile Manager status, or {enabled: false} when
  // ENABLE_PROFILE_MANAGER is false.
  ipcServer.registerHandler('profiles', () => {
    if (!profileMgr) return { enabled: false };
    return profileMgr.getStatus();
  });

  // ── adaptive (v0.5.0 Phase 4) ───────────────────────────────────
  // Returns the Adaptive Switching Engine status, or {enabled: false}
  // when ENABLE_ADAPTIVE_SWITCHING is false.
  ipcServer.registerHandler('adaptive', () => {
    if (!adaptiveEngine) return { enabled: false };
    return adaptiveEngine.getStatus();
  });

  // ── adaptive-override (v0.5.0 Phase 4) ──────────────────────────
  // Demand a user-override profile (highest priority, bypasses cooldown).
  // Args: { action: 'demand'|'release', profile?: 'gaming' }
  ipcServer.registerHandler('adaptive-override', (args) => {
    if (!adaptiveEngine) {
      return { enabled: false, error: 'adaptive engine not enabled' };
    }
    const action = args && args.action;
    if (action === 'release') {
      adaptiveEngine.releaseUserOverride();
      return { success: true, released: true };
    }
    if (action === 'demand') {
      const profile = args && args.profile;
      if (typeof profile !== 'string' || profile.length === 0) {
        return { success: false, error: 'profile required' };
      }
      return adaptiveEngine.demandUserOverride(profile);
    }
    return { success: false, error: 'action must be "demand" or "release"' };
  });

  // ── recognition (v0.5.0 Phase 5) ────────────────────────────────
  // Returns the Workload Recognition Engine status, or {enabled: false}
  // when ENABLE_WORKLOAD_RECOGNITION is false.
  ipcServer.registerHandler('recognition', () => {
    if (!recognitionEngine) return { enabled: false };
    return recognitionEngine.getStatus();
  });

  // ── monitor (v0.5.0 Phase 6) ────────────────────────────────────
  // Returns a system state snapshot.
  ipcServer.registerHandler('monitor', () => {
    if (!systemMonitor) return { enabled: false };
    return systemMonitor.snapshot();
  });

  // ── diagnostics (v0.5.0 Phase 6) ────────────────────────────────
  // Returns a full diagnostics report.
  ipcServer.registerHandler('diagnostics', () => {
    if (!diagnosticsEngine) return { enabled: false };
    return diagnosticsEngine.report();
  });

  // ── health (v0.5.0 Phase 6) ─────────────────────────────────────
  // Runs a health check and returns results.
  ipcServer.registerHandler('health', () => {
    if (!healthChecker) return { enabled: false, healthy: true };
    return healthChecker.check();
  });

  // ── benchmark (v0.5.0 Phase 6) ──────────────────────────────────
  // Runs on-demand benchmarks.
  // Args: { name?: 'eventProcessing', iterations?: 100 }
  ipcServer.registerHandler('benchmark', (args) => {
    if (!benchmarkFramework) return { enabled: false };
    if (!CONFIG.MONITORING_BENCHMARK_ENABLED) {
      return { enabled: true, error: 'benchmarks disabled (MONITORING_BENCHMARK_ENABLED=false)' };
    }
    const name = args && args.name;
    const iterations = args && args.iterations;
    if (name) {
      return benchmarkFramework.run(name, { iterations });
    }
    return { results: benchmarkFramework.runAll({ iterations: 50 }) };
  });

  // ── sdk (v0.5.0 Phase 7) ────────────────────────────────────────
  // Returns the Plugin SDK status, or {enabled: false} when
  // ENABLE_PLUGIN_SDK is false.
  ipcServer.registerHandler('sdk', () => {
    if (!pluginSdkManager) return { enabled: false };
    return pluginSdkManager.getStatus();
  });

  await ipcServer.start();
}

/**
 * Detect the foreground detection method based on the current session.
 * Returns a human-readable string for logging.
 */
function _detectFocusMethod() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const sessionType = process.env.XDG_SESSION_TYPE || '';
  const waylandDisplay = !!process.env.WAYLAND_DISPLAY;
  const isWayland = sessionType === 'wayland' || waylandDisplay;

  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    return 'hyprctl (Hyprland) → xdotool fallback';
  }
  if (process.env.SWAYSOCK || desktop.includes('sway')) {
    return 'swaymsg -t get_tree (Sway) → xdotool fallback';
  }
  if (desktop.includes('kde') && isWayland) {
    return 'qdbus org.kde.KWin (Plasma Wayland) → kdotool → xdotool fallback';
  }
  if (desktop.includes('gnome') && isWayland) {
    return 'gdbus Window Calls Extended (GNOME/Wayland) → xdotool fallback';
  }
  return 'xdotool (X11)';
}

/**
 * v2.1.10: Watchdog timer — periodically check if fastTick is running.
 * If fastTick hasn't run in WATCHDOG_TIMEOUT_MS, force restart the timers.
 * This prevents the daemon from hanging silently (e.g. if a blocking I/O
 * call in fastTick never returns).
 */
function setupWatchdog() {
  if (!CONFIG.ENABLE_WATCHDOG) return;
  const checkInterval = CONFIG.WATCHDOG_CHECK_INTERVAL_MS || 10000;
  const timeout = CONFIG.WATCHDOG_TIMEOUT_MS || 30000;

  watchdogTimer = setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    const elapsed = now - lastFastTickTime;
    if (lastFastTickTime > 0 && elapsed > timeout) {
      error(`Watchdog: fastTick hasn't run in ${Math.round(elapsed / 1000)}s — forcing timer restart.`);
      if (metrics) metrics.counter('watchdog_restarts').increment();
      // Restart timers
      try {
        clearInterval(fastTimer);
        clearInterval(slowTimer);
        State.currentFastInterval = CONFIG.FAST_TICK_MS;
        fastTimer = setInterval(fastTick, State.currentFastInterval);
        slowTimer = setInterval(slowTick, CONFIG.SLOW_TICK_MS);
        lastFastTickTime = now; // reset so we don't immediately re-trigger
        info('Watchdog: timers restarted.');
      } catch (err) {
        error(`Watchdog: restart failed: ${err.message}`);
      }
    }
  }, checkInterval);
  // Don't keep the event loop alive for the watchdog
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  info(`Watchdog aktif (timeout: ${timeout / 1000}s, check: ${checkInterval / 1000}s).`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────

function bootstrap() {
  // 1. Load config
  initConfig();
  daemonStartTime = Date.now();

  // 2. Banner
  info('='.repeat(60));
  info('DynAlloc v1.0 — Adaptive Linux Resource Manager');
  info('='.repeat(60));
  info(`Mode: ${CONFIG.DRY_RUN ? 'DRY_RUN (aman)' : 'LIVE'}`);

  // 3. Self-check
  if (CONFIG.ENABLE_SELF_CHECK) {
    const report = runSelfCheck();
    State.selfCheckReport = report;
    printReport(report);

    // Fallbacks based on self-check
    if (!report.psi.cpu && !report.psi.memory) {
      warn('PSI tidak tersedia — scheduler tidak bisa membaca pressure.');
      CONFIG.PSI_CPU_WARN = 999;
      CONFIG.PSI_CPU_CRITICAL = 999;
      CONFIG.PSI_MEM_WARN = 999;
      CONFIG.PSI_MEM_CRITICAL = 999;
    }

    if (report.cgroupsV2.available === false && CONFIG.CGROUP_MODE !== 'root') {
      warn('Cgroups v2 tidak tersedia, memakai fallback.');
      CONFIG.ENABLE_CGROUPS_V2 = false;
    }

    if (!report.cpufreq.available) {
      warn('cpufreq tidak tersedia, governor switch dimatikan.');
      CONFIG.ENABLE_GOVERNOR_SWITCH = false;
    }
  }

  // 4. Crash recovery
  if (CONFIG.ENABLE_SAFE_ROLLBACK) {
    rollbackMgr = new RollbackManager(CONFIG.ROLLBACK_STATE_FILE);
    rollbackMgr.recoverFromCrash(CONFIG);
  }

  // 5. Detect CPU topology
  let topology;
  if (CONFIG.ENABLE_CPU_TOPOLOGY && CONFIG.ENABLE_TOPOLOGY) {
    topology = detectTopology();
    info(`CPU Topology: ${topology.logicalCount} logical / ${topology.physicalCount} physical` +
      ` | SMT: ${topology.smtEnabled} (${topology.threadsPerCore}T/core)` +
      ` | NUMA: ${topology.numaNodes.length} nodes` +
      ` | Hybrid: ${topology.isHybrid ? `yes (P:${topology.pCores.length} E:${topology.eCores.length})` : 'no'}` +
      ` | AMD CCD: ${topology.ccdCount > 0 ? topology.ccdCount : 'N/A'}`);
  } else {
    topology = {
      logicalCount: TOTAL_CORES, physicalCount: TOTAL_CORES,
      smtEnabled: false, threadsPerCore: 1, numaNodes: [],
      isHybrid: false, pCores: [], eCores: [],
      isAMD: false, ccds: [], ccdCount: 0,
      logicalToPhysical: new Map(), threadSiblings: new Map(),
    };
  }

  // 6. Create subsystems
  cpuHistory = new CpuHistory(CONFIG.ENABLE_CPU_HISTORY ? CONFIG.CPU_HISTORY_SIZE : 1);
  scheduler = new Scheduler(CONFIG, topology, cpuHistory);
  actuator = new Actuator(CONFIG);
  actuator.setupCgroups();

  // v0.4.0 Phase 2: Network QoS — set up AFTER cgroups (nftables marking
  // needs the foreground/background cgroup paths). No-op when
  // ENABLE_NETWORK_QOS is false (the default).
  actuator.networkSetup();

  // BUG FIX (v2.1.2): Tell the rollback manager about the resolved cgroup
  // base path so crash recovery writes PIDs back to the correct cgroup
  // (not always /sys/fs/cgroup root). This must happen AFTER setupCgroups
  // resolves the base, and BEFORE any boost/throttle fires.
  if (rollbackMgr && actuator.cgroupBasePath) {
    rollbackMgr.setCgroupBase(actuator.cgroupBasePath);
  }

  // 7. Metrics
  if (CONFIG.ENABLE_METRICS) {
    metrics = getMetrics();
    info('Metrics system aktif.');
  }

  // 8. Plugin system
  if (CONFIG.ENABLE_PLUGINS) {
    pluginMgr = getPluginManager();
    const loaded = pluginMgr.loadBuiltinPlugins();
    if (CONFIG.PLUGIN_DIR) {
      pluginMgr.loadCustomPlugins(CONFIG.PLUGIN_DIR, CONFIG);
    }
    // Pass a config snapshot to plugins. When the policy engine is
    // enabled, expose it via config.__policyEngine so plugins can
    // subscribe to bus events without modifying daemon core.
    const pluginConfig = { ...CONFIG };
    // __policyEngine is set later (after the engine is constructed
    // in step 16b). Plugins that need it should access it lazily
    // via daemon.getState().policyEngine.
    pluginMgr.initAll(pluginConfig);
    info(`Plugin system aktif (${pluginMgr.size} plugin).`);
  }

  // 9. Governor
  //
  // v2.1.7: PPD coordination — detect power-profiles-daemon before
  // enabling governor switching. PPD manages governor switching via its
  // own DBus interface; if both DynAlloc and PPD switch governors, they
  // fight (PPD sets "powersave", DynAlloc sets "performance" 5s later,
  // PPD reverts, etc.). When PPD is detected and ENABLE_PPD_COORDINATION
  // is true (default), we mute DynAlloc's governor switching at runtime.
  if (CONFIG.ENABLE_GOVERNOR_SWITCH && CONFIG.ENABLE_PPD_COORDINATION) {
    const ppdStatus = checkPowerProfilesDaemon();
    if (ppdStatus.active) {
      warn(`Power Profiles Daemon (PPD) terdeteksi (active profile: "${ppdStatus.profile}").`);
      warn('Governor switching dimatikan untuk menghindari konflik dengan PPD.');
      warn('Fitur lain (cgroups, nice, io, memory limits, OOM) tetap aktif.');
      warn('Set ENABLE_PPD_COORDINATION=false di config untuk override.');
      CONFIG.ENABLE_GOVERNOR_SWITCH = false;
    }
  }

  if (CONFIG.ENABLE_GOVERNOR_SWITCH) {
    governorMgr = new GovernorManager();
    governorMgr.captureOriginals(scheduler.foregroundCores);
    // Sync the just-captured originals into the rollback manager so
    // crash recovery (which runs in step 4 above, before this point)
    // and shutdown restore both have the full picture. This also
    // covers the case where recoverFromCrash() ran but the daemon
    // then crashes again before any boost/throttle fires.
    if (rollbackMgr) _syncGovernorRollbackState();
    info(`CPU governor switching aktif (boost -> "${CONFIG.GOVERNOR_BOOST}").`);
    if (metrics) metrics.gauge('current_governor').set(CONFIG.GOVERNOR_BOOST);
  } else if (!CONFIG.ENABLE_GOVERNOR_SWITCH) {
    info('CPU governor switching dimatikan (ENABLE_GOVERNOR_SWITCH=false).');
  }

  // 10. OOM & GameMode
  if (CONFIG.ENABLE_OOM_PROTECTION) {
    info(`OOM protection aktif (foreground oom_score_adj -> ${CONFIG.FOREGROUND_OOM_SCORE_ADJ}).`);
  }
  if (CONFIG.ENABLE_GAMEMODE_COEXIST) {
    info('Koeksistensi Feral GameMode aktif.');
  }

  // 11. Desktop info — v2.1.4: detect all supported sessions
  const detectedDesktop = process.env.XDG_CURRENT_DESKTOP || '(tidak diketahui)';
  const detectedSession = process.env.XDG_SESSION_TYPE || '(tidak diketahui)';
  const focusMethod = _detectFocusMethod();
  info(`Desktop: ${detectedDesktop} | Session: ${detectedSession} | Metode deteksi foreground: ${focusMethod}`);
  info(`Resource control: ${actuator.cgroupsReady ? 'cgroups v2 (cpu.weight/cpu.max)' : 'taskset+renice (fallback)'}`);
  info(`Foreground cores: [${scheduler.foregroundCores.join(',')}] | Background cores: [${scheduler.backgroundCores.join(',')}]`);
  info('='.repeat(60));

  // 12. Setup scheduler state provider for logger
  setSchedulerStateProvider(() => scheduler.stressLevel);

  // 13. Self-deprioritize daemon
  actuator.setNiceness(SELF_PID, 10);
  actuator.setIoPriority(SELF_PID, 3, 0);

  // 14. Start timers
  fastTimer = setInterval(fastTick, State.currentFastInterval);
  slowTimer = setInterval(slowTick, CONFIG.SLOW_TICK_MS);

  // 15. Metrics update timer (every 10s)
  if (CONFIG.ENABLE_METRICS && metrics) {
    metricsTimer = setInterval(() => {
      metrics.updateDaemonResourceMetrics();
      metrics.gauge('daemon_uptime_seconds').set(Math.floor((Date.now() - (metrics._startTime || Date.now())) / 1000));
    }, 10000);
  }

  // 16. Setup hot-reload and event-driven focus
  setupHotReload();
  setupEventDrivenFocus();

  // 16b. Policy Engine (v2.2, optional)
  // Loaded AFTER all subsystems are up so it can subscribe to
  // actuator/scheduler/governor without ordering issues. The engine
  // runs in pure observer mode — it never modifies the existing
  // scheduler/actuator state directly, only via the ActionExecutor
  // wrapper which goes through the same public APIs the daemon uses.
  if (CONFIG.ENABLE_POLICY_ENGINE) {
    try {
      PolicyEngine = require('./policy-engine').PolicyEngine;
      EventSources = require('./policy-engine/event-sources').EventSources;
      PolicyEvents = require('./policy-engine').EVENTS;

      policyEngine = new PolicyEngine({
        actuator,
        governor: governorMgr,
        scheduler,
        config: CONFIG,
        metrics,
        ownBus: true, // isolated bus — policy engine does not pollute global state
      });

      // Synchronous load (the async start() only awaits I/O which is
      // already done by load()). We construct policySources BEFORE
      // start() so the engine is fully wired before the first event.
      // start() never rejects — internal errors are caught and logged.
      policyEngine.start().then(() => {
        policySources = new EventSources({
          engine: policyEngine,
          config: CONFIG,
        });
        // Expose the engine to plugins via the config object so they
        // can subscribe to bus events without modifying daemon core.
        // We mutate CONFIG directly because plugins hold a reference
        // to it from initAll().
        CONFIG.__policyEngine = policyEngine;
        info(`Policy Engine aktif (rules: ${policyEngine.ruleEngine.size}, ` +
             `policy file: ${policyEngine.filePath || 'none'})`);
      }).catch((err) => {
        // Should never happen — start() catches internally — but
        // defense-in-depth: don't leave a half-initialized engine.
        warn(`PolicyEngine failed to start: ${err.message}`);
        try { policyEngine.destroy(); } catch (_) { /* noop */ }
        policyEngine = null;
        policySources = null;
      });
    } catch (err) {
      warn(`Policy Engine init error: ${err.message}`);
      policyEngine = null;
      policySources = null;
    }
  }

  // 16c. v0.5.0 Phase 1: Detector Layer (optional)
  //
  // Constructed AFTER the Policy Engine so it can share the PE bus
  // when PE is enabled. When PE is disabled, the DetectorManager
  // creates its own isolated bus. Either way, detectors are purely
  // observational — they never modify system state.
  //
  // When ENABLE_DETECTOR_LAYER is false (the default), no detector
  // code is loaded — zero behavior change from v0.4.0.
  if (CONFIG.ENABLE_DETECTOR_LAYER) {
    try {
      DetectorModule = require('./detectors');
      // Share the PE bus when PE is enabled, so detector events are
      // visible to PE rules. Otherwise create an isolated bus.
      const detectorBus = policyEngine ? policyEngine.bus : null;
      detectorMgr = new DetectorModule.DetectorManager({
        config: CONFIG,
        bus: detectorBus,
        metrics,
        stateStore: policyEngine ? policyEngine.stateStore : null,
      });
      // Register the built-in detectors
      const detectors = DetectorModule.createBuiltinDetectors({
        config: CONFIG,
        logger,
        bus: detectorMgr.bus,
        stateStore: policyEngine ? policyEngine.stateStore : null,
        metrics,
      });
      for (const det of detectors) {
        detectorMgr.register(det);
      }
      detectorMgr.setupAll();
      detectorMgr.startAll();
      info(`Detector Layer aktif (${detectorMgr.size} detector: ${detectorMgr.registeredDetectors.join(', ')}).`);
    } catch (err) {
      warn(`Detector Layer init error: ${err.message}`);
      detectorMgr = null;
      DetectorModule = null;
    }
  }

  // 16d. v0.5.0 Phase 2: Resource Controller Layer (optional)
  //
  // Constructed AFTER the Actuator + Governor + Detector Layer so it
  // can reference their controller instances. Aggregates all resource
  // controllers (CPU, Memory, IO, Network, Governor, Thermal, Power)
  // into a unified entry point for the Policy Engine.
  //
  // When ENABLE_RESOURCE_CONTROLLER_LAYER is false (the default), no
  // manager is constructed — the PE continues to call the Actuator /
  // Governor directly (backward compat). When true, the manager is
  // constructed and passed to the PE constructor so new action types
  // (setThermalProfile, setPowerProfile) can route through it.
  if (CONFIG.ENABLE_RESOURCE_CONTROLLER_LAYER) {
    try {
      ResourceControllerManager = require('./lib/resource-controller-manager');
      resourceControllerMgr = new ResourceControllerManager({
        config: CONFIG,
        actuator,
        governor: governorMgr,
        metrics,
        cgroupManager: actuator._cgroupManager,
      });
      resourceControllerMgr.setupAll();
      resourceControllerMgr.startAll();
      info(`Resource Controller Layer aktif (${resourceControllerMgr.size} controller: ${resourceControllerMgr.registeredControllers.join(', ')}).`);
    } catch (err) {
      warn(`Resource Controller Layer init error: ${err.message}`);
      resourceControllerMgr = null;
      ResourceControllerManager = null;
    }
  }

  // v0.5.0 Phase 2: pass the ResourceControllerManager to the Policy
  // Engine's action executor so new action types (setThermalProfile,
  // setPowerProfile, setPpdProfile) can route through it. This is
  // done AFTER both the PE and the RCM are constructed.
  if (policyEngine && resourceControllerMgr && policyEngine.executor) {
    try {
      policyEngine.executor.setResourceControllerManager(resourceControllerMgr);
      debug('ResourceControllerManager wired into PolicyEngine action executor.');
    } catch (err) {
      warn(`Failed to wire ResourceControllerManager into PE: ${err.message}`);
    }
  }

  // 16e. v0.5.0 Phase 3: Profile Manager (optional)
  //
  // Constructed AFTER the RCM (needs it to apply profiles) and AFTER
  // the Detector Layer (needs the bus to subscribe to detector events).
  // Subscribes to onWorkloadDetected / onPowerStateChanged /
  // onIdleStateChanged and automatically activates profiles based on
  // a deterministic priority system.
  //
  // When ENABLE_PROFILE_MANAGER is false (the default), no manager is
  // constructed — the PE's existing applyProfile action continues to
  // work independently.
  if (CONFIG.ENABLE_PROFILE_MANAGER && resourceControllerMgr) {
    try {
      ProfileManagerModule = require('./profiles');
      // Use the PE bus when available, else the detector bus, else
      // create an isolated one. The ProfileManager needs a bus that
      // carries detector events.
      const profileBus = policyEngine ? policyEngine.bus :
                         (detectorMgr ? detectorMgr.bus : null);
      profileMgr = new ProfileManagerModule.ProfileManager({
        config: CONFIG,
        bus: profileBus,
        rcm: resourceControllerMgr,
        metrics,
        stateStore: policyEngine ? policyEngine.stateStore : null,
      });
      profileMgr.setup();
      profileMgr.start();
      info(`Profile Manager aktif (${profileMgr.registry.size} profile(s) registered).`);
    } catch (err) {
      warn(`Profile Manager init error: ${err.message}`);
      profileMgr = null;
      ProfileManagerModule = null;
    }
  }

  // 16f. v0.5.0 Phase 4: Adaptive Switching Engine (optional)
  //
  // Constructed AFTER the Profile Manager (needs it to delegate
  // validated transitions). Wraps the PM with debounce, cooldown,
  // oscillation detection, rollback, and user override support.
  //
  // When ENABLE_ADAPTIVE_SWITCHING is false (the default), the PM
  // receives events directly (Phase 3 behavior). When true, the
  // AdaptiveEngine intercepts events first.
  if (CONFIG.ENABLE_ADAPTIVE_SWITCHING && profileMgr) {
    try {
      AdaptiveModule = require('./adaptive');
      const aeBus = policyEngine ? policyEngine.bus :
                    (detectorMgr ? detectorMgr.bus : null);
      adaptiveEngine = new AdaptiveModule.AdaptiveEngine({
        config: CONFIG,
        bus: aeBus,
        profileManager: profileMgr,
        metrics,
      });
      adaptiveEngine.setup();
      adaptiveEngine.start();
      info('Adaptive Switching Engine aktif (debounce + cooldown + rollback).');
    } catch (err) {
      warn(`Adaptive Switching Engine init error: ${err.message}`);
      adaptiveEngine = null;
      AdaptiveModule = null;
    }
  }

  // 16g. v0.5.0 Phase 5: Workload Recognition Engine (optional)
  //
  // Constructed AFTER the Profile Manager (needs it to demand profiles).
  // Subscribes to detector events, runs the WorkloadRecognizer, and
  // demands the top-confidence workload's profile from the PM.
  //
  // When ENABLE_WORKLOAD_RECOGNITION is false (the default), no
  // engine is constructed. When true, it adds a 'recognition' demand
  // source to the PM.
  if (CONFIG.ENABLE_WORKLOAD_RECOGNITION && profileMgr) {
    try {
      RecognitionModule = require('./recognition');
      const recBus = policyEngine ? policyEngine.bus :
                     (detectorMgr ? detectorMgr.bus : null);
      recognitionEngine = new RecognitionModule.RecognitionEngine({
        config: CONFIG,
        bus: recBus,
        profileManager: profileMgr,
        metrics,
      });
      recognitionEngine.setup();
      recognitionEngine.start();
      info(`Workload Recognition Engine aktif (${recognitionEngine.recognizer.ruleCount} rules, threshold=${CONFIG.RECOGNITION_CONFIDENCE_THRESHOLD}).`);
    } catch (err) {
      warn(`Workload Recognition Engine init error: ${err.message}`);
      recognitionEngine = null;
      RecognitionModule = null;
    }
  }

  // 16h. v0.5.0 Phase 6: Monitoring Framework (optional)
  //
  // Constructs all monitoring components: SystemMonitor, DiagnosticsEngine,
  // HealthChecker, BenchmarkFramework, MetricsCollector. All are READ-ONLY.
  // Gated by ENABLE_MONITORING_FRAMEWORK (default false).
  if (CONFIG.ENABLE_MONITORING_FRAMEWORK) {
    try {
      MonitoringModule = require('./monitoring');

      // Providers — functions that return subsystem state (avoids circular imports)
      const providers = {
        getState: () => getState(),
        getUptime: () => daemonStartTime ? Math.floor((Date.now() - daemonStartTime) / 1000) : 0,
        getDetectorStatus: () => detectorMgr ? detectorMgr.getStatus() : null,
        getRcmStatus: () => resourceControllerMgr ? resourceControllerMgr.getStatus() : null,
        getProfileManagerStatus: () => profileMgr ? profileMgr.getStatus() : null,
        getAdaptiveStatus: () => adaptiveEngine ? adaptiveEngine.getStatus() : null,
        getRecognitionStatus: () => recognitionEngine ? recognitionEngine.getStatus() : null,
        getPolicyEngineStatus: () => policyEngine ? policyEngine.getStatus() : null,
        getPluginNames: () => pluginMgr ? pluginMgr.registeredPlugins : [],
        getBusStatus: () => {
          if (policyEngine) return { destroyed: false, listeners: 0 };
          if (detectorMgr) return { destroyed: false, listeners: 0 };
          return { destroyed: false, listeners: 0 };
        },
        getMetricsSnapshot: () => metrics ? metrics.snapshot() : {},
        readCpuPSI: () => { try { return readCpuPSI(); } catch (_) { return null; } },
        readMemPSI: () => { try { return readMemPSI(); } catch (_) { return null; } },
        readThermalTemp: (idx) => { try { return readThermalTemp(idx); } catch (_) { return null; } },
        readBatteryStatus: (p) => { try { return readBatteryStatus(p); } catch (_) { return null; } },
        getNetworkRxBytes: () => { try { return getNetworkRxBytes(); } catch (_) { return null; } },
        getGpuUtilization: () => { try { return getGpuUtilization(); } catch (_) { return null; } },
        getBus: () => policyEngine ? policyEngine.bus : (detectorMgr ? detectorMgr.bus : null),
      };

      systemMonitor = new MonitoringModule.SystemMonitor({ config: CONFIG, providers });
      diagnosticsEngine = new MonitoringModule.DiagnosticsEngine({ config: CONFIG, providers });
      healthChecker = new MonitoringModule.HealthChecker({ config: CONFIG, providers, diagnostics: diagnosticsEngine });
      benchmarkFramework = new MonitoringModule.BenchmarkFramework({ config: CONFIG, providers });
      metricsCollector = new MonitoringModule.MetricsCollector({ config: CONFIG, metrics });

      healthChecker.start();
      info('Monitoring Framework aktif (system monitor + diagnostics + health + benchmark + metrics).');
    } catch (err) {
      warn(`Monitoring Framework init error: ${err.message}`);
      systemMonitor = null;
      diagnosticsEngine = null;
      healthChecker = null;
      benchmarkFramework = null;
      metricsCollector = null;
      MonitoringModule = null;
    }
  }

  // 16i. v0.5.0 Phase 7: Plugin SDK (optional)
  //
  // Constructs the PluginLifecycleManager which provides a stable,
  // versioned Public API for third-party plugins. Loads plugins from
  // PLUGIN_SDK_DIR if configured. Gated by ENABLE_PLUGIN_SDK.
  if (CONFIG.ENABLE_PLUGIN_SDK) {
    try {
      SdkModule = require('./sdk');
      const sdkProviders = {
        getConfig: () => CONFIG,
        getState: () => getState(),
        getMetrics: () => metrics ? metrics.snapshot() : {},
        getDiagnostics: () => diagnosticsEngine ? diagnosticsEngine.report() : {},
        getHealth: () => healthChecker ? healthChecker.check() : { healthy: true },
        getBus: () => policyEngine ? policyEngine.bus : (detectorMgr ? detectorMgr.bus : null),
        registerDetector: (d) => detectorMgr ? detectorMgr.register(d) : false,
        registerProfile: (def) => profileMgr ? profileMgr.registry.register(def) : { success: false, error: 'PM not available' },
        registerController: (c) => resourceControllerMgr ? resourceControllerMgr.registerController(c) : false,
        registerRule: (r) => recognitionEngine ? recognitionEngine.recognizer.registerRule(r) : false,
        registerCliCommand: (_cmd, _fn) => false,  // CLI extension not yet wired
      };
      pluginSdkManager = new SdkModule.PluginLifecycleManager({
        config: CONFIG,
        apiVersion: CONFIG.PLUGIN_SDK_API_VERSION || '1.0',
        daemonVersion: '0.5.0',
        providers: sdkProviders,
        diagnostics: diagnosticsEngine,
      });

      // Load plugins from PLUGIN_SDK_DIR if configured
      if (CONFIG.PLUGIN_SDK_DIR) {
        try {
          const sdkDir = CONFIG.PLUGIN_SDK_DIR;
          if (fs.existsSync(sdkDir)) {
            const entries = fs.readdirSync(sdkDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                const pluginDir = path.join(sdkDir, entry.name);
                const result = pluginSdkManager.loadFromDirectory(pluginDir);
                if (!result.success) {
                  warn(`Plugin SDK: failed to load "${entry.name}": ${result.error}`);
                }
              }
            }
          }
        } catch (dirErr) {
          warn(`Plugin SDK: cannot scan plugin directory: ${dirErr.message}`);
        }
      }

      info(`Plugin SDK aktif (API ${CONFIG.PLUGIN_SDK_API_VERSION || '1.0'}, ${pluginSdkManager.size} plugin(s) loaded).`);
    } catch (err) {
      warn(`Plugin SDK init error: ${err.message}`);
      pluginSdkManager = null;
      SdkModule = null;
    }
  }

  // 17. Start IPC server (for CLI tool — `dynalloc status`, etc.)
  // Done AFTER all subsystems are up so CLI commands see a fully-initialized daemon.
  setupIpcServer().catch((err) => {
    warn(`IPC server failed to start: ${err.message}`);
    // Non-fatal — daemon still works, just no CLI access
  });

  // 17b. v2.1.10: Per-app profiles
  if (CONFIG.ENABLE_PER_APP_PROFILES) {
    perAppProfiles = new PerAppProfiles(CONFIG);
    perAppProfiles.reload();
    if (perAppProfiles.profileCount > 0) {
      info(`Per-app profiles aktif (${perAppProfiles.profileCount} profile(s): ${perAppProfiles.profiles.join(', ')}).`);
    } else {
      info('Per-app profiles aktif (no profiles loaded yet).');
    }
  }

  // 17c. v2.1.10: Learning logger
  if (CONFIG.ENABLE_LEARNING_MODE) {
    learningLogger = new LearningLogger(CONFIG);
    info(`Learning mode aktif (log: ${learningLogger.logFile}).`);
  }

  // 17d. v2.1.10: Watchdog timer
  setupWatchdog();

  // 18. Initial ticks
  fastTick();
  slowTick().catch(() => { /* handled internally */ });
}

// ── Shutdown & Cleanup ────────────────────────────────────────────────

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function cleanupAndExit(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  info(`Menerima ${signal}, mengembalikan proses ke normal...`);

  try {
    // Restore foreground process
    if (State.currentForegroundPid && pidAlive(State.currentForegroundPid) && scheduler && actuator) {
      actuator.restoreProcess(State.currentForegroundPid, scheduler.allCores);
    }

    // Restore all throttled processes
    if (scheduler && actuator) {
      for (const [pid] of scheduler.autoRestore.getThrottledPids()) {
        if (pidAlive(pid)) {
          actuator.restoreProcess(pid, scheduler.allCores);
        }
      }
    }

    // Restore governors
    //
    // BUG FIX (v2.1.2): Previously this only ran if
    // CONFIG.ENABLE_GOVERNOR_SWITCH was true. But if the user hot-reloaded
    // the flag from true to false AFTER governors were already modified,
    // the shutdown would skip restoration — leaving cores permanently
    // stuck at the boost governor. Now we restore if governorMgr exists
    // AND has captured originals, regardless of the current config flag.
    if (governorMgr && governorMgr.getOriginalGovernors().size > 0) {
      governorMgr.restoreAll(CONFIG);
    }

    // v0.4.0 Phase 2: Tear down Network QoS ruleset (HTB qdisc + nftables).
    // No-op when ENABLE_NETWORK_QOS is false. Must happen BEFORE cgroup
    // restoration so the nftables cgroup-path rules don't reference
    // stale cgroup paths.
    if (actuator) {
      actuator.networkStop();
    }

    // Kill focus watcher
    if (State.focusWatcherProcess) {
      try { State.focusWatcherProcess.kill(); } catch (_) { /* already dead */ }
    }

    // Clear timers
    clearAllTimers();

    // Stop IPC server (so CLI clients get a clean disconnect)
    if (ipcServer) {
      try { ipcServer.stop(); } catch (_) { /* noop */ }
      ipcServer = null;
    }

    // Close file watcher
    closeFileWatcher();

    // Destroy plugins
    if (pluginMgr) {
      pluginMgr.destroyAll();
    }

    // Stop policy engine — synchronously destroy to ensure audit log
    // is flushed before process exit. destroy() calls
    // policyLogger.close() which calls stream.end() (synchronous
    // close, fire-and-forget). For graceful shutdown we accept the
    // small risk of losing the very last audit entry.
    if (policyEngine) {
      try { policyEngine.destroy(); } catch (_) { /* noop */ }
      policyEngine = null;
      policySources = null;
    }

    // v0.5.0 Phase 1: destroy detector layer
    if (detectorMgr) {
      try { detectorMgr.destroy(); } catch (_) { /* noop */ }
      detectorMgr = null;
    }

    // v0.5.0 Phase 2: destroy resource controller layer
    if (resourceControllerMgr) {
      try { resourceControllerMgr.destroy(); } catch (_) { /* noop */ }
      resourceControllerMgr = null;
    }

    // v0.5.0 Phase 3: destroy profile manager
    if (profileMgr) {
      try { profileMgr.destroy(); } catch (_) { /* noop */ }
      profileMgr = null;
    }

    // v0.5.0 Phase 4: destroy adaptive engine
    if (adaptiveEngine) {
      try { adaptiveEngine.destroy(); } catch (_) { /* noop */ }
      adaptiveEngine = null;
    }

    // v0.5.0 Phase 5: destroy recognition engine
    if (recognitionEngine) {
      try { recognitionEngine.destroy(); } catch (_) { /* noop */ }
      recognitionEngine = null;
    }

    // v0.5.0 Phase 6: stop health checker
    if (healthChecker) {
      try { healthChecker.stop(); } catch (_) { /* noop */ }
      healthChecker = null;
    }

    // v0.5.0 Phase 7: destroy plugin SDK
    if (pluginSdkManager) {
      try { pluginSdkManager.destroy(); } catch (_) { /* noop */ }
      pluginSdkManager = null;
    }

    // Clear rollback state (clean shutdown)
    if (rollbackMgr) {
      rollbackMgr.clear();
    }
  } catch (err) {
    fatal(`Error during cleanup: ${err.message}`);
  }

  info('Cleanup selesai, keluar.');

  // BUG FIX (v2.1.2): Previously closeFileLogging() was called BEFORE
  // the final "Cleanup selesai" log line and without a callback, so
  // process.exit() could fire before the stream flushed — losing the
  // last log message. Now we log first, then close with a callback
  // that exits only after the stream is fully flushed.
  closeFileLogging(() => {
    process.exit(exitCode);
  });

  // Safety net: if closeFileLogging's callback never fires (e.g. the
  // stream is stuck), force exit after 2 seconds.
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

// ── Signal Handlers ───────────────────────────────────────────────────

function setupSignalHandlers() {
  process.on('SIGINT', () => cleanupAndExit('SIGINT'));
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

  process.on('uncaughtException', (err) => {
    fatal('Uncaught exception:', err && err.stack ? err.stack : err);
    cleanupAndExit('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    fatal('Unhandled rejection:', reason);
    cleanupAndExit('unhandledRejection', 1);
  });
}

// ── Public API ────────────────────────────────────────────────────────

function start() {
  setupSignalHandlers();
  bootstrap();
}

function getState() {
  return {
    stressLevel: scheduler?.stressLevel,
    foregroundPid: State.currentForegroundPid,
    eventDrivenFocus: State.eventDrivenFocusActive,
    cgroupsReady: actuator?.cgroupsReady,
    adaptiveScore: scheduler?.adaptiveScore,
    throttledCount: scheduler?.autoRestore.size,
    mediaProtectedCount: State.currentMediaPids.size,
    metrics: metrics?.snapshot() || null,
    plugins: pluginMgr?.registeredPlugins || [],
    selfCheck: State.selfCheckReport,
    policyEngine: policyEngine ? policyEngine.getStatus() : null,
    detectorLayer: detectorMgr ? detectorMgr.getStatus() : null,
    resourceControllerLayer: resourceControllerMgr ? resourceControllerMgr.getStatus() : null,
    profileManager: profileMgr ? profileMgr.getStatus() : null,
    adaptiveEngine: adaptiveEngine ? adaptiveEngine.getStatus() : null,
    recognitionEngine: recognitionEngine ? recognitionEngine.getStatus() : null,
    monitoring: {
      systemMonitor: systemMonitor ? systemMonitor.getStatus() : null,
      diagnostics: diagnosticsEngine ? diagnosticsEngine.getStatus() : null,
      health: healthChecker ? healthChecker.getStatus() : null,
      benchmark: benchmarkFramework ? benchmarkFramework.getStatus() : null,
      metrics: metricsCollector ? metricsCollector.getStatus() : null,
    },
    pluginSdk: pluginSdkManager ? pluginSdkManager.getStatus() : null,
  };
}

function getMetricsReport() {
  return metrics ? metrics.formatReport() : 'Metrics disabled';
}

module.exports = {
  start,
  getState,
  getMetricsReport,
  cleanupAndExit,
  CONFIG: () => CONFIG,
};