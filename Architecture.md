# Architecture

## Module Dependency Graph

```
                        dynalloc-daemon.js (entry point)
                               |
                            daemon.js  (orchestrator)
                               |
        +----------+-----------+-----------+----------+----------+----------+
        |          |           |           |          |          |          |
    config.js  sensor.js  scheduler.js  actuator.js  logger.js  cpu-topology.js
        |          |           |                        |
        |          +---- multimedia.js                   |
        |                      |                         |
        |                      +--- (pw-cli, pw-top, pactl, pgrep)
        |
    +---+---+------------------+------------------+-------+
    |       |                  |                  |       |
governor.js  classifier.js  plugin-manager.js  metrics.js  rollback.js
                                 |
                          +------+------+------+------+
                          |      |      |      |      |
                       plugins/spotify   plugins/game   plugins/discord
                       plugins/browser  plugins/obs     plugins/steam
                       plugins/multimedia plugins/wallpaper plugins/system
                                        |
                              policy-engine/
                          +--------+---------+---------+---------+
                          |        |         |         |         |
                       event-bus.js rule-engine.js matcher.js action-executor.js
                          |        |         |                   |
                       state-store.js policy-loader.js policy-logger.js event-sources.js
                                        |
                              intelligence/  (v2.0)
                   +----------+-----------+-----------+-----------+
                   |          |           |           |           |
            learning-engine  recommendation  explainability  timeline    doctor-engine
                   |          |             engine      engine    report-generator
                   |          |
                   +----+(feeds from daemon.js tick loop)
```

## v2.0: Intelligence Subsystem Data Flow

```
  daemon.js fastTick / slowTick
       |
       v
  ┌──────────────────────────────────────────────────┐
  │  1. Learn: recordForeground() to LearningEngine   │
  │  2. Explain: _executeBoost() → ExplainabilityEngine │
  │  3. Timeline: events recorded to TimelineEngine     │
  └──────────────┬───────────────────────────────────┘
                 │
                 v (periodic, every 60s)
  ┌──────────────────────────────────────────────────┐
  │  RecommendationEngine.generate()                   │
  │  → queries LearningEngine patterns               │
  │  → creates suggestion objects                     │
  │  → NEVER applies automatically                    │
  └──────────────────────────────────────────────────┘
                 │
                 v (periodic, every 5min)
  ┌──────────────────────────────────────────────────┐
  │  LearningEngine.persist()                        │
  │  → saves to ~/.config/dynalloc/learning/          │
  │     learning-state.json                           │
  └──────────────────────────────────────────────────┘
                 │
                 v (on IPC request)
  ┌──────────────────────────────────────────────────┐
  │  dynalloc doctor → DoctorEngine.run()              │
  │  → 18 health checks                              │
  │  → PASS / WARNING / ERROR + health score          │
  └──────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────┐
  │  dynalloc report → ReportGenerator.generate()       │
  │  → standalone HTML with all subsystem data        │
  │  → timeline, explanations, recommendations,         │
  │    health check, configuration, metrics            │
  └──────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────┐
  │  dynalloc timeline → TimelineEngine.query()        │
  │  → filter by category, severity, time, search    │
  │  → pagination support                             │
  └──────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────┐
  │  dynalloc explanations → ExplainabilityEngine.getRecent() │
  │  → filter by type, source, limit                 │
  │  → structured factors with ✓/✗ indicators       │
  └──────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────┐
  │  dynalloc recommendations                         │
  │  → list pending, approve by ID, dismiss by ID    │
  │  → cooldown prevents re-suggestion spam          │
  └──────────────────────────────────────────────────┘
```

## Data Flow

```
  PSI files (/proc/pressure/cpu, /proc/pressure/memory)
       |
       v
  sensor.js :: readCpuPSI() / readMemPSI()
       |
       v
  ┌──────────────────────────────────────────┐
  │            daemon.js :: fastTick()        │  ← every FAST_TICK_MS (default 1000ms)
  │                                           │
  │  1. Read CPU PSI, Mem PSI                │
  │  2. Read battery / thermal status        │
  │  3. sensor.js :: CpuHistory.push()       │
  │  4. scheduler.js :: tick(psi, context)   │
  │     → computes adaptive score            │
  │     → evaluates hysteresis               │
  │     → generates RESTORE actions          │
  │  5. Execute RESTORE actions via actuator │
  │  6. Update idle backoff counter          │
  │  7. On CRITICAL: force slowTick()        │
  └──────────────────────────────────────────┘
       |
       v
  ┌──────────────────────────────────────────┐
  │            daemon.js :: slowTick()        │  ← every SLOW_TICK_MS (default 3000ms)
  │                                           │
  │  1. Detect foreground PID                 │
  │     → sensor.js :: getForegroundPID()     │
  │       (xdotool / gdbus / hyprctl)        │
  │  2. Handle foreground change              │
  │     → restore previous foreground         │
  │     → boost new foreground                │
  │  3. If stress != NORMAL:                  │
  │     a. listProcesses()                    │
  │     b. Detect multimedia PIDs             │
  │     c. Run plugin detection               │
  │     d. scheduler.classifyProcesses()      │
  │     e. Execute THROTTLE actions           │
  └──────────────────────────────────────────┘
       |
       v
  actuator.js
    ├── cgroups v2:  write cgroup.procs, cpu.weight, cpu.max
    └── fallback:    taskset (affinity), renice (niceness), ionice (I/O priority)
       |
       v
  ┌─────────┐   ┌──────────────┐   ┌───────────────────┐
  │  Kernel  │   │  CPU Freq    │   │  OOM Killer       │
  │ Cgroups  │   │  Governor    │   │  (oom_score_adj)  │
  └─────────┘   └──────────────┘   └───────────────────┘
```

## Module Descriptions

### `dynalloc-daemon.js` — Entry Point

The CLI entry point. Parses no arguments itself — simply requires and starts the daemon module. All configuration is via config file or environment variables.

### `daemon.js` — Orchestrator

The central module that ties everything together. Responsibilities:

- **Bootstrap sequence**: loads config, runs self-check, crash recovery, topology detection, creates subsystems, sets up timers, hot-reload watcher, and event-driven focus.
- **fastTick()**: PSI reading, adaptive scoring, hysteresis evaluation, auto-restore actions, idle backoff.
- **slowTick()**: foreground detection, process listing, multimedia detection, plugin execution, process classification and throttling.
- **handleForegroundChange()**: restores previous foreground, boosts new foreground (pinning, niceness, I/O priority, OOM, governor, cgroup).
- **Signal handlers**: SIGINT/SIGTERM trigger graceful cleanup (restore all processes, governors, kill watchers, clear timers).
- **Shutdown cleanup**: restores all throttled processes, all governors, destroys plugins, clears rollback state.

### `scheduler.js` — Multi-Level Scheduler

Implements the core scheduling logic with three sub-components:

- **`HysteresisState`**: prevents rapid state transitions by enforcing minimum dwell times.
- **`AutoRestoreTracker`**: tracks all PIDs that were throttled so they can be restored when stress ends.
- **`Scheduler` class**: manages stress levels, classifies processes, generates foreground boosts, computes adaptive scores, and builds core layouts from topology.

See [Scheduler.md](Scheduler.md) for full details.

### `sensor.js` — System Telemetry

Reads all system inputs:

- **PSI**: `readPSI()` parses `/proc/pressure/cpu` and `/proc/pressure/memory` (avg10, avg60, avg300, total).
- **CpuHistory**: circular buffer with moving-average computation for smoothed PSI readings.
- **Foreground detection**: three strategies with fallback chain:
  - Hyprland: `hyprctl activewindow -j`
  - GNOME/Wayland: `gdbus call` to the "Window Calls Extended" extension
  - X11 fallback: `xdotool getactivewindow getwindowpid`
- **Process listing**: `ps -eo pid,ppid,pcpu,comm --no-headers`
- **GameMode query**: D-Bus call to `com.feralinteractive.GameMode`
- **D-Bus focus monitor**: `gdbus monitor --session --dest org.gnome.Shell` for event-driven focus changes.
- **Battery/thermal**: reads `/sys/class/power_supply/` and `/sys/class/thermal/` for adaptive scoring.
- **Path validation**: `validateSysPath()` blocks path traversal (no `..` or null bytes, only `/proc/` and `/sys/`).

### `actuator.js` — System Control

Executes all low-level resource modifications:

- **cgroups v2**: creates `dynalloc.slice/foreground.slice` and `dynalloc.slice/background.slice`, sets `cpu.weight` and `cpu.max`, assigns PIDs via `cgroup.procs`.
- **Fallback mode**: `taskset` (CPU affinity), `renice` (niceness), `ionice` (I/O priority).
- **OOM protection**: writes to `/proc/<pid>/oom_score_adj`.
- **Governor switching**: delegates to `governor.js`.
- **Notifications**: `notify-send` for desktop notifications.
- **Dry-run enforcement**: at the class level — all methods check `this.isDryRun` before executing.
- **Modification tracking**: every system change is logged in `_modificationLog` for potential rollback.

### `classifier.js` — Process Classifier

Maps process names to categories using regex patterns with a priority-ordered matching system. Categories: GAME, BROWSER, IDE, COMPILER, AUDIO, VIDEO, STREAMING, WALLPAPER, CONTAINER, VM, STEAM, LUTRIS, WINE, PROTON, FLATPAK, SNAP, SYSTEM, DAEMON, ELECTRON, UNKNOWN.

Each category maps to a scheduler class (REALTIME, INTERACTIVE, MULTIMEDIA, BACKGROUND, IDLE). Includes a TTL-based cache (30s, max 4096 entries) with eviction.

Special detection:
- Flatpak processes: checks `/proc/<pid>/cgroup` for "flatpak"
- Snap processes: checks `/proc/<pid>/cgroup` for "snap"
- Electron child processes: matches parent comm against known Electron apps (VS Code, Discord, Slack, etc.)

### `config.js` — Configuration

Loads, validates, and merges configuration. Features:

- **Config resolution**: `DYNALLOC_CONFIG_PATH` → `~/.config/dynalloc/config.json` → `/etc/dynalloc/config.json`.
- **Schema validation**: type checking (number, boolean, string, enum, path, regexArray, ioPrio, cpuMax) with min/max/integer constraints.
- **Cross-field validation**: ensures `PSI_CPU_WARN < PSI_CPU_CRITICAL` and `PSI_MEM_WARN < PSI_MEM_CRITICAL`.
- **Environment overrides**: `DYNALLOC_DRY_RUN=1` and `DYNALLOC_LOG_LEVEL` take highest priority.
- **Hot-reloadable fields list**: defines which config keys can be changed without restart.

See [Configuration.md](Configuration.md) for all keys and validation rules.

### `governor.js` — CPU Frequency Governor

Manages CPU governor switching via `cpupower frequency-set`:

- Captures original governors per core on startup.
- Sets boost governor (e.g., "performance") on foreground cores when stress is detected.
- Supports `GOVERNOR_USE_SUDO` for non-root user services.
- Restores all governors on shutdown.

### `logger.js` — Structured Logger

Production-grade logger with:

- 6 levels: TRACE < DEBUG < INFO < WARN < ERROR < FATAL.
- ISO 8601 timestamps, PID, scheduler state context in every line.
- File output with rotation (configurable max size and file count).
- Log hook for external consumers.
- Scheduler state provider integration (daemon sets a callback).

### `multimedia.js` — Multimedia Detector

Three-layer detection to identify actively playing media:

1. **Name-based**: matches process comm against a known set (mpv, vlc, spotify, discord, pipewire, etc.)
2. **PipeWire**: `pw-cli list-objects` — parses `process.pid` + `media.class` + `state = "running"`. Falls back to `pw-top -b -n 1`.
3. **PulseAudio**: `pactl list sink-inputs` — parses `State: RUNNING` blocks for PID or binary name.

Results are cached for 5 seconds to avoid redundant external process calls.

### `cpu-topology.js` — CPU Topology Detection

Reads sysfs to build a complete CPU layout:

- **SMT/HT**: detects by counting unique `core_id` values per logical CPU.
- **NUMA**: enumerates `/sys/devices/system/node/nodeN/cpulist`.
- **Intel Hybrid (P-Core/E-Core)**:
  - Method 1: `cpu_capacity` sysfs entries (different capacities = hybrid).
  - Method 2: CPU model name regex (12th+ Gen Intel, Core Ultra, Alder Lake, etc.) with core_id heuristics.
- **AMD CCD**: reads L3 cache `id` and `level` from `/sys/devices/system/cpu/cpuN/cache/index3/`.
- Results are cached after first detection.

### `metrics.js` — Metrics Registry

Internal observability system with three metric types:

- **Counter**: monotonically increasing integer (boost_count, throttle_count, etc.)
- **Gauge**: point-in-time value (stress_level, cpu_pressure, adaptive_score, etc.)
- **Histogram**: latency tracking with min/max/avg/percentiles (scheduler_tick_latency_ms, process_scan_latency_ms, etc.)

Singleton registry initialized with ~25 predefined metrics. Supports `snapshot()` for programmatic access and `formatReport()` for human-readable output. Daemon resource metrics (RSS, CPU%) updated every 10s.

### `plugin-manager.js` — Plugin Architecture

Manages the plugin lifecycle:

- **Registration**: validates plugin interface (must have `name` and `detect()`).
- **Discovery**: scans `plugins/` directory for `.js` files, requires and registers them.
- **Custom plugins**: loads from `PLUGIN_DIR` if configured.
- **Execution**: `runDetection(procs, context)` calls each plugin's `detect()` and aggregates results into a `Map<pid, { actions, reasons, plugins }>`.
- **Lifecycle**: `initAll(config)` on startup, `destroyAll()` on shutdown.

See [Plugin.md](Plugin.md) for the full plugin interface.

### `self-check.js` — Pre-flight Validation

Runs on startup (when `ENABLE_SELF_CHECK` is true) to detect system capabilities:

- PSI availability (`/proc/pressure/cpu`, `/proc/pressure/memory`)
- Cgroups v2 (`/sys/fs/cgroup/cgroup.controllers`)
- systemd, cpufreq, governor, Intel pstate, AMD pstate
- PipeWire, WirePlumber, Feral GameMode
- Desktop environment (Hyprland, GNOME/Wayland, X11)
- Permissions (can renice, ionice, write cgroups, write governor)
- Kernel version check (warns if < 5.2)

Results drive automatic fallbacks: if PSI is unavailable, thresholds are set to 999 (effectively disabling throttling).

### `rollback.js` — Safe Rollback

Crash recovery mechanism:

- Persists daemon state (modified PIDs, governor originals, timestamp) to a JSON file (default: `/tmp/dynalloc-state.json`).
- On startup, checks for a stale state file from a different PID — if found, restores all tracked processes (renice, ionice, taskset, cgroup, oom_score_adj) and governors.
- State file is cleared on clean shutdown.
- Uses atomic write (write to `.tmp` then `rename`) to prevent corruption.

## Timer Architecture

The daemon uses two independent interval timers:

```
  fastTick  ──►  PSI read + scheduler.tick() + auto-restore
  (1000ms)       (cheap — single file read + in-memory computation)

  slowTick  ──►  foreground detection + process scan + classification + throttle
  (3000ms)       (expensive — external process calls, full process list)
```

### Idle Backoff

When the scheduler reports `NORMAL` stress for more than 10 consecutive fast ticks, the fast tick interval automatically increases from `FAST_TICK_MS` (1000ms) to `FAST_TICK_IDLE_MS` (2500ms) to save resources during idle periods. It reverts immediately when any non-NORMAL stress is detected.

### Forced Slow Tick on CRITICAL

When `fastTick()` detects a `CRITICAL` stress level, it immediately triggers an extra `slowTick()` for faster response, bypassing the normal slow tick cadence.

## Event-Driven Focus Detection via D-Bus

On GNOME/Wayland, the daemon can subscribe to focus change signals instead of polling:

1. Spawns `gdbus monitor --session --dest org.gnome.Shell`.
2. Filters stdout for lines containing "WindowsExt" and focus-related keywords.
3. On match, calls `_gnomeFocusPid()` to get the new foreground PID.
4. Calls `handleForegroundChange()` immediately — no need to wait for slowTick.

If the `gdbus monitor` process exits unexpectedly, the daemon falls back to polling on the next slowTick. A 5-second startup timeout kills the monitor if it produces no output (indicating D-Bus subscription failure).

## Hot-Reload Mechanism

When `HOT_RELOAD` is enabled, the daemon watches the config file with `fs.watch()`:

1. On file change event, a 300ms debounce timer fires.
2. The file is re-read and validated against the schema.
3. Only fields in `HOT_RELOADABLE_FIELDS` are updated (see [Configuration.md](Configuration.md)).
4. Regex caches are rebuilt, log level is updated, scheduler and actuator configs are refreshed.
5. If tick intervals changed, timers are restarted.
6. If cgroup limits changed, they are re-applied.

Fields that are **not** hot-reloadable (require daemon restart): `FOREGROUND_CORE_RESERVE`, `ENABLE_CGROUPS_V2`, `CGROUP_ROOT`, `CGROUP_PARENT_SLICE`, `CGROUP_MODE`, `DRY_RUN`, `HOT_RELOAD`, `LOG_FILE_PATH`, `ENABLE_PLUGINS`, `PLUGIN_DIR`, `ENABLE_SELF_CHECK`, `ENABLE_SAFE_ROLLBACK`, `ROLLBACK_STATE_FILE`.
---

## Policy Engine (v2.2, optional)

The Policy Engine is a new optional subsystem that runs alongside the
existing scheduler/actuator/governor. It is gated behind the
`ENABLE_POLICY_ENGINE` config flag (default `false`).

When disabled, no policy-engine code is loaded — zero behavior change.

When enabled, it:

1. Loads a separate `policies.json` (or `policies.yaml`) file with
   declarative rules and profiles.
2. Subscribes to an internal EventBus that the daemon emits events
   to (battery, thermal, pressure, foreground, processes, plugins).
3. Evaluates rules against each event using a matcher supporting
   AND/OR/NOT and 11 comparison operators.
4. Executes actions via the existing `Actuator`, `GovernorManager`,
   and `Scheduler` APIs — no direct state mutation.
5. Records an audit entry for every execution (success or failure).
6. Self-heals: action failures trigger snapshot rollback, errors are
   logged, and the engine never crashes the daemon.

The daemon's integration points are minimal and guarded by null
checks:

- `daemon.js :: fastTick()` calls `policySources.updateBattery()`,
  `updateThermal()`, `updatePressure()` if `policySources` is set.
- `daemon.js :: slowTick()` calls `policySources.updateProcesses()`.
- `daemon.js :: handleForegroundChange()` calls
  `policySources.updateForeground()`.
- `daemon.js :: bootstrap()` constructs the `PolicyEngine` after all
  subsystems are created.
- `daemon.js :: cleanupAndExit()` calls `policyEngine.stop()`.
- `daemon.js :: setupHotReload()` propagates config changes to
  `policyEngine.executor.setConfig()`.

See [PolicyEngine.md](PolicyEngine.md) for the complete design,
rule schema, action reference, and plugin integration guide.

### Policy Engine Module Map

| Module | Role |
|---|---|
| `policy-engine/event-bus.js` | Synchronous pub/sub with wildcard, priority, re-entrancy safety |
| `policy-engine/state-store.js` | Dot-path key/value cache of current sensor readings |
| `policy-engine/event-sources.js` | Translates daemon sensor reads → bus events (with hysteresis) |
| `policy-engine/matcher.js` | Condition evaluator: AND/OR/NOT + 11 operators |
| `policy-engine/rule-engine.js` | Rule normalization, priority sort, cooldown/once/delay |
| `policy-engine/action-executor.js` | Translates action objects → actuator/governor/scheduler calls |
| `policy-engine/policy-logger.js` | Audit trail: ring buffer + rotating JSON-lines file |
| `policy-engine/policy-loader.js` | JSON/YAML parser, validator, hot-reload watcher |
| `policy-engine/policy-engine.js` | Main orchestrator — wires everything together |
| `policy-engine/index.js` | Public API surface |

---

## Detector Layer (v0.5.0 Phase 1, optional)

The Detector Layer is a new optional subsystem that provides a
modular detection framework running alongside the existing
classifier / plugins / multimedia stack. It is gated behind the
`ENABLE_DETECTOR_LAYER` config flag (default `false`).

When disabled, no detector code is loaded — zero behavior change.

When enabled, it:

1. Constructs a `DetectorManager` that owns a set of detector
   instances.
2. Builds a `DetectionContext` snapshot from daemon state on every
   fastTick (cheap fields: foreground PID, pressure, battery, thermal)
   and slowTick (rich fields: process list, foreground comm/cmdline).
3. Runs each detector's `detect(context)` synchronously, collecting
   `Detection[]` results.
4. Emits bus events when detector state transitions are observed
   (`onWorkloadDetected`, `onPowerStateChanged`, `onIdleStateChanged`).
5. Updates the shared `StateStore` so other consumers (PE rules,
   plugins, future IPC) can read the current detection state.

The detector layer is **purely observational** — it never modifies
system state. Action execution remains the responsibility of the
Policy Engine (or future consumers).

### Detector Layer Module Map

| Module | Role |
|---|---|
| `detectors/base-detector.js` | Abstract base class (lifecycle, isAvailable, detect, getStatus) |
| `detectors/detection-context.js` | Immutable snapshot of system state passed to detect() |
| `detectors/detector-manager.js` | Orchestrator: register, lifecycle, tick aggregation, bus emit |
| `detectors/workload-detector.js` | Foreground workload classification (GAME/IDE/BROWSER/...) |
| `detectors/power-state-detector.js` | Battery/AC/charging/discharging state transitions |
| `detectors/idle-state-detector.js` | User idle detection (heuristic: foreground + CPU + network) |
| `detectors/index.js` | Public API surface + `createBuiltinDetectors()` factory |

### Detector Interface Contract

```js
class MyDetector extends BaseDetector {
  constructor(deps) { super('my-detector', deps); }
  setup() { /* one-time init, subscribe to bus */ }
  start() { /* begin periodic work (most detectors no-op) */ }
  stop() { /* graceful shutdown */ }
  isAvailable() { /* capability probe */ return true; }
  detect(context) {
    // Returns Detection[] (may be empty)
    return [{
      detector: 'my-detector',
      domain: 'my-domain',
      classification: 'MY_CLASS',
      confidence: 0.95,
      payload: { /* ... */ },
      timestamp: new Date().toISOString(),
    }];
  }
  getStatus() { /* for IPC `detectors` command */ }
  setConfig(config) { /* hot-reload */ }
}
```

### Event Bus Integration

When the Policy Engine is enabled, the `DetectorManager` shares the
PE's bus — detector events are visible to PE rules. When PE is
disabled, the `DetectorManager` creates an isolated bus (via
`new EventBus()`) so detector events don't pollute any global state.

### Extension Points

- **Custom detectors**: subclass `BaseDetector`, register via
  `detectorMgr.register(myDetector)`.
- **Custom events**: detectors can emit any event name on the bus
  via `this.bus.emit('onMyEvent', payload)`.
- **State sharing**: detectors can read/write `this.stateStore` for
  cross-detector communication.

---

## Resource Controller Layer (v0.5.0 Phase 2, optional)

The Resource Controller Layer is a unified execution layer that sits
between the Policy Engine and the operating system. It aggregates
all resource controllers (CPU, Memory, IO, Network, Governor,
Thermal, Power) into a single `ResourceControllerManager` entry
point.

### Layered Architecture

```
  User Events
       ↓
  Detector Layer (Phase 1)
       ↓
  Policy Engine
       ↓
  ResourceControllerManager  ←── unified entry point (Phase 2)
       ↓
  ┌────┴────┬────────┬────────┬──────────┬─────────┬─────────┐
  ↓         ↓        ↓        ↓          ↓         ↓         ↓
CPU      Memory    IO    Network    Governor  Thermal    Power
  ↓         ↓        ↓        ↓          ↓         ↓         ↓
                  Operating System (sysfs, cgroups, tc, nft, cpupower, gdbus)
```

The Policy Engine MUST NOT manipulate system resources directly.
All resource modifications pass through the ResourceControllerManager,
which routes them to the appropriate controller.

When `ENABLE_RESOURCE_CONTROLLER_LAYER=false` (default), the manager
is not constructed — the PE continues to call the Actuator/Governor
directly (backward compat). When true, the manager is constructed
and the PE's new action types (`setThermalProfile`, `setPowerProfile`,
`setPpdProfile`) route through it.

### Resource Controller Layer Module Map

| Module | Role |
|---|---|
| `lib/resource-controller.js` | Abstract base class (lifecycle, isAvailable, getStatus, setConfig, destroy) |
| `lib/resource-controller-manager.js` | Aggregates all controllers; unified PE entry point |
| `lib/controllers/cpu-controller.js` | taskset + renice (existing, from v0.3.0) |
| `lib/controllers/memory-controller.js` | oom_score_adj (existing) |
| `lib/controllers/io-controller.js` | ionice (existing) |
| `lib/controllers/network-controller.js` | tc HTB + nftables (existing, v0.4.0) |
| `lib/controllers/governor-controller.js` | Adapter around governor.js (existing) |
| `lib/controllers/thermal-controller.js` | Thermal profile presets + pause/resume (NEW) |
| `lib/controllers/power-controller.js` | Power profile presets + PPD coordination (NEW) |

### Controller Interface Contract

All controllers extend `ResourceController` and implement:

```js
class MyController extends ResourceController {
  constructor(deps) { super('my-domain', deps); }
  setup() { /* one-time init */ }
  start() { /* begin periodic work (most no-op) */ }
  stop() { /* graceful shutdown */ }
  destroy() { /* permanent teardown */ }
  isAvailable() { /* capability probe */ return true; }
  getStatus() { /* for IPC `resources` command */ }
  setConfig(config) { /* hot-reload */ }
  // Domain-specific methods (applyProfile, setGovernor, etc.)
}
```

### New Policy Engine Action Types

When the Resource Controller Layer is enabled, the Policy Engine
gains three new action types:

| Action | Shape | Routes to |
|---|---|---|
| `setThermalProfile` | `{ "type": "setThermalProfile", "profile": "cool" }` | `ThermalController.applyProfile()` |
| `setPowerProfile` | `{ "type": "setPowerProfile", "profile": "power-saver" }` | `PowerController.applyProfile()` |
| `setPpdProfile` | `{ "type": "setPpdProfile", "profile": "performance" }` | `PowerController.setPpdProfile()` |

Valid thermal profiles: `balanced`, `cool`, `silent`
Valid power profiles: `balanced`, `power-saver`, `performance`
Valid PPD profiles: `power-saver`, `balanced`, `performance`

### Plugin Extensibility

Third-party code can add new resource controllers:

```js
const mgr = daemon.getState().resourceControllerLayer;
class MyController extends ResourceController { ... }
mgr.registerController(new MyController(deps));
```

### IPC Access

The `resources` IPC handler returns the Resource Controller Layer
status:

```bash
dynalloc resources              # human-readable status
dynalloc resources --json       # JSON output
```

---

## Profile Manager Layer (v0.5.0 Phase 3, optional)

The Profile Manager is the decision layer between the Detector Layer
and the Resource Controller Layer. It subscribes to detector events
on the bus, evaluates which profile should be active based on a
deterministic priority system, and instructs the
ResourceControllerManager to apply the winning profile's resource
settings.

### Layered Architecture (complete)

```
  User Events
       ↓
  Detector Layer (Phase 1)        ← observes system state, emits events
       ↓
  Event Bus
       ↓
  Profile Manager (Phase 3)       ← decides which profile wins
       ↓
  Resource Controller (Phase 2)   ← applies resource settings
       ↓
  Operating System
```

The Profile Manager is **event-driven** (no polling). It subscribes
to `onWorkloadDetected`, `onPowerStateChanged`, and
`onIdleStateChanged` events. Profile changes occur only when relevant
events are received.

When `ENABLE_PROFILE_MANAGER=false` (default), the manager is not
constructed — the PE's existing `applyProfile` action continues to
work independently.

### Profile Manager Module Map

| Module | Role |
|---|---|
| `profiles/base-profile.js` | Abstract `Profile` class (validation, lifecycle, versioning) |
| `profiles/profile-registry.js` | Load/validate/inherit profiles from JSON/YAML/code |
| `profiles/profile-manager.js` | Orchestrator: subscribe to events, conflict resolution, activation |
| `profiles/builtin-profiles.js` | 9 built-in profile definitions |
| `profiles/index.js` | Public API surface |

### Built-in Profiles (9)

| Profile | Priority | Inherits | Description |
|---|---|---|---|
| `balanced` | 100 | — | Factory defaults |
| `performance` | 200 | — | High foreground CPU weight, governor on |
| `powersave` | 150 | — | Conservative CPU weights, governor off |
| `gaming` | 500 | `performance` | + cool thermal override |
| `development` | 300 | `balanced` | IDE/compiler workloads |
| `rendering` | 400 | `performance` | OBS/Blender/ffmpeg |
| `streaming` | 250 | `balanced` | Media playback |
| `battery-saver` | 450 | `powersave` | + silent thermal override |
| `idle` | 50 | — | Minimal resource usage after idle timeout |

### Conflict Resolution (deterministic)

When multiple profiles are simultaneously demanded (e.g. gaming +
battery-saver), the manager picks the one with the highest
`priority`. Ties are broken by registration order (first registered
wins).

**Examples:**
- `gaming` (500) > `development` (300) → gaming wins
- `rendering` (400) > `balanced` (100) → rendering wins
- `battery-saver` (450) > `performance` (200) → battery-saver wins
- `idle` (50) < any active profile → idle only wins when demand set is empty

### Demand Set

The manager maintains a `demand` map: `source → { profileId, priority, timestamp }`.
Each detector can demand one profile at a time. When a detector
withdraws its demand (e.g. idle ends), the entry is removed. The
active profile is always the highest-priority entry in the demand
set, or `balanced` (the default) if the set is empty.

### Idle Timeout

When the IdleStateDetector emits `onIdle`, the manager waits
`PROFILE_IDLE_TIMEOUT_MS` (default 300000 = 5 min) before activating
the `idle` profile. This prevents flicker on brief idle moments.
When `onIdleEnd` is received, the timeout is cancelled.

### Profile Configuration Format

Profiles can be loaded from a JSON or YAML file (`PROFILE_FILE_PATH`):

```json
{
  "profiles": [
    {
      "id": "my-custom-profile",
      "version": "1.0.0",
      "description": "Custom profile",
      "priority": 350,
      "inherits": ["balanced"],
      "settings": {
        "thermal": { "profile": "cool" },
        "power": { "profile": "performance" }
      },
      "metadata": { "author": "me" }
    }
  ]
}
```

### IPC Access

```bash
dynalloc profiles                # human-readable status
dynalloc profiles --json         # JSON output
```

See [ProfileManager.md](ProfileManager.md) for the complete profile
architecture, lifecycle, configuration format, priority rules,
inheritance, conflict resolution, and examples.

---

## Adaptive Switching Engine (v0.5.0 Phase 4, optional)

The Adaptive Switching Engine wraps the Profile Manager with
production-grade stability guarantees: debouncing, cooldowns,
oscillation detection, rollback on failure, and user overrides.

### Layered Architecture (complete with Phase 4)

```
  User Events / Detector Layer / PE / Plugins
       ↓
  Event Bus
       ↓
  Adaptive Engine (Phase 4)        ← debounce, cooldown, rollback, override
       ↓
  Profile Manager (Phase 3)        ← demand set + conflict resolution
       ↓
  Resource Controller (Phase 2)    ← applies settings
       ↓
  Operating System
```

When `ENABLE_ADAPTIVE_SWITCHING=false` (default), the Profile Manager
receives events directly (Phase 3 behavior). When true, the
AdaptiveEngine intercepts events first and applies stability rules
before delegating to the ProfileManager.

### Adaptive Switching Module Map

| Module | Role |
|---|---|
| `adaptive/transition-manager.js` | Debounce, cooldown, oscillation detection, history, rollback coordination |
| `adaptive/adaptive-engine.js` | Event-driven switching engine + user override + rollback |
| `adaptive/index.js` | Public API surface |

### Transition Lifecycle

```
   Bus Event
       ↓
   AdaptiveEngine._handleEvent()
       ↓
   _predictProfileForEvent()        ← what profile would this activate?
       ↓
   TransitionManager.evaluateTransition()
       ├─ same-profile? → suppress (no-op)
       ├─ rollback? → allow (bypass cooldown)
       ├─ user-override? → allow (bypass cooldown)
       ├─ cooldown active? → suppress
       └─ oscillation detected? → suppress
       ↓ (allowed)
   TransitionManager.debounceTransition()
       ↓ (after debounce delay)
   _executeTransition()
       ├─ _forwardToPM() → PM updates demand set + activates profile
       ├─ success? → record + emit onProfileTransitionSucceeded
       └─ failure? → _rollback() + emit onProfileTransitionFailed
       ↓
   TransitionManager.recordTransition()
       ├─ add to history (ring buffer)
       ├─ update cooldown timestamp
       └─ update oscillation window
```

### Stability Guarantees

| Guarantee | Mechanism |
|---|---|
| No oscillation | Oscillation detector: N transitions in window → suppress |
| No rapid flicker | Cooldown: minimum dwell time per profile |
| No event storms | Debounce: coalesce rapid events into one transition |
| No duplicate processing | Same-profile transitions suppressed as no-op |
| No recursive transitions | AE is sole event handler (PM subscriptions stopped) |
| No infinite loops | Oscillation detection + bounded history |
| Safe rollback | Failed activation → restore previous profile |
| User override | demandUserOverride() bypasses cooldown, wins all conflicts |

### User Override

```bash
# Demand a user override (highest priority, bypasses cooldown)
dynalloc-ipc '{"cmd":"adaptive-override","args":{"action":"demand","profile":"performance"}}'

# Release the override
dynalloc-ipc '{"cmd":"adaptive-override","args":{"action":"release"}}'
```

### IPC Access

```bash
dynalloc adaptive                # human-readable status
dynalloc adaptive --json         # JSON output
```

See [AdaptiveSwitching.md](AdaptiveSwitching.md) for the complete
architecture, event flow diagrams, transition lifecycle, rollback
behavior, and examples.

---

## Workload Recognition Engine (v0.5.0 Phase 5, optional)

The Workload Recognition Engine identifies workload categories
(gaming, development, rendering, etc.) using deterministic rules and
heuristics, then maps them to optimization strategies and demands
the corresponding profile from the Profile Manager.

### Layered Architecture (complete with Phase 5)

```
  User Events
       ↓
  Detector Layer (Phase 1)           ← observes system state
       ↓
  Workload Recognition Engine (Phase 5)  ← NEW: confidence + multi-source
       ↓
  Profile Manager (Phase 3)          ← demand set + conflict resolution
       ↓
  Adaptive Switching Engine (Phase 4) ← debounce + cooldown + rollback
       ↓
  Resource Controller (Phase 2)      ← applies settings
       ↓
  Operating System
```

### Recognition Module Map

| Module | Role |
|---|---|
| `recognition/workload-recognizer.js` | Confidence scoring, multi-source detection, custom rules |
| `recognition/optimization-strategies.js` | 14 workload optimization templates |
| `recognition/recognition-engine.js` | Event-driven orchestrator + PM demand |
| `recognition/index.js` | Public API surface |

### 14 Workload Categories

| Category | Profile | Description |
|---|---|---|
| gaming | gaming | Low latency, high performance |
| development | development | Balanced, fast FS |
| web-browsing | balanced | Lightweight |
| office-productivity | balanced | Stable, low overhead |
| video-editing | rendering | Max sustained perf |
| audio-production | streaming | Low-latency audio |
| 3d-rendering | rendering | GPU-heavy, thermal-aware |
| streaming | streaming | Multimedia protection |
| virtual-machines | balanced | Memory-heavy |
| containers | balanced | IO-aware |
| ai-ml | performance | GPU-heavy compute |
| file-compression | balanced | CPU-burst |
| idle | idle | Minimal resources |
| background-tasks | balanced | Low priority |

### Confidence Model

Each detection includes a confidence score (0.0-1.0) computed from
multiple sources:

| Source | Weight |
|---|---|
| Process name match | 0.50 |
| CPU pattern match | 0.20 |
| GPU pattern match | 0.15 |
| Memory pattern match | 0.10 |
| I/O pattern match | 0.05 |

When confidence < `RECOGNITION_CONFIDENCE_THRESHOLD` (default 0.60),
the engine does NOT switch profiles — it maintains the current
profile until confidence improves.

### Plugin Extensibility

```js
engine.recognizer.registerRule({
  id: 'my-plugin-rule',
  workload: 'custom-workload',
  profile: 'my-profile',
  match: (ctx) => ctx.foregroundComm === 'my-app',
  confidence: (ctx) => 0.80,
});
```

### IPC Access

```bash
dynalloc recognition                # human-readable status
dynalloc recognition --json         # JSON output
```

See [WorkloadRecognition.md](WorkloadRecognition.md) for the complete
architecture, detection flow, categories, confidence model, strategy
mapping, and plugin extension guide.

---

## Monitoring Framework (v0.5.0 Phase 6, optional)

A unified observability layer providing real-time visibility into
daemon internals. All components are READ-ONLY — they observe, never
control.

### Monitoring Module Map

| Module | Role |
|---|---|
| `monitoring/system-monitor.js` | Unified system state snapshot (CPU/mem/thermal/battery/workload/profile/controllers) |
| `monitoring/diagnostics-engine.js` | Aggregates diagnostics from all subsystems |
| `monitoring/health-checker.js` | Periodic health verification (30s, unref'd) |
| `monitoring/benchmark-framework.js` | On-demand benchmarks (latency/memory/CPU) |
| `monitoring/metrics-collector.js` | Lightweight metrics wrapper around existing metrics.js |
| `monitoring/index.js` | Public API surface |

### IPC Handlers

| Handler | Description |
|---|---|
| `monitor` | System state snapshot |
| `diagnostics` | Full diagnostics report |
| `health` | Run health check (6 checks) |
| `benchmark` | On-demand benchmark (args: name, iterations) |

### Health Checks

| Check | What it verifies |
|---|---|
| event-bus | Bus is not destroyed |
| detectors | At least 1 detector running (when enabled) |
| profile-manager | Active profile is not null (when enabled) |
| resource-controller | At least 1 controller available (when enabled) |
| plugins | Plugins loaded without errors |
| metrics | Metrics registry responds to snapshot() |

---

## Plugin SDK (v0.5.0 Phase 7, optional)

A stable, versioned Public API that allows third-party developers to
extend Dynalloc without modifying core source code.

### SDK Module Map

| Module | Role |
|---|---|
| `sdk/plugin-permissions.js` | 13 permission constants + validation |
| `sdk/plugin-manifest.js` | Manifest specification + validation |
| `sdk/plugin-version.js` | API + daemon version compatibility checks |
| `sdk/plugin-context.js` | PluginContext (the Public API object passed to plugins) |
| `sdk/plugin-lifecycle-manager.js` | Full lifecycle: init→validate→load→register→activate→deactivate→unload→cleanup |
| `sdk/index.js` | Public API surface (API_VERSION = "1.0") |
| `sdk/plugin-template.js` | Example plugin template for developers |

### Plugin Lifecycle

```
   Initialize → Validate → Load → Register → Activate →
   Runtime → Deactivate → Unload → Cleanup
```

### Permission Model (13 permissions)

| Permission | Description |
|---|---|
| `read:config` | Read daemon configuration |
| `read:metrics` | Read metrics snapshots |
| `read:diagnostics` | Read diagnostics reports |
| `read:health` | Read health check results |
| `read:state` | Read daemon state |
| `write:profiles` | Register and demand profiles |
| `write:detectors` | Register detectors |
| `write:controllers` | Register resource controllers |
| `write:rules` | Register recognition rules |
| `write:events` | Publish events on the bus |
| `cli:register` | Register CLI commands |
| `log:write` | Write to daemon log |
| `system:full` | Full access (all permissions) |

### Error Isolation

- Every plugin call wrapped in try/catch
- Failing plugin disabled (context.disable())
- Daemon continues running
- Failed plugin reported to diagnostics

### IPC Handler

```bash
echo '{"cmd":"sdk","args":{}}' | dynalloc-ipc    # SDK status
```
