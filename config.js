'use strict';

/**
 * DynAlloc — Config Module
 *
 * Loads, validates, and hot-reloads configuration.
 * All original config keys are preserved for backward compatibility.
 * New keys for v2.0 features are added with safe defaults.
 *
 * v2.1: Added feature flags, path validation, comprehensive type checking.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TOTAL_CORES = os.cpus().length;

const DEFAULT_CONFIG = {
  // ── Tier polling (ms) ──────────────────────────────────────────────
  FAST_TICK_MS: 1000,
  SLOW_TICK_MS: 3000,
  FAST_TICK_IDLE_MS: 2500,

  // ── PSI thresholds (avg10, percent) ────────────────────────────────
  PSI_CPU_WARN: 8.0,
  PSI_CPU_CRITICAL: 20.0,
  PSI_MEM_WARN: 4.0,
  PSI_MEM_CRITICAL: 12.0,

  // ── Foreground core reservation ────────────────────────────────────
  FOREGROUND_CORE_RESERVE: null,

  // ── Heavy background patterns ──────────────────────────────────────
  HEAVY_BG_PATTERNS: [
    '^(cc1|cc1plus|ld|rustc|clang|gcc|g\\+\\+)$',
    'node$',
    '(chrome|chromium|firefox|brave)',
    '(java|gradle|webpack)',
  ],
  HEAVY_BG_CPU_THRESHOLD: 15.0,

  // ── Critical process patterns (never throttle) ─────────────────────
  CRITICAL_PROCESS_PATTERNS: [
    '^(systemd|dbus-daemon|dbus-broker)$',
    '^(Xorg|Xwayland)$',
    '^(gnome-shell|mutter)$',
    '^(kwin_x11|kwin_wayland|plasmashell)$',
    '^(pipewire|pipewire-pulse|wireplumber|pulseaudio)$',
    '^(NetworkManager|wpa_supplicant|systemd-network)$',
    '^(sddm|gdm|gdm3|lightdm)$',
  ],

  // ── Logging ────────────────────────────────────────────────────────
  LOG_LEVEL: 'info',
  LOG_FILE_PATH: null,
  LOG_FILE_MAX_SIZE_MB: 10,
  LOG_FILE_MAX_FILES: 3,
  DRY_RUN: false,

  // ── Hot reload ─────────────────────────────────────────────────────
  HOT_RELOAD: true,

  // ── Cgroups v2 ─────────────────────────────────────────────────────
  ENABLE_CGROUPS_V2: true,
  CGROUP_ROOT: '/sys/fs/cgroup',
  CGROUP_PARENT_SLICE: 'dynalloc.slice',
  CGROUP_MODE: 'auto',
  FOREGROUND_CPU_WEIGHT: 800,
  BACKGROUND_CPU_WEIGHT: 20,
  FOREGROUND_CPU_MAX: 'max',
  BACKGROUND_CPU_MAX: '40000 100000',

  // ── v2.1.6: Memory & IO cgroup limits ──────────────────────────────
  // Protect foreground from background OOM storms and IO saturation.
  // These are no-ops if the memory/io controllers are unavailable.
  ENABLE_MEMORY_LIMITS: true,
  ENABLE_IO_LIMITS: true,
  // memory.max — hard ceiling (bytes, or "max" for unlimited).
  // Foreground = "max" (let it use all available RAM).
  // Background = 2GB default — enough for typical browser+IDE, but caps
  // runaway background processes from starving foreground.
  FOREGROUND_MEMORY_MAX: 'max',
  BACKGROUND_MEMORY_MAX: '2147483648', // 2 GB
  // memory.high — soft limit (bytes). Kernel throttles cgroup when
  // exceeded. Set to 'max' or null to disable.
  BACKGROUND_MEMORY_HIGH: '1610612736', // 1.5 GB (75% of memory.max)
  // memory.oom.group — when 1, OOM killer kills ALL procs in cgroup
  // together. Foreground always 0 (isolate from background OOM).
  BACKGROUND_OOM_GROUP: true,
  // io.max — per-device IO bandwidth limit. Format:
  //   "<major>:<minor> rbps=<bytes> wbps=<bytes> riops=<iops> wiops=<iops>"
  // Example: "8:16 rbps=10485760 wbps=10485760" = 10MB/s on /dev/sdb
  // Multi-line for multiple devices. Empty/null = no io.max written.
  // Default: null (don't limit IO — most desktops don't need it,
  // and getting device numbers wrong can break things).
  BACKGROUND_IO_MAX: null,

  // ── CPU Governor ────────────────────────────────────────────────────
  ENABLE_GOVERNOR_SWITCH: true,
  GOVERNOR_BOOST: 'performance',
  GOVERNOR_USE_SUDO: false,

  // ── v2.1.7: Power Profiles Daemon (PPD) coordination ───────────────
  // power-profiles-daemon (PPD) is the default power management daemon
  // on Fedora, Ubuntu, GNOME, and KDE Plasma. It manages CPU governor
  // switching via its own DBus interface. If DynAlloc also switches
  // governors, the two daemons fight.
  //
  // When ENABLE_PPD_COORDINATION is true (default), the daemon detects
  // PPD at startup. If PPD is running, the daemon mutes its own
  // governor switching (sets ENABLE_GOVERNOR_SWITCH=false at runtime)
  // and logs a warning. All other DynAlloc features (cgroups, nice,
  // io priority, OOM, memory limits) continue to work.
  //
  // Set to false if you want DynAlloc to always control governors
  // (e.g. on a system without PPD, or if you've stopped PPD manually).
  ENABLE_PPD_COORDINATION: true,

  // ── OOM Protection ─────────────────────────────────────────────────
  ENABLE_OOM_PROTECTION: true,
  FOREGROUND_OOM_SCORE_ADJ: -500,

  // ── v2.1.10: Watchdog timer ────────────────────────────────────────
  // If fastTick hasn't run in WATCHDOG_TIMEOUT_MS, force restart timers.
  // Prevents daemon hang (e.g. stuck on a blocking I/O call).
  ENABLE_WATCHDOG: true,
  WATCHDOG_TIMEOUT_MS: 30000,        // 30 seconds
  WATCHDOG_CHECK_INTERVAL_MS: 10000, // check every 10s

  // ── v2.1.10: Configurable battery low threshold ────────────────────
  // Previously hardcoded at 20% in event-sources.js. Now configurable.
  BATTERY_LOW_THRESHOLD: 20,         // % — emit onBatteryLow when below this

  // ── v2.1.10: NUMA-aware pinning ────────────────────────────────────
  // On multi-NUMA systems, pin background processes to the NUMA node
  // with the most spare capacity. Reduces cross-node memory latency.
  ENABLE_NUMA_AWARE_PINNING: true,

  // ── v2.1.10: systemd unit name classification ──────────────────────
  // Read /proc/<pid>/cgroup to extract the systemd service name (e.g.
  // "firefox.service") and use it as an additional classification signal.
  // More reliable than comm name (which can be truncated or renamed).
  ENABLE_SYSTEMD_UNIT_CLASSIFICATION: true,

  // ── v2.1.10: Per-app profile overrides ─────────────────────────────
  // Load override files from PER_APP_PROFILES_DIR. Each JSON file defines
  // a custom scheduler class / nice / io for a specific process name.
  ENABLE_PER_APP_PROFILES: true,
  PER_APP_PROFILES_DIR: null,  // null = ~/.config/dynalloc/apps.d/

  // ── v2.1.10: GPU awareness ─────────────────────────────────────────
  // Detect GPU utilization (nvidia-smi / intel_gpu_top / radeontop).
  // When foreground process is GPU-bound (high GPU, low CPU), don't
  // throttle it even if CPU pressure is low.
  ENABLE_GPU_AWARENESS: true,
  GPU_BOUND_GPU_THRESHOLD: 80,   // % GPU util to be "GPU-bound"
  GPU_BOUND_CPU_THRESHOLD: 10,   // % CPU util below which GPU-bound kicks in

  // ── v2.1.10: Network awareness ─────────────────────────────────────
  // Detect network-heavy background processes (downloads, sync) and
  // throttle their CPU more aggressively (they're I/O-bound, not CPU-bound).
  ENABLE_NETWORK_AWARENESS: true,
  NETWORK_HEAVY_RX_KBPS: 1024,   // KB/s — processes above this are "downloading"

  // ── v2.1.10: Learning mode ─────────────────────────────────────────
  // Log manual boost/throttle actions to a file. After LEARNING_MIN_ENTRIES,
  // suggest rules the user can add to their policy file.
  ENABLE_LEARNING_MODE: false,   // off by default — opt-in
  LEARNING_LOG_FILE: null,       // null = ~/.config/dynalloc/learn.log
  LEARNING_MIN_ENTRIES: 50,      // minimum entries before suggesting rules

  // ── Notifications ──────────────────────────────────────────────────
  ENABLE_NOTIFICATIONS: true,

  // ── GameMode coexist ───────────────────────────────────────────────
  ENABLE_GAMEMODE_COEXIST: true,

  // ── Event-driven focus ─────────────────────────────────────────────
  ENABLE_EVENT_DRIVEN_FOCUS: true,

  // ══════════════════════════════════════════════════════════════════
  //  v2.0 NEW CONFIG KEYS — all have safe defaults
  // ══════════════════════════════════════════════════════════════════

  // ── CPU History (moving average) ───────────────────────────────────
  CPU_HISTORY_SIZE: 5,

  // ── Hysteresis (ms, minimum dwell time before state transition) ────
  HYSTERESIS_NORMAL_TO_WARN_MS: 3000,
  HYSTERESIS_WARN_TO_CRITICAL_MS: 3000,
  HYSTERESIS_CRITICAL_TO_NORMAL_MS: 5000,

  // ── Auto Restore ───────────────────────────────────────────────────
  AUTO_RESTORE: true,

  // ── Multimedia Protection ──────────────────────────────────────────
  ENABLE_MULTIMEDIA_PROTECTION: true,

  // ── CPU Topology ───────────────────────────────────────────────────
  ENABLE_CPU_TOPOLOGY: true,

  // ── Adaptive Scheduler ─────────────────────────────────────────────
  ENABLE_ADAPTIVE_SCHEDULER: true,
  ADAPTIVE_WEIGHT_CPU: 1.0,
  ADAPTIVE_WEIGHT_MEM: 0.8,
  ADAPTIVE_WEIGHT_FOREGROUND: 0.5,
  ADAPTIVE_WEIGHT_MEDIA: 1.2,
  ADAPTIVE_WEIGHT_BATTERY: 0.3,
  ADAPTIVE_WEIGHT_THERMAL: 0.4,
  BATTERY_CHECK_PATH: '/sys/class/power_supply/BAT0/',
  THERMAL_ZONE_INDEX: 0,

  // ── v2.1.8: Thermal-aware boosting ─────────────────────────────────
  // When CPU temperature exceeds THERMAL_PAUSE_THRESHOLD (°C), the daemon
  // pauses governor boosting for THERMAL_PAUSE_DURATION_MS. During the
  // pause, foreground processes still get cgroups/nice/io priority, but
  // the CPU governor is NOT switched to "performance" — this prevents
  // thermal throttle death spirals where boosting makes the CPU hotter,
  // the kernel throttles frequency, the daemon boosts harder, etc.
  //
  // The pause is a "cooldown" period: even if temp drops below threshold
  // immediately, we wait the full duration before resuming. This prevents
  // rapid on/off cycling (hysteresis).
  //
  // Set ENABLE_THERMAL_PROTECTION=false to disable entirely.
  ENABLE_THERMAL_PROTECTION: true,
  THERMAL_PAUSE_THRESHOLD: 85,        // °C — pause boost when CPU hits this
  THERMAL_PAUSE_DURATION_MS: 30000,   // 30 seconds cooldown
  THERMAL_RESUME_THRESHOLD: 75,       // °C — resume boost only when temp drops below this (hysteresis)

  // ── Scheduler class priorities (higher = more important) ───────────
  SCHEDULER_CLASS_REALTIME_PRIORITY: 100,
  SCHEDULER_CLASS_INTERACTIVE_PRIORITY: 80,
  SCHEDULER_CLASS_MULTIMEDIA_PRIORITY: 70,
  SCHEDULER_CLASS_BACKGROUND_PRIORITY: 30,
  SCHEDULER_CLASS_IDLE_PRIORITY: 10,

  // ── Scheduler class niceness ───────────────────────────────────────
  SCHEDULER_CLASS_REALTIME_NICE: -10,
  SCHEDULER_CLASS_INTERACTIVE_NICE: -5,
  SCHEDULER_CLASS_MULTIMEDIA_NICE: -3,
  SCHEDULER_CLASS_BACKGROUND_NICE: 10,
  SCHEDULER_CLASS_IDLE_NICE: 19,

  // ── Scheduler class I/O priority [class, level] ───────────────────
  SCHEDULER_CLASS_REALTIME_IOPRIO: [1, 0],
  SCHEDULER_CLASS_INTERACTIVE_IOPRIO: [1, 4],
  SCHEDULER_CLASS_MULTIMEDIA_IOPRIO: [1, 2],
  SCHEDULER_CLASS_BACKGROUND_IOPRIO: [3, 0],
  SCHEDULER_CLASS_IDLE_IOPRIO: [3, 7],

  // ══════════════════════════════════════════════════════════════════
  //  v2.1 FEATURE FLAGS
  // ══════════════════════════════════════════════════════════════════

  ENABLE_CPU_HISTORY: true,
  ENABLE_MULTIMEDIA_DETECTOR: true,
  ENABLE_HYSTERESIS: true,
  ENABLE_SMART_SCHEDULER: true,
  ENABLE_TOPOLOGY: true,
  ENABLE_EVENT_ENGINE: true,
  ENABLE_BENCHMARK: false,
  ENABLE_DEBUG: false,
  ENABLE_PLUGINS: true,
  ENABLE_METRICS: true,
  ENABLE_SELF_CHECK: true,
  ENABLE_SAFE_ROLLBACK: true,
  PLUGIN_DIR: null, // null = built-in plugins only

  // ── Rollback ───────────────────────────────────────────────────────
  ROLLBACK_STATE_FILE: null, // null = /tmp/dynalloc-state.json

  // ── IPC Server (for CLI tool) ──────────────────────────────────────
  ENABLE_IPC: true,
  IPC_SOCKET_PATH: null, // null = auto-detect ($XDG_RUNTIME_DIR/dynalloc.sock or /tmp/dynalloc-<uid>.sock)

  // ══════════════════════════════════════════════════════════════════
  //  v2.2 POLICY ENGINE
  //  The Policy Engine is an optional, event-driven rule system that
  //  runs alongside the existing scheduler. When disabled (default),
  //  no policy-engine code is loaded — zero behavior change.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_POLICY_ENGINE: false,
  POLICY_FILE_PATH: null,           // null = auto-detect ~/.config/dynalloc/policies.{json,yaml}
  POLICY_HOT_RELOAD: true,
  POLICY_LOG_FILE_PATH: null,       // null = audit log disabled (still in-memory ring buffer)
  POLICY_LOG_MAX_SIZE_MB: 5,
  POLICY_LOG_MAX_FILES: 3,
  POLICY_DEFAULT_COOLDOWN_MS: 1000,
  POLICY_MAX_RULES: 200,
  POLICY_EXECUTION_TIMEOUT_MS: 5000,

  // v2.1.10 medium-priority features
  ENABLE_WATCHDOG: true,
  WATCHDOG_TIMEOUT_MS: 30000,
  WATCHDOG_CHECK_INTERVAL_MS: 10000,
  BATTERY_LOW_THRESHOLD: 20,
  ENABLE_NUMA_AWARE_PINNING: true,
  ENABLE_SYSTEMD_UNIT_CLASSIFICATION: true,
  ENABLE_PER_APP_PROFILES: true,
  PER_APP_PROFILES_DIR: null,
  ENABLE_GPU_AWARENESS: true,
  GPU_BOUND_GPU_THRESHOLD: 80,
  GPU_BOUND_CPU_THRESHOLD: 10,
  ENABLE_NETWORK_AWARENESS: true,
  NETWORK_HEAVY_RX_KBPS: 1024,
  ENABLE_LEARNING_MODE: false,
  LEARNING_LOG_FILE: null,
  LEARNING_MIN_ENTRIES: 50,

  // ── v0.4.0 Phase 2: Network QoS Controller ──────────────────────────
  //
  // All keys default OFF / null to preserve backward compatibility.
  // Enabling ENABLE_NETWORK_QOS activates the NetworkController, which
  // installs an HTB qdisc + nftables cgroup marking on the managed
  // interface. Requires root (or DRY_RUN) and the `tc` binary (and
  // `nft` when NETWORK_QOS_USE_NFTABLES=true).
  ENABLE_NETWORK_QOS: false,
  NETWORK_QOS_INTERFACE: null,             // null = auto-detect default-route interface
  NETWORK_QOS_FOREGROUND_RATE: '1gbit',    // HTB rate syntax: <number><unit>
  NETWORK_QOS_BACKGROUND_RATE: '10mbit',   //   units: bit, kbit, mbit, gbit, tbit, bps, Kbps, Mbps, Gbps, Tbps
  NETWORK_QOS_FOREGROUND_CEIL: '1gbit',    // ceiling (max burst)
  NETWORK_QOS_BACKGROUND_CEIL: '50mbit',
  NETWORK_QOS_USE_NFTABLES: true,          // set false to skip cgroup marking (HTB only)

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 1: Detector Layer
  //  An optional, purely-observational detection framework that runs
  //  alongside the existing classifier/plugins/multimedia stack. When
  //  disabled (default), zero behavior change. When enabled, it
  //  constructs a DetectorManager that runs registered detectors on
  //  each fastTick and emits bus events (onWorkloadDetected,
  //  onPowerStateChanged, onIdleStateChanged, etc.).
  //
  //  The detector layer NEVER modifies system state — it only observes
  //  and emits. Action execution remains the responsibility of the
  //  Policy Engine (or future consumers).
  // ══════════════════════════════════════════════════════════════════
  ENABLE_DETECTOR_LAYER: false,            // master switch (default OFF)
  // Idle-state detector tuning (only effective when ENABLE_DETECTOR_LAYER=true)
  DETECTOR_IDLE_THRESHOLD_TICKS: 30,       // consecutive idle-signal ticks before IDLE
  DETECTOR_IDLE_CPU_PRESSURE_MAX: 2.0,     // PSI avg10 below this = "low CPU" for idle
  DETECTOR_IDLE_NET_RX_KBPS_MAX: 5,        // KB/s below this = "low network" for idle

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 2: Resource Controller Foundation
  //  A unified ResourceControllerManager that aggregates all resource
  //  controllers (CPU, Memory, IO, Network, Governor, Thermal, Power)
  //  into a single entry point for the Policy Engine.
  //
  //  When ENABLE_RESOURCE_CONTROLLER_LAYER is false (default), the
  //  manager is not constructed — the PE continues to call the
  //  Actuator/Governor directly (backward compat). When true, the
  //  manager is constructed and the PE's new action types
  //  (setThermalProfile, setPowerProfile) route through it.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_RESOURCE_CONTROLLER_LAYER: false,  // master switch (default OFF)
  THERMAL_PROFILE_DEFAULT: 'balanced',      // 'balanced' | 'cool' | 'silent'
  POWER_PROFILE_DEFAULT: 'balanced',        // 'balanced' | 'power-saver' | 'performance'

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 3: Profile Manager & Adaptive Policy Profiles
  //  A decision layer between the Detector Layer and the Resource
  //  Controller. Subscribes to detector events, evaluates which
  //  profile should be active based on a deterministic priority
  //  system, and instructs the RCM to apply the winning profile's
  //  resource settings.
  //
  //  When ENABLE_PROFILE_MANAGER is false (default), the manager is
  //  not constructed — the PE's existing applyProfile action continues
  //  to work independently. When true, the manager subscribes to
  //  onWorkloadDetected / onPowerStateChanged / onIdleStateChanged
  //  and automatically activates profiles.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_PROFILE_MANAGER: false,            // master switch (default OFF)
  PROFILE_FILE_PATH: null,                  // null = built-in profiles only
  PROFILE_IDLE_TIMEOUT_MS: 300000,          // 5 min idle before idle profile activates

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 4: Automatic Adaptive Profile Switching
  //  An Adaptive Switching Engine that wraps the Profile Manager with
  //  production-grade stability guarantees: debouncing, cooldowns,
  //  oscillation detection, rollback on failure, and user overrides.
  //
  //  When ENABLE_ADAPTIVE_SWITCHING is false (default), the Profile
  //  Manager receives events directly (Phase 3 behavior). When true,
  //  the AdaptiveEngine intercepts events first and applies stability
  //  rules before delegating to the ProfileManager.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_ADAPTIVE_SWITCHING: false,         // master switch (default OFF)
  ADAPTIVE_DEBOUNCE_MS: 200,                // coalesce rapid events into one transition
  ADAPTIVE_COOLDOWN_MS: 1000,               // minimum dwell time per profile
  ADAPTIVE_USER_OVERRIDE_PRIORITY: 1000,    // user override wins all conflicts (0-1000)
  ADAPTIVE_MAX_HISTORY: 100,                // transition history ring buffer size
  ADAPTIVE_OSCILLATION_WINDOW_MS: 10000,    // window for oscillation detection
  ADAPTIVE_OSCILLATION_THRESHOLD: 5,        // transitions in window before oscillation flag

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 5: Workload Recognition & Smart Optimization
  //  A Workload Recognition Engine that identifies workload categories
  //  (gaming, development, rendering, etc.) using deterministic rules
  //  and heuristics, then maps them to optimization strategies.
  //
  //  When ENABLE_WORKLOAD_RECOGNITION is false (default), the
  //  RecognitionEngine is not constructed. When true, it subscribes
  //  to detector events and demands profiles from the PM based on
  //  confidence-scored workload detection.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_WORKLOAD_RECOGNITION: false,       // master switch (default OFF)
  RECOGNITION_CONFIDENCE_THRESHOLD: 0.60,   // minimum confidence to switch profiles (0-1)
  RECOGNITION_DEBOUNCE_MS: 300,             // debounce for recognition events (0-5000)

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 6: Monitoring, Diagnostics & Benchmark Framework
  //  A unified observability layer providing real-time visibility into
  //  daemon internals. Includes system monitoring, diagnostics, health
  //  checks, benchmarks, and a metrics collector.
  //
  //  All components are READ-ONLY — they observe, never control.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_MONITORING_FRAMEWORK: false,        // master switch (default OFF)
  MONITORING_HEALTH_CHECK_INTERVAL_MS: 30000, // health check interval (5s-5min)
  MONITORING_BENCHMARK_ENABLED: true,         // allow on-demand benchmarks

  // ══════════════════════════════════════════════════════════════════
  //  v0.5.0 Phase 7: Public Plugin SDK, Stable API & Extension Ecosystem
  //  A stable Plugin SDK that allows third-party developers to extend
  //  Dynalloc without modifying core source code. Includes manifest
  //  validation, permission enforcement, version compatibility, and
  //  error isolation.
  // ══════════════════════════════════════════════════════════════════
  ENABLE_PLUGIN_SDK: false,                  // master switch (default OFF)
  PLUGIN_SDK_API_VERSION: '1.0',             // SDK API version (X.Y)
  PLUGIN_SDK_STRICT_PERMISSIONS: false,      // reject plugins with unknown permissions
  PLUGIN_SDK_DIR: null,                      // null = no SDK plugins loaded
};

// ── Type & Range Schema for validation ────────────────────────────────

const CONFIG_SCHEMA = {
  // Numbers
  FAST_TICK_MS:              { type: 'number', min: 100, max: 60000 },
  SLOW_TICK_MS:              { type: 'number', min: 500, max: 60000 },
  FAST_TICK_IDLE_MS:         { type: 'number', min: 500, max: 60000 },
  PSI_CPU_WARN:              { type: 'number', min: 0, max: 100 },
  PSI_CPU_CRITICAL:          { type: 'number', min: 0, max: 100 },
  PSI_MEM_WARN:              { type: 'number', min: 0, max: 100 },
  PSI_MEM_CRITICAL:          { type: 'number', min: 0, max: 100 },
  HEAVY_BG_CPU_THRESHOLD:    { type: 'number', min: 0, max: 100 },
  FOREGROUND_CPU_WEIGHT:     { type: 'number', min: 1, max: 10000, integer: true },
  BACKGROUND_CPU_WEIGHT:     { type: 'number', min: 1, max: 10000, integer: true },
  FOREGROUND_OOM_SCORE_ADJ:  { type: 'number', min: -1000, max: 1000, integer: true },
  CPU_HISTORY_SIZE:          { type: 'number', min: 1, max: 60, integer: true },
  HYSTERESIS_NORMAL_TO_WARN_MS:    { type: 'number', min: 0, max: 60000 },
  HYSTERESIS_WARN_TO_CRITICAL_MS:  { type: 'number', min: 0, max: 60000 },
  HYSTERESIS_CRITICAL_TO_NORMAL_MS: { type: 'number', min: 0, max: 60000 },
  ADAPTIVE_WEIGHT_CPU:       { type: 'number', min: 0, max: 10 },
  ADAPTIVE_WEIGHT_MEM:       { type: 'number', min: 0, max: 10 },
  ADAPTIVE_WEIGHT_FOREGROUND: { type: 'number', min: 0, max: 10 },
  ADAPTIVE_WEIGHT_MEDIA:     { type: 'number', min: 0, max: 10 },
  ADAPTIVE_WEIGHT_BATTERY:   { type: 'number', min: 0, max: 10 },
  ADAPTIVE_WEIGHT_THERMAL:   { type: 'number', min: 0, max: 10 },
  THERMAL_ZONE_INDEX:        { type: 'number', min: 0, max: 100, integer: true },
  ENABLE_THERMAL_PROTECTION: { type: 'boolean' },
  THERMAL_PAUSE_THRESHOLD:   { type: 'number', min: 40, max: 110 },
  THERMAL_PAUSE_DURATION_MS: { type: 'number', min: 1000, max: 600000 },
  THERMAL_RESUME_THRESHOLD:  { type: 'number', min: 30, max: 105 },
  SCHEDULER_CLASS_REALTIME_PRIORITY:    { type: 'number', min: 0, max: 1000, integer: true },
  SCHEDULER_CLASS_INTERACTIVE_PRIORITY:  { type: 'number', min: 0, max: 1000, integer: true },
  SCHEDULER_CLASS_MULTIMEDIA_PRIORITY:   { type: 'number', min: 0, max: 1000, integer: true },
  SCHEDULER_CLASS_BACKGROUND_PRIORITY:   { type: 'number', min: 0, max: 1000, integer: true },
  SCHEDULER_CLASS_IDLE_PRIORITY:         { type: 'number', min: 0, max: 1000, integer: true },
  SCHEDULER_CLASS_REALTIME_NICE:    { type: 'number', min: -20, max: 19, integer: true },
  SCHEDULER_CLASS_INTERACTIVE_NICE:  { type: 'number', min: -20, max: 19, integer: true },
  SCHEDULER_CLASS_MULTIMEDIA_NICE:   { type: 'number', min: -20, max: 19, integer: true },
  SCHEDULER_CLASS_BACKGROUND_NICE:   { type: 'number', min: -20, max: 19, integer: true },
  SCHEDULER_CLASS_IDLE_NICE:         { type: 'number', min: -20, max: 19, integer: true },
  LOG_FILE_MAX_SIZE_MB:       { type: 'number', min: 1, max: 1024, integer: true },
  LOG_FILE_MAX_FILES:         { type: 'number', min: 1, max: 100, integer: true },
  WATCHDOG_TIMEOUT_MS:        { type: 'number', min: 5000, max: 300000 },
  WATCHDOG_CHECK_INTERVAL_MS: { type: 'number', min: 1000, max: 120000 },
  BATTERY_LOW_THRESHOLD:      { type: 'number', min: 1, max: 50 },
  GPU_BOUND_GPU_THRESHOLD:    { type: 'number', min: 0, max: 100 },
  GPU_BOUND_CPU_THRESHOLD:    { type: 'number', min: 0, max: 100 },
  NETWORK_HEAVY_RX_KBPS:      { type: 'number', min: 0, max: 1048576 },
  LEARNING_MIN_ENTRIES:       { type: 'number', min: 1, max: 10000, integer: true },

  // v0.4.0 Phase 2: Network QoS Controller
  ENABLE_NETWORK_QOS:         { type: 'boolean' },
  NETWORK_QOS_INTERFACE:      { type: 'string', nullable: true },  // validated again as iface name at runtime
  NETWORK_QOS_FOREGROUND_RATE: { type: 'string' },  // validated against RATE_RE at runtime
  NETWORK_QOS_BACKGROUND_RATE: { type: 'string' },
  NETWORK_QOS_FOREGROUND_CEIL: { type: 'string' },
  NETWORK_QOS_BACKGROUND_CEIL: { type: 'string' },
  NETWORK_QOS_USE_NFTABLES:   { type: 'boolean' },

  // v0.5.0 Phase 1: Detector Layer
  ENABLE_DETECTOR_LAYER:           { type: 'boolean' },
  DETECTOR_IDLE_THRESHOLD_TICKS:   { type: 'number', min: 1, max: 600, integer: true },
  DETECTOR_IDLE_CPU_PRESSURE_MAX:  { type: 'number', min: 0, max: 50 },
  DETECTOR_IDLE_NET_RX_KBPS_MAX:   { type: 'number', min: 0, max: 1048576 },

  // v0.5.0 Phase 2: Resource Controller Foundation
  ENABLE_RESOURCE_CONTROLLER_LAYER: { type: 'boolean' },
  THERMAL_PROFILE_DEFAULT:          { type: 'enum', values: ['balanced', 'cool', 'silent'] },
  POWER_PROFILE_DEFAULT:            { type: 'enum', values: ['balanced', 'power-saver', 'performance'] },

  // v0.5.0 Phase 3: Profile Manager
  ENABLE_PROFILE_MANAGER:           { type: 'boolean' },
  PROFILE_FILE_PATH:                { type: 'path', nullable: true },
  PROFILE_IDLE_TIMEOUT_MS:          { type: 'number', min: 0, max: 3600000 },

  // v0.5.0 Phase 4: Adaptive Switching
  ENABLE_ADAPTIVE_SWITCHING:        { type: 'boolean' },
  ADAPTIVE_DEBOUNCE_MS:             { type: 'number', min: 0, max: 5000 },
  ADAPTIVE_COOLDOWN_MS:             { type: 'number', min: 0, max: 60000 },
  ADAPTIVE_USER_OVERRIDE_PRIORITY:  { type: 'number', min: 0, max: 1000, integer: true },
  ADAPTIVE_MAX_HISTORY:             { type: 'number', min: 10, max: 1000, integer: true },
  ADAPTIVE_OSCILLATION_WINDOW_MS:   { type: 'number', min: 1000, max: 300000 },
  ADAPTIVE_OSCILLATION_THRESHOLD:   { type: 'number', min: 3, max: 20, integer: true },

  // v0.5.0 Phase 5: Workload Recognition
  ENABLE_WORKLOAD_RECOGNITION:      { type: 'boolean' },
  RECOGNITION_CONFIDENCE_THRESHOLD: { type: 'number', min: 0, max: 1 },
  RECOGNITION_DEBOUNCE_MS:          { type: 'number', min: 0, max: 5000 },

  // v0.5.0 Phase 6: Monitoring Framework
  ENABLE_MONITORING_FRAMEWORK:       { type: 'boolean' },
  MONITORING_HEALTH_CHECK_INTERVAL_MS: { type: 'number', min: 5000, max: 300000 },
  MONITORING_BENCHMARK_ENABLED:      { type: 'boolean' },

  // v0.5.0 Phase 7: Plugin SDK
  ENABLE_PLUGIN_SDK:                 { type: 'boolean' },
  PLUGIN_SDK_API_VERSION:            { type: 'string' },
  PLUGIN_SDK_STRICT_PERMISSIONS:     { type: 'boolean' },
  PLUGIN_SDK_DIR:                    { type: 'path', nullable: true },

  // Booleans
  DRY_RUN:                   { type: 'boolean' },
  HOT_RELOAD:                { type: 'boolean' },
  ENABLE_CGROUPS_V2:         { type: 'boolean' },
  ENABLE_MEMORY_LIMITS:      { type: 'boolean' },
  ENABLE_IO_LIMITS:          { type: 'boolean' },
  BACKGROUND_OOM_GROUP:      { type: 'boolean' },
  ENABLE_GOVERNOR_SWITCH:    { type: 'boolean' },
  GOVERNOR_USE_SUDO:         { type: 'boolean' },
  ENABLE_PPD_COORDINATION:   { type: 'boolean' },
  ENABLE_OOM_PROTECTION:     { type: 'boolean' },
  ENABLE_NOTIFICATIONS:      { type: 'boolean' },
  ENABLE_GAMEMODE_COEXIST:   { type: 'boolean' },
  ENABLE_EVENT_DRIVEN_FOCUS: { type: 'boolean' },
  ENABLE_WATCHDOG:           { type: 'boolean' },
  ENABLE_NUMA_AWARE_PINNING: { type: 'boolean' },
  ENABLE_SYSTEMD_UNIT_CLASSIFICATION: { type: 'boolean' },
  ENABLE_PER_APP_PROFILES:   { type: 'boolean' },
  ENABLE_GPU_AWARENESS:      { type: 'boolean' },
  ENABLE_NETWORK_AWARENESS:  { type: 'boolean' },
  ENABLE_LEARNING_MODE:      { type: 'boolean' },
  AUTO_RESTORE:              { type: 'boolean' },
  ENABLE_MULTIMEDIA_PROTECTION: { type: 'boolean' },
  ENABLE_CPU_TOPOLOGY:       { type: 'boolean' },
  ENABLE_ADAPTIVE_SCHEDULER: { type: 'boolean' },
  ENABLE_CPU_HISTORY:        { type: 'boolean' },
  ENABLE_MULTIMEDIA_DETECTOR: { type: 'boolean' },
  ENABLE_HYSTERESIS:         { type: 'boolean' },
  ENABLE_SMART_SCHEDULER:    { type: 'boolean' },
  ENABLE_TOPOLOGY:           { type: 'boolean' },
  ENABLE_EVENT_ENGINE:       { type: 'boolean' },
  ENABLE_BENCHMARK:          { type: 'boolean' },
  ENABLE_DEBUG:              { type: 'boolean' },
  ENABLE_PLUGINS:            { type: 'boolean' },
  ENABLE_METRICS:            { type: 'boolean' },
  ENABLE_SELF_CHECK:         { type: 'boolean' },
  ENABLE_SAFE_ROLLBACK:      { type: 'boolean' },
  ENABLE_IPC:                { type: 'boolean' },
  IPC_SOCKET_PATH:           { type: 'path', nullable: true },

  // Strings (enum)
  LOG_LEVEL:     { type: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] },
  CGROUP_MODE:   { type: 'enum', values: ['auto', 'own', 'root'] },
  GOVERNOR_BOOST: { type: 'enum', values: ['performance', 'powersave', 'ondemand', 'conservative', 'schedutil', 'userspace'] },

  // Strings (path) - validated separately for path traversal
  CGROUP_ROOT:        { type: 'path' },
  CGROUP_PARENT_SLICE: { type: 'string' },
  BATTERY_CHECK_PATH: { type: 'path' },
  LOG_FILE_PATH:      { type: 'path', nullable: true },
  PLUGIN_DIR:         { type: 'path', nullable: true },
  ROLLBACK_STATE_FILE: { type: 'path', nullable: true },
  PER_APP_PROFILES_DIR: { type: 'path', nullable: true },
  LEARNING_LOG_FILE:  { type: 'path', nullable: true },

  // Strings
  FOREGROUND_CPU_MAX:  { type: 'cpuMax' },
  BACKGROUND_CPU_MAX:  { type: 'cpuMax' },

  // v2.1.6: Memory & IO limit strings
  // cgroupLimit: "max" or a positive integer (bytes) as a string.
  // ioMaxString: multi-line device spec, nullable.
  FOREGROUND_MEMORY_MAX:    { type: 'cgroupLimit' },
  BACKGROUND_MEMORY_MAX:    { type: 'cgroupLimit' },
  BACKGROUND_MEMORY_HIGH:   { type: 'cgroupLimit', nullable: true },
  BACKGROUND_IO_MAX:        { type: 'string', nullable: true },

  // Arrays
  HEAVY_BG_PATTERNS:          { type: 'regexArray' },
  CRITICAL_PROCESS_PATTERNS:  { type: 'regexArray' },

  // Array of [number, number]
  SCHEDULER_CLASS_REALTIME_IOPRIO:    { type: 'ioPrio' },
  SCHEDULER_CLASS_INTERACTIVE_IOPRIO:  { type: 'ioPrio' },
  SCHEDULER_CLASS_MULTIMEDIA_IOPRIO:   { type: 'ioPrio' },
  SCHEDULER_CLASS_BACKGROUND_IOPRIO:   { type: 'ioPrio' },
  SCHEDULER_CLASS_IDLE_IOPRIO:         { type: 'ioPrio' },

  // Nullable integer
  //
  // BUG FIX (v2.1.1): On single-core machines TOTAL_CORES=1, so the
  // previous `max: TOTAL_CORES - 1` evaluated to `max: 0`, making the
  // range `min:1, max:0` impossible to satisfy. Any user-supplied value
  // was silently rejected and fell back to null. Use Math.max(1, ...)
  // so the range is always satisfiable (single-core machines will still
  // fall back to null via the `??` default in scheduler._setupCoreLayout,
  // which is the intended behavior — there's no spare core to reserve).
  FOREGROUND_CORE_RESERVE: { type: 'number', min: 1, max: Math.max(1, TOTAL_CORES - 1), integer: true, nullable: true },

  // ── v2.2 Policy Engine ─────────────────────────────────────────────
  ENABLE_POLICY_ENGINE:        { type: 'boolean' },
  POLICY_HOT_RELOAD:           { type: 'boolean' },
  POLICY_FILE_PATH:            { type: 'path', nullable: true },
  POLICY_LOG_FILE_PATH:        { type: 'path', nullable: true },
  POLICY_LOG_MAX_SIZE_MB:      { type: 'number', min: 1, max: 1024, integer: true },
  POLICY_LOG_MAX_FILES:        { type: 'number', min: 1, max: 100, integer: true },
  POLICY_DEFAULT_COOLDOWN_MS:  { type: 'number', min: 0, max: 86400000 },
  POLICY_MAX_RULES:            { type: 'number', min: 1, max: 10000, integer: true },
  POLICY_EXECUTION_TIMEOUT_MS: { type: 'number', min: 100, max: 60000 },
};

// Fields safe to hot-reload without restart
const HOT_RELOADABLE_FIELDS = [
  'FAST_TICK_MS', 'SLOW_TICK_MS', 'FAST_TICK_IDLE_MS',
  'PSI_CPU_WARN', 'PSI_CPU_CRITICAL', 'PSI_MEM_WARN', 'PSI_MEM_CRITICAL',
  'HEAVY_BG_PATTERNS', 'HEAVY_BG_CPU_THRESHOLD', 'CRITICAL_PROCESS_PATTERNS',
  'LOG_LEVEL', 'LOG_FILE_MAX_SIZE_MB', 'LOG_FILE_MAX_FILES',
  'FOREGROUND_CPU_WEIGHT', 'BACKGROUND_CPU_WEIGHT',
  'FOREGROUND_CPU_MAX', 'BACKGROUND_CPU_MAX',
  'ENABLE_MEMORY_LIMITS', 'ENABLE_IO_LIMITS',
  'FOREGROUND_MEMORY_MAX', 'BACKGROUND_MEMORY_MAX',
  'BACKGROUND_MEMORY_HIGH', 'BACKGROUND_OOM_GROUP',
  'BACKGROUND_IO_MAX',
  'ENABLE_GOVERNOR_SWITCH', 'GOVERNOR_BOOST', 'GOVERNOR_USE_SUDO',
  'ENABLE_PPD_COORDINATION',
  'ENABLE_OOM_PROTECTION', 'FOREGROUND_OOM_SCORE_ADJ',
  'ENABLE_NOTIFICATIONS', 'ENABLE_GAMEMODE_COEXIST', 'ENABLE_EVENT_DRIVEN_FOCUS',
  'ENABLE_WATCHDOG', 'WATCHDOG_TIMEOUT_MS', 'WATCHDOG_CHECK_INTERVAL_MS',
  'BATTERY_LOW_THRESHOLD',
  'ENABLE_NUMA_AWARE_PINNING',
  'ENABLE_SYSTEMD_UNIT_CLASSIFICATION',
  'ENABLE_PER_APP_PROFILES', 'PER_APP_PROFILES_DIR',
  'ENABLE_GPU_AWARENESS', 'GPU_BOUND_GPU_THRESHOLD', 'GPU_BOUND_CPU_THRESHOLD',
  'ENABLE_NETWORK_AWARENESS', 'NETWORK_HEAVY_RX_KBPS',
  'ENABLE_NETWORK_QOS', 'NETWORK_QOS_INTERFACE',
  'NETWORK_QOS_FOREGROUND_RATE', 'NETWORK_QOS_BACKGROUND_RATE',
  'NETWORK_QOS_FOREGROUND_CEIL', 'NETWORK_QOS_BACKGROUND_CEIL',
  'NETWORK_QOS_USE_NFTABLES',
  // v0.5.0 Phase 1: Detector Layer (note: ENABLE_DETECTOR_LAYER itself
  // is hot-reloadable — the daemon checks it on every tick. Detector
  // instances are created lazily on first tick after the flag flips
  // to true, and destroyed on first tick after it flips to false.)
  'ENABLE_DETECTOR_LAYER',
  'DETECTOR_IDLE_THRESHOLD_TICKS',
  'DETECTOR_IDLE_CPU_PRESSURE_MAX',
  'DETECTOR_IDLE_NET_RX_KBPS_MAX',
  // v0.5.0 Phase 2: Resource Controller Foundation
  'ENABLE_RESOURCE_CONTROLLER_LAYER',
  'THERMAL_PROFILE_DEFAULT',
  'POWER_PROFILE_DEFAULT',
  // v0.5.0 Phase 3: Profile Manager (note: ENABLE_PROFILE_MANAGER itself
  // is hot-reloadable — the daemon checks it on every tick. The manager
  // is constructed lazily on first tick after the flag flips to true.)
  'ENABLE_PROFILE_MANAGER',
  'PROFILE_FILE_PATH',
  'PROFILE_IDLE_TIMEOUT_MS',
  // v0.5.0 Phase 4: Adaptive Switching
  'ENABLE_ADAPTIVE_SWITCHING',
  'ADAPTIVE_DEBOUNCE_MS',
  'ADAPTIVE_COOLDOWN_MS',
  'ADAPTIVE_USER_OVERRIDE_PRIORITY',
  'ADAPTIVE_MAX_HISTORY',
  'ADAPTIVE_OSCILLATION_WINDOW_MS',
  'ADAPTIVE_OSCILLATION_THRESHOLD',
  // v0.5.0 Phase 5: Workload Recognition
  'ENABLE_WORKLOAD_RECOGNITION',
  'RECOGNITION_CONFIDENCE_THRESHOLD',
  'RECOGNITION_DEBOUNCE_MS',
  // v0.5.0 Phase 6: Monitoring Framework
  'ENABLE_MONITORING_FRAMEWORK',
  'MONITORING_HEALTH_CHECK_INTERVAL_MS',
  'MONITORING_BENCHMARK_ENABLED',
  // v0.5.0 Phase 7: Plugin SDK
  'ENABLE_PLUGIN_SDK',
  'PLUGIN_SDK_API_VERSION',
  'PLUGIN_SDK_STRICT_PERMISSIONS',
  'PLUGIN_SDK_DIR',
  'ENABLE_LEARNING_MODE', 'LEARNING_LOG_FILE', 'LEARNING_MIN_ENTRIES',
  'CPU_HISTORY_SIZE',
  'HYSTERESIS_NORMAL_TO_WARN_MS', 'HYSTERESIS_WARN_TO_CRITICAL_MS',
  'HYSTERESIS_CRITICAL_TO_NORMAL_MS',
  'AUTO_RESTORE', 'ENABLE_MULTIMEDIA_PROTECTION',
  'ENABLE_ADAPTIVE_SCHEDULER',
  'ADAPTIVE_WEIGHT_CPU', 'ADAPTIVE_WEIGHT_MEM',
  'ADAPTIVE_WEIGHT_FOREGROUND', 'ADAPTIVE_WEIGHT_MEDIA',
  'ADAPTIVE_WEIGHT_BATTERY', 'ADAPTIVE_WEIGHT_THERMAL',
  'ENABLE_THERMAL_PROTECTION', 'THERMAL_PAUSE_THRESHOLD',
  'THERMAL_PAUSE_DURATION_MS', 'THERMAL_RESUME_THRESHOLD',
  'SCHEDULER_CLASS_REALTIME_PRIORITY', 'SCHEDULER_CLASS_INTERACTIVE_PRIORITY',
  'SCHEDULER_CLASS_MULTIMEDIA_PRIORITY', 'SCHEDULER_CLASS_BACKGROUND_PRIORITY',
  'SCHEDULER_CLASS_IDLE_PRIORITY',
  'SCHEDULER_CLASS_REALTIME_NICE', 'SCHEDULER_CLASS_INTERACTIVE_NICE',
  'SCHEDULER_CLASS_MULTIMEDIA_NICE', 'SCHEDULER_CLASS_BACKGROUND_NICE',
  'SCHEDULER_CLASS_IDLE_NICE',
  // v2.1 feature flags
  'ENABLE_CPU_HISTORY', 'ENABLE_MULTIMEDIA_DETECTOR', 'ENABLE_HYSTERESIS',
  'ENABLE_SMART_SCHEDULER', 'ENABLE_TOPOLOGY', 'ENABLE_EVENT_ENGINE',
  'ENABLE_BENCHMARK', 'ENABLE_DEBUG', 'ENABLE_PLUGINS', 'ENABLE_METRICS',
  'ENABLE_IPC',
  // v2.2 policy engine (note: ENABLE_POLICY_ENGINE itself is NOT hot-reloadable
  // — it requires a daemon restart because it controls module loading)
  'POLICY_HOT_RELOAD', 'POLICY_LOG_FILE_PATH', 'POLICY_LOG_MAX_SIZE_MB',
  'POLICY_LOG_MAX_FILES', 'POLICY_DEFAULT_COOLDOWN_MS', 'POLICY_MAX_RULES',
  'POLICY_EXECUTION_TIMEOUT_MS',
];

const KNOWN_GOVERNORS = [
  'performance', 'powersave', 'ondemand',
  'conservative', 'schedutil', 'userspace',
];

const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// ── Path Validation ───────────────────────────────────────────────────

/**
 * Validate that a path does not contain path traversal.
 * Returns the path if valid, or null if suspicious.
 */
function validatePath(p, nullable = false) {
  if (p === null || p === undefined) {
    return nullable ? null : undefined;
  }
  const s = String(p);
  // Block null bytes
  if (s.includes('\0')) return undefined;
  // Block obvious traversal
  if (s.includes('..')) return undefined;
  return s;
}

// ── Config Path Resolution ────────────────────────────────────────────

function resolveConfigPath() {
  const candidates = [
    process.env.DYNALLOC_CONFIG_PATH,
    path.join(os.homedir() || '', '.config', 'dynalloc', 'config.json'),
    '/etc/dynalloc/config.json',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      const validated = validatePath(p);
      if (validated && fs.existsSync(validated)) return validated;
    } catch (_) { /* skip */ }
  }
  return null;
}

function readJsonFile(filePath) {
  const validated = validatePath(filePath);
  if (!validated) return null;

  try {
    const raw = fs.readFileSync(validated, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function validateRegexList(list, fallback, fieldName) {
  if (!Array.isArray(list)) return fallback;
  const valid = [];
  for (const src of list) {
    if (typeof src !== 'string') continue;
    try {
      new RegExp(src, 'i');
      valid.push(src);
    } catch (_) {
      // Silently drop invalid patterns
    }
  }
  return valid.length > 0 ? valid : fallback;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Validate a single config value against its schema.
 * Returns the validated value or the default.
 */
function validateField(key, value, schema, defaultVal) {
  if (value === undefined || value === null) {
    if (schema && schema.nullable) return value;
    return defaultVal;
  }

  if (!schema) return value; // no schema = accept as-is

  // Type check
  if (schema.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) return defaultVal;
    if (schema.integer && !Number.isInteger(value)) return defaultVal;
    if (schema.min !== undefined && value < schema.min) return defaultVal;
    if (schema.max !== undefined && value > schema.max) return defaultVal;
    return value;
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return defaultVal;
    return value;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return defaultVal;
    if (value.length === 0) return defaultVal;
    return value;
  }

  if (schema.type === 'enum') {
    if (!schema.values.includes(value)) return defaultVal;
    return value;
  }

  if (schema.type === 'path') {
    const validated = validatePath(value, schema.nullable);
    return validated !== undefined ? validated : defaultVal;
  }

  if (schema.type === 'cpuMax') {
    const s = String(value).trim();
    if (s === 'max') return s;
    if (/^\d+\s+\d+$/.test(s)) return s;
    return defaultVal;
  }

  // v2.1.6: cgroup memory limit — "max" or positive integer (bytes)
  if (schema.type === 'cgroupLimit') {
    if (value === null || value === undefined) {
      return schema.nullable ? value : defaultVal;
    }
    const s = String(value).trim();
    if (s === 'max' || s === '') return s === '' ? defaultVal : s;
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n) && n > 0) return s;
    }
    return defaultVal;
  }

  if (schema.type === 'regexArray') {
    return validateRegexList(value, defaultVal, key);
  }

  if (schema.type === 'ioPrio') {
    if (!Array.isArray(value) || value.length !== 2) return defaultVal;
    if (typeof value[0] !== 'number' || typeof value[1] !== 'number') return defaultVal;
    if (value[0] < 1 || value[0] > 3) return defaultVal;
    if (value[1] < 0 || value[1] > 7) return defaultVal;
    return [value[0], value[1]];
  }

  return value;
}

/**
 * Validate and merge user config over defaults using schema.
 * Unknown fields are silently dropped. Invalid values fall back to defaults.
 *
 * @param {object} base - default config
 * @param {object} override - user-provided config
 * @param {boolean} [logWarnings] - whether to log validation warnings
 * @returns {{ config: object, warnings: string[] }}
 */
function validateAndMerge(base, override, logWarnings = false) {
  if (!override || typeof override !== 'object') return { config: { ...base }, warnings: [] };

  const merged = { ...base };
  const warnings = [];

  for (const key of Object.keys(override)) {
    if (!(key in DEFAULT_CONFIG)) continue;

    const schema = CONFIG_SCHEMA[key];
    const value = override[key];
    const validated = validateField(key, value, schema, DEFAULT_CONFIG[key]);

    if (!deepEqual(validated, value) && logWarnings) {
      warnings.push(`Config "${key}": value ${JSON.stringify(value)} is invalid, using default ${JSON.stringify(validated)}`);
    }

    merged[key] = validated;
  }

  // Cross-field: WARN must be lower than CRITICAL
  if (merged.PSI_CPU_WARN >= merged.PSI_CPU_CRITICAL) {
    if (logWarnings) warnings.push('PSI_CPU_WARN >= PSI_CPU_CRITICAL, reverting to defaults');
    merged.PSI_CPU_WARN = DEFAULT_CONFIG.PSI_CPU_WARN;
    merged.PSI_CPU_CRITICAL = DEFAULT_CONFIG.PSI_CPU_CRITICAL;
  }
  if (merged.PSI_MEM_WARN >= merged.PSI_MEM_CRITICAL) {
    if (logWarnings) warnings.push('PSI_MEM_WARN >= PSI_MEM_CRITICAL, reverting to defaults');
    merged.PSI_MEM_WARN = DEFAULT_CONFIG.PSI_MEM_WARN;
    merged.PSI_MEM_CRITICAL = DEFAULT_CONFIG.PSI_MEM_CRITICAL;
  }

  return { config: merged, warnings };
}

function loadConfig() {
  const configPath = resolveConfigPath();
  let fileConfig = null;

  if (configPath) {
    fileConfig = readJsonFile(configPath);
  }

  const { config: merged, warnings } = validateAndMerge(DEFAULT_CONFIG, fileConfig, true);

  // Log validation warnings
  if (warnings.length > 0) {
    const logger = require('./logger');
    for (const w of warnings) {
      logger.warn(`Config validation: ${w}`);
    }
  }

  // ENV overrides take highest priority
  if (process.env.DYNALLOC_DRY_RUN === '1') merged.DRY_RUN = true;
  if (process.env.DYNALLOC_LOG_LEVEL) {
    const envLevel = process.env.DYNALLOC_LOG_LEVEL.toLowerCase();
    if (VALID_LOG_LEVELS.includes(envLevel)) {
      merged.LOG_LEVEL = envLevel;
    }
  }

  return { config: merged, configPath };
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA,
  HOT_RELOADABLE_FIELDS,
  KNOWN_GOVERNORS,
  VALID_LOG_LEVELS,
  TOTAL_CORES,
  resolveConfigPath,
  readJsonFile,
  validateAndMerge,
  validateRegexList,
  validateField,
  validatePath,
  loadConfig,
};