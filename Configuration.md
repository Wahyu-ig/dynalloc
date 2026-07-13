# Configuration

## Config File Locations (Priority Order)

1. **`$DYNALLOC_CONFIG_PATH`** — environment variable (highest priority for file selection)
2. **`~/.config/dynalloc/config.json`** — per-user configuration
3. **`/etc/dynalloc/config.json`** — system-wide configuration
4. **Built-in defaults** — used when no file is found (all features work with defaults)

Environment variables `DYNALLOC_DRY_RUN` and `DYNALLOC_LOG_LEVEL` override config file values at the highest priority.

## All Configuration Keys

### Tick Intervals

| Key | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `FAST_TICK_MS` | number | `1000` | 100 | 60000 | Interval (ms) for PSI reading and scheduler evaluation. Cheap operation. |
| `SLOW_TICK_MS` | number | `3000` | 500 | 60000 | Interval (ms) for foreground detection, process scan, and throttling. Expensive operation. |
| `FAST_TICK_IDLE_MS` | number | `2500` | 500 | 60000 | Interval (ms) used for fast tick when system has been idle (>10 consecutive NORMAL ticks). |

### PSI Thresholds

| Key | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `PSI_CPU_WARN` | number | `8.0` | 0 | 100 | CPU PSI avg10 percentage that triggers WARN stress level. |
| `PSI_CPU_CRITICAL` | number | `20.0` | 0 | 100 | CPU PSI avg10 percentage that triggers CRITICAL stress level. Must be > WARN. |
| `PSI_MEM_WARN` | number | `4.0` | 0 | 100 | Memory PSI avg10 percentage that triggers WARN. |
| `PSI_MEM_CRITICAL` | number | `12.0` | 0 | 100 | Memory PSI avg10 percentage that triggers CRITICAL. Must be > WARN. |

### Foreground Cores

| Key | Type | Default | Description |
|---|---|---|---|
| `FOREGROUND_CORE_RESERVE` | number \| null | `null` | Number of cores reserved for foreground. `null` = 50% of total cores. Ignored on Intel Hybrid CPUs (P-Cores are auto-assigned). **Requires restart.** |

### Heavy Background Detection

| Key | Type | Default | Description |
|---|---|---|---|
| `HEAVY_BG_PATTERNS` | string[] (regex) | `["^(cc1\|cc1plus\|ld\|rustc\|clang\|gcc\|g\\+\\+)$", "node$", "(chrome\|chromium\|firefox\|brave)", "(java\|gradle\|webpack)"]` | Regex patterns (case-insensitive) for process names always treated as heavy background. |
| `HEAVY_BG_CPU_THRESHOLD` | number | `15.0` | Any process with %CPU >= this value is treated as heavy background (0–100). |
| `CRITICAL_PROCESS_PATTERNS` | string[] (regex) | `["^(systemd\|dbus-daemon\|dbus-broker)$", ...]` | Regex patterns for processes that are **never** throttled, even if they match heavy background patterns or exceed CPU threshold. Protects the desktop session from self-inflicted lag. |

### Logging

| Key | Type | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | enum | `"info"` | One of: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_FILE_PATH` | path (nullable) | `null` | Path to log file. `null` = no file logging. **Requires restart.** |
| `LOG_FILE_MAX_SIZE_MB` | integer | `10` | Max log file size before rotation (1–1024 MB). |
| `LOG_FILE_MAX_FILES` | integer | `3` | Max number of rotated log files to keep (1–100). |

### Dry Run and Hot Reload

| Key | Type | Default | Description |
|---|---|---|---|
| `DRY_RUN` | boolean | `false` | When `true`, no system changes are executed. All actions are logged as `[DRY_RUN]`. Overridden by `DYNALLOC_DRY_RUN=1`. **Requires restart.** |
| `HOT_RELOAD` | boolean | `true` | Watch the config file for changes and apply hot-reloadable fields without restart. **Requires restart.** |

### Cgroups v2

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_CGROUPS_V2` | boolean | `true` | Use cgroups v2 (cpu.weight/cpu.max) instead of taskset+renice. Falls back automatically if unavailable. **Requires restart.** |
| `CGROUP_ROOT` | path | `"/sys/fs/cgroup"` | Base cgroup path. **Requires restart.** |
| `CGROUP_PARENT_SLICE` | string | `"dynalloc.slice"` | Name of the parent cgroup slice under which foreground/background slices are created. **Requires restart.** |
| `CGROUP_MODE` | enum | `"auto"` | Cgroup delegation mode: `auto` (try own cgroup, fallback to root), `own` (require own delegation), `root` (use CGROUP_ROOT directly, needs root). **Requires restart.** |
| `FOREGROUND_CPU_WEIGHT` | integer | `800` | cpu.weight for foreground cgroup (1–10000, system default is 100). |
| `BACKGROUND_CPU_WEIGHT` | integer | `20` | cpu.weight for background cgroup (1–10000). |
| `FOREGROUND_CPU_MAX` | cpuMax | `"max"` | cpu.max for foreground. `"max"` = unlimited, or `"quota period"` in microseconds (e.g. `"40000 100000"`). |
| `BACKGROUND_CPU_MAX` | cpuMax | `"40000 100000"` | cpu.max for background. `"40000 100000"` = 40% of CPU time. |

### CPU Governor

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_GOVERNOR_SWITCH` | boolean | `true` | Switch CPU governor on foreground cores when boosting. |
| `GOVERNOR_BOOST` | enum | `"performance"` | Governor to set on foreground cores. One of: `performance`, `powersave`, `ondemand`, `conservative`, `schedutil`, `userspace`. |
| `GOVERNOR_USE_SUDO` | boolean | `false` | Use `sudo -n cpupower` for governor changes (needed for `systemctl --user` since sysfs is root-only). Requires a NOPASSWD sudoers rule. |

### OOM Protection

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_OOM_PROTECTION` | boolean | `true` | Adjust `oom_score_adj` for the foreground process to protect it from the OOM killer. |
| `FOREGROUND_OOM_SCORE_ADJ` | integer | `-500` | oom_score_adj value for foreground process (-1000 to 1000). More negative = more protected. |

### Notifications and Integration

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_NOTIFICATIONS` | boolean | `true` | Show desktop notifications via `notify-send` when boost is applied. |
| `ENABLE_GAMEMODE_COEXIST` | boolean | `true` | When Feral GameMode is active for a PID, skip niceness and governor changes to avoid conflicts. Core/cgroup/OOM still applied. |
| `ENABLE_EVENT_DRIVEN_FOCUS` | boolean | `true` | Use D-Bus signal subscription for focus detection on GNOME/Wayland instead of polling. |

### CPU History (Moving Average)

| Key | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `CPU_HISTORY_SIZE` | integer | `5` | 1 | 60 | Number of PSI samples for the moving average. Larger = smoother but slower response. |

### Hysteresis

| Key | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `HYSTERESIS_NORMAL_TO_WARN_MS` | number | `3000` | 0 | 60000 | Minimum dwell time in NORMAL before transitioning to WARN. |
| `HYSTERESIS_WARN_TO_CRITICAL_MS` | number | `3000` | 0 | 60000 | Minimum dwell time in WARN before transitioning to CRITICAL. |
| `HYSTERESIS_CRITICAL_TO_NORMAL_MS` | number | `5000` | 0 | 60000 | Minimum dwell time in CRITICAL before transitioning to NORMAL. |

### Auto-Restore and Multimedia

| Key | Type | Default | Description |
|---|---|---|---|
| `AUTO_RESTORE` | boolean | `true` | Automatically restore all throttled processes when stress returns to NORMAL. |
| `ENABLE_MULTIMEDIA_PROTECTION` | boolean | `true` | Protect processes actively playing audio/video from throttling. |

### CPU Topology and Adaptive Scheduler

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_CPU_TOPOLOGY` | boolean | `true` | Detect and use CPU topology (SMT, NUMA, P-Core/E-Core, AMD CCD). |
| `ENABLE_ADAPTIVE_SCHEDULER` | boolean | `true` | Enable multi-factor adaptive scoring for stress level decisions. |

### Adaptive Weights

| Key | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `ADAPTIVE_WEIGHT_CPU` | number | `1.0` | 0 | 10 | Weight for CPU pressure factor. |
| `ADAPTIVE_WEIGHT_MEM` | number | `0.8` | 0 | 10 | Weight for memory pressure factor. |
| `ADAPTIVE_WEIGHT_FOREGROUND` | number | `0.5` | 0 | 10 | Weight for foreground activity factor. |
| `ADAPTIVE_WEIGHT_MEDIA` | number | `1.2` | 0 | 10 | Weight for media playback factor (reduces score). |
| `ADAPTIVE_WEIGHT_BATTERY` | number | `0.3` | 0 | 10 | Weight for battery status factor (reduces score). |
| `ADAPTIVE_WEIGHT_THERMAL` | number | `0.4` | 0 | 10 | Weight for thermal temperature factor. |
| `BATTERY_CHECK_PATH` | path | `"/sys/class/power_supply/BAT0/"` | — | — | Path to battery sysfs directory. |
| `THERMAL_ZONE_INDEX` | integer | `0` | 0 | 100 | Index of thermal zone to read. |

### Scheduler Class Settings

#### Priority (higher = more important for core assignment)

| Key | Type | Default | Range |
|---|---|---|---|
| `SCHEDULER_CLASS_REALTIME_PRIORITY` | integer | `100` | 0–1000 |
| `SCHEDULER_CLASS_INTERACTIVE_PRIORITY` | integer | `80` | 0–1000 |
| `SCHEDULER_CLASS_MULTIMEDIA_PRIORITY` | integer | `70` | 0–1000 |
| `SCHEDULER_CLASS_BACKGROUND_PRIORITY` | integer | `30` | 0–1000 |
| `SCHEDULER_CLASS_IDLE_PRIORITY` | integer | `10` | 0–1000 |

#### Niceness (lower = higher CPU priority, range -20 to 19)

| Key | Type | Default |
|---|---|---|
| `SCHEDULER_CLASS_REALTIME_NICE` | integer | `-10` |
| `SCHEDULER_CLASS_INTERACTIVE_NICE` | integer | `-5` |
| `SCHEDULER_CLASS_MULTIMEDIA_NICE` | integer | `-3` |
| `SCHEDULER_CLASS_BACKGROUND_NICE` | integer | `10` |
| `SCHEDULER_CLASS_IDLE_NICE` | integer | `19` |

#### I/O Priority (`[class, level]` — class: 1=RT, 2=BE, 3=Idle; level: 0–7)

| Key | Type | Default |
|---|---|---|
| `SCHEDULER_CLASS_REALTIME_IOPRIO` | [int, int] | `[1, 0]` |
| `SCHEDULER_CLASS_INTERACTIVE_IOPRIO` | [int, int] | `[1, 4]` |
| `SCHEDULER_CLASS_MULTIMEDIA_IOPRIO` | [int, int] | `[1, 2]` |
| `SCHEDULER_CLASS_BACKGROUND_IOPRIO` | [int, int] | `[3, 0]` |
| `SCHEDULER_CLASS_IDLE_IOPRIO` | [int, int] | `[3, 7]` |

### Feature Flags (v2.1)

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_CPU_HISTORY` | boolean | `true` | Enable CPU PSI moving average. |
| `ENABLE_MULTIMEDIA_DETECTOR` | boolean | `true` | Enable active multimedia detection (PipeWire/PulseAudio). |
| `ENABLE_HYSTERESIS` | boolean | `true` | Enable hysteresis dwell times for state transitions. |
| `ENABLE_SMART_SCHEDULER` | boolean | `true` | Enable adaptive scoring algorithm. |
| `ENABLE_TOPOLOGY` | boolean | `true` | Enable CPU topology-aware core layout. |
| `ENABLE_EVENT_ENGINE` | boolean | `true` | Enable event-driven focus detection subsystem. |
| `ENABLE_BENCHMARK` | boolean | `false` | Enable benchmark mode. |
| `ENABLE_DEBUG` | boolean | `false` | Enable additional debug output. |
| `ENABLE_PLUGINS` | boolean | `true` | Enable the plugin system. |
| `ENABLE_METRICS` | boolean | `true` | Enable the internal metrics collector. |
| `ENABLE_SELF_CHECK` | boolean | `true` | Run pre-flight self-check on startup. |
| `ENABLE_SAFE_ROLLBACK` | boolean | `true` | Enable crash recovery via state file persistence. |

### Plugin and Rollback

| Key | Type | Default | Description |
|---|---|---|---|
| `PLUGIN_DIR` | path (nullable) | `null` | Custom plugin directory. `null` = built-in plugins only. |
| `ROLLBACK_STATE_FILE` | path (nullable) | `null` | Path to rollback state file. `null` = `/tmp/dynalloc-state.json`. |

## Hot-Reloadable Fields

The following fields can be changed at runtime by editing the config file (when `HOT_RELOAD` is `true`). All other fields require a daemon restart.

**Tick intervals**: `FAST_TICK_MS`, `SLOW_TICK_MS`, `FAST_TICK_IDLE_MS`

**PSI thresholds**: `PSI_CPU_WARN`, `PSI_CPU_CRITICAL`, `PSI_MEM_WARN`, `PSI_MEM_CRITICAL`

**Background detection**: `HEAVY_BG_PATTERNS`, `HEAVY_BG_CPU_THRESHOLD`, `CRITICAL_PROCESS_PATTERNS`

**Logging**: `LOG_LEVEL`, `LOG_FILE_MAX_SIZE_MB`, `LOG_FILE_MAX_FILES`

**Cgroup tuning**: `FOREGROUND_CPU_WEIGHT`, `BACKGROUND_CPU_WEIGHT`, `FOREGROUND_CPU_MAX`, `BACKGROUND_CPU_MAX`

**Governor**: `ENABLE_GOVERNOR_SWITCH`, `GOVERNOR_BOOST`, `GOVERNOR_USE_SUDO`

**OOM**: `ENABLE_OOM_PROTECTION`, `FOREGROUND_OOM_SCORE_ADJ`

**Integration**: `ENABLE_NOTIFICATIONS`, `ENABLE_GAMEMODE_COEXIST`, `ENABLE_EVENT_DRIVEN_FOCUS`

**v2.0 features**: `CPU_HISTORY_SIZE`, all `HYSTERESIS_*` values, `AUTO_RESTORE`, `ENABLE_MULTIMEDIA_PROTECTION`, `ENABLE_ADAPTIVE_SCHEDULER`, all `ADAPTIVE_WEIGHT_*` values, all `SCHEDULER_CLASS_*_PRIORITY`, all `SCHEDULER_CLASS_*_NICE`

**v2.1 feature flags**: `ENABLE_CPU_HISTORY`, `ENABLE_MULTIMEDIA_DETECTOR`, `ENABLE_HYSTERESIS`, `ENABLE_SMART_SCHEDULER`, `ENABLE_TOPOLOGY`, `ENABLE_EVENT_ENGINE`, `ENABLE_BENCHMARK`, `ENABLE_DEBUG`, `ENABLE_PLUGINS`, `ENABLE_METRICS`

### NOT Hot-Reloadable (Require Restart)

`FOREGROUND_CORE_RESERVE`, `ENABLE_CGROUPS_V2`, `CGROUP_ROOT`, `CGROUP_PARENT_SLICE`, `CGROUP_MODE`, `DRY_RUN`, `HOT_RELOAD`, `LOG_FILE_PATH`, `ENABLE_PLUGINS`, `PLUGIN_DIR`, `ENABLE_SELF_CHECK`, `ENABLE_SAFE_ROLLBACK`, `ROLLBACK_STATE_FILE`

## Config Validation Rules

1. **Type checking**: every field is validated against its schema type. Invalid values silently fall back to the default.
2. **Range checking**: numeric fields are clamped to their min/max. Out-of-range values fall back to defaults.
3. **Integer enforcement**: fields marked `integer` must be whole numbers.
4. **Enum validation**: `LOG_LEVEL`, `CGROUP_MODE`, `GOVERNOR_BOOST` must match one of the allowed values.
5. **Path validation**: paths containing `..` or null bytes are rejected.
6. **Regex validation**: entries in `HEAVY_BG_PATTERNS` and `CRITICAL_PROCESS_PATTERNS` are tested via `new RegExp(src, 'i')`. Invalid patterns are silently dropped.
7. **I/O priority validation**: must be `[number, number]` where class is 1–3 and level is 0–7.
8. **cpuMax validation**: must be `"max"` or match the pattern `\d+ \d+` (quota period in microseconds).
9. **Cross-field**: `PSI_CPU_WARN` must be < `PSI_CPU_CRITICAL`. `PSI_MEM_WARN` must be < `PSI_MEM_CRITICAL`. If violated, both CPU or both memory thresholds revert to defaults.
10. **Unknown keys**: any config key not in the built-in defaults is silently ignored.

## Environment Variable Overrides

| Variable | Effect | Precedence |
|---|---|---|
| `DYNALLOC_CONFIG_PATH` | Sets the config file path (bypasses normal search order). | Highest for file selection |
| `DYNALLOC_DRY_RUN=1` | Forces dry-run mode on regardless of config file. | Highest — overrides `DRY_RUN` in config |
| `DYNALLOC_LOG_LEVEL=debug` | Forces log level regardless of config file. Must be a valid level name. | Highest — overrides `LOG_LEVEL` in config |
| `DYNALLOC_POLICY_PATH` | Sets the policy engine file path (bypasses normal search order). Only used when `ENABLE_POLICY_ENGINE` is true. | Highest for policy file selection |

---

## Policy Engine Configuration (v2.2)

The Policy Engine is an optional subsystem that adds event-driven rule
evaluation on top of the existing scheduler. When disabled (default),
no policy-engine code is loaded — zero behavior change.

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_POLICY_ENGINE` | boolean | `false` | ❌ No (requires restart) | Master switch for the policy engine. |
| `POLICY_FILE_PATH` | string \| null | `null` | ❌ No (resolved at startup) | Explicit policy file path. If null, auto-detects `~/.config/dynalloc/policies.{json,yaml}` then `/etc/dynalloc/policies.{json,yaml}`. |
| `POLICY_HOT_RELOAD` | boolean | `true` | ✅ Yes | Watch the policy file for changes and reload automatically (300ms debounce). |
| `POLICY_LOG_FILE_PATH` | string \| null | `null` | ✅ Yes | If set, write audit records to this file (JSON-lines with rotation). If null, audit records still go to the in-memory ring buffer. |
| `POLICY_LOG_MAX_SIZE_MB` | number | `5` | ✅ Yes | Max audit log file size before rotation (1-1024 MB). |
| `POLICY_LOG_MAX_FILES` | number | `3` | ✅ Yes | Max rotated audit log files to keep (1-100). |
| `POLICY_DEFAULT_COOLDOWN_MS` | number | `1000` | ✅ Yes | Default cooldown for rules that don't specify one (0-86400000 ms). |
| `POLICY_MAX_RULES` | number | `200` | ✅ Yes | Hard cap on rule count (1-10000). Extra rules are dropped with a warning. |
| `POLICY_EXECUTION_TIMEOUT_MS` | number | `5000` | ✅ Yes | Advisory per-action timeout in ms (100-60000). |

### Example

```json
{
  "ENABLE_POLICY_ENGINE": true,
  "POLICY_FILE_PATH": "/etc/dynalloc/policies.json",
  "POLICY_HOT_RELOAD": true,
  "POLICY_LOG_FILE_PATH": "/var/log/dynalloc-policy.log",
  "POLICY_LOG_MAX_SIZE_MB": 5,
  "POLICY_LOG_MAX_FILES": 3,
  "POLICY_DEFAULT_COOLDOWN_MS": 1000,
  "POLICY_MAX_RULES": 200,
  "POLICY_EXECUTION_TIMEOUT_MS": 5000
}
```

See [PolicyEngine.md](PolicyEngine.md) for the full policy file schema,
rule syntax, action reference, and examples.

---

## Detector Layer Configuration (v0.5.0 Phase 1)

The Detector Layer is an optional, purely-observational detection
framework that runs alongside the existing classifier / plugins /
multimedia stack. When disabled (default), zero behavior change.
When enabled, it constructs a `DetectorManager` that runs registered
detectors on each fastTick / slowTick and emits bus events
(`onWorkloadDetected`, `onPowerStateChanged`, `onIdleStateChanged`,
etc.).

The detector layer NEVER modifies system state — it only observes
and emits. Action execution remains the responsibility of the Policy
Engine (or future consumers).

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_DETECTOR_LAYER` | boolean | `false` | ✅ Yes | Master switch for the detector layer. |
| `DETECTOR_IDLE_THRESHOLD_TICKS` | integer | `30` | ✅ Yes | Consecutive idle-signal ticks before transitioning ACTIVE → IDLE. |
| `DETECTOR_IDLE_CPU_PRESSURE_MAX` | number | `2.0` | ✅ Yes | PSI avg10 below this = "low CPU" for idle detection (0–50). |
| `DETECTOR_IDLE_NET_RX_KBPS_MAX` | number | `5` | ✅ Yes | KB/s below this = "low network" for idle detection. |

### Built-in Detectors

When `ENABLE_DETECTOR_LAYER=true`, the following detectors are
registered automatically:

| Detector | Domain | Classifications | Events Emitted |
|---|---|---|---|
| `workload` | foreground workload | `GAME`, `IDE`, `BROWSER`, `RENDERER`, `VIRTUALIZATION`, `COMPILER`, `MULTIMEDIA`, `UNKNOWN`, `NONE` | `onWorkloadDetected` |
| `power-state` | power / battery | `AC`, `CHARGING`, `BATTERY`, `BATTERY_LOW`, `BATTERY_CRITICAL`, `UNKNOWN` | `onPowerStateChanged`, `onAcPlugged`, `onAcUnplugged`, `onBatteryCharging`, `onBatteryDischarging`, `onBatteryLow`, `onBatteryCritical` |
| `idle-state` | user activity | `ACTIVE`, `IDLE` | `onIdleStateChanged`, `onIdle`, `onIdleEnd` |

### Event Bus Integration

When the Policy Engine is enabled, the DetectorManager shares the
PE's bus — detector events are visible to PE rules. When PE is
disabled, the DetectorManager creates an isolated bus so detector
events don't pollute any global state.

### IPC Access

The `detectors` IPC handler returns the detector layer status:

```bash
dynalloc detectors              # human-readable status
dynalloc detectors --json       # JSON output
```

### Example

```json
{
  "ENABLE_DETECTOR_LAYER": true,
  "DETECTOR_IDLE_THRESHOLD_TICKS": 60,
  "DETECTOR_IDLE_CPU_PRESSURE_MAX": 1.0,
  "DETECTOR_IDLE_NET_RX_KBPS_MAX": 2
}
```

---

## Resource Controller Layer Configuration (v0.5.0 Phase 2)

The Resource Controller Layer is a unified execution layer that sits
between the Policy Engine and the operating system. It aggregates
all resource controllers (CPU, Memory, IO, Network, Governor,
Thermal, Power) into a single `ResourceControllerManager` entry
point.

When disabled (default), the manager is not constructed — the Policy
Engine continues to call the Actuator/Governor directly (backward
compat). When enabled, the manager is constructed and the PE's new
action types (`setThermalProfile`, `setPowerProfile`, `setPpdProfile`)
route through it.

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_RESOURCE_CONTROLLER_LAYER` | boolean | `false` | ✅ Yes | Master switch for the Resource Controller Layer. |
| `THERMAL_PROFILE_DEFAULT` | enum | `"balanced"` | ✅ Yes | Default thermal profile. One of: `balanced`, `cool`, `silent`. |
| `POWER_PROFILE_DEFAULT` | enum | `"balanced"` | ✅ Yes | Default power profile. One of: `balanced`, `power-saver`, `performance`. |

### Built-in Controllers

When `ENABLE_RESOURCE_CONTROLLER_LAYER=true`, the following
controllers are registered automatically:

| Controller | Domain | Methods |
|---|---|---|
| `cpu` | CPU affinity + niceness | `pinToCores(pid, cores)`, `setNiceness(pid, nice)` |
| `memory` | OOM score | `setOomScoreAdj(pid, value)` |
| `io` | I/O priority | `setIoPriority(pid, cls, level)` |
| `network` | Network QoS | `setup()`, `stop()` (only when `ENABLE_NETWORK_QOS=true`) |
| `governor` | CPU frequency governor | `applyGovernor(cores, gov)`, `restoreGovernors()` |
| `thermal` | Thermal profile | `applyProfile(name)`, `pause(ms)`, `resume()`, `isPaused()` |
| `power` | Power profile + PPD | `applyProfile(name)`, `setPpdProfile(name)`, `getPpdProfile()` |

### Thermal Profiles

| Profile | Threshold (°C) | Duration (ms) | Resume (°C) |
|---|---|---|---|
| `balanced` | 85 | 30000 | 75 (factory defaults) |
| `cool` | 75 | 45000 | 65 |
| `silent` | 65 | 60000 | 55 |

### Power Profiles

| Profile | FG CPU Weight | BG CPU Weight | Governor Switch |
|---|---|---|---|
| `balanced` | 800 | 20 | true (factory defaults) |
| `power-saver` | 600 | 10 | false |
| `performance` | 1000 | 20 | true |

### PPD Profiles

When `power-profiles-daemon` (PPD) is running, the Power Controller
can set the system-wide PPD profile via `gdbus`:

| Profile | Description |
|---|---|
| `power-saver` | Maximum power saving |
| `balanced` | Default balanced profile |
| `performance` | Maximum performance |

### IPC Access

The `resources` IPC handler returns the Resource Controller Layer
status:

```bash
dynalloc resources              # human-readable status
dynalloc resources --json       # JSON output
```

### Example

```json
{
  "ENABLE_RESOURCE_CONTROLLER_LAYER": true,
  "THERMAL_PROFILE_DEFAULT": "balanced",
  "POWER_PROFILE_DEFAULT": "balanced"
}
```

---

## Profile Manager Configuration (v0.5.0 Phase 3)

The Profile Manager is the decision layer between the Detector Layer
and the Resource Controller Layer. It subscribes to detector events,
evaluates which profile should be active based on a deterministic
priority system, and instructs the RCM to apply the winning profile's
resource settings.

When disabled (default), the manager is not constructed — the PE's
existing `applyProfile` action continues to work independently.

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_PROFILE_MANAGER` | boolean | `false` | ✅ Yes | Master switch for the Profile Manager. |
| `PROFILE_FILE_PATH` | path | `null` | ✅ Yes | Path to a JSON/YAML file with custom profile definitions. `null` = built-in profiles only. |
| `PROFILE_IDLE_TIMEOUT_MS` | number | `300000` | ✅ Yes | Milliseconds to wait after idle signal before activating the `idle` profile (0-3600000). |

### Built-in Profiles

| Profile | Priority | Description |
|---|---|---|
| `balanced` | 100 | Factory defaults |
| `performance` | 200 | High foreground CPU weight, governor on |
| `powersave` | 150 | Conservative CPU weights, governor off |
| `gaming` | 500 | Performance + cool thermal (inherits `performance`) |
| `development` | 300 | IDE/compiler workloads (inherits `balanced`) |
| `rendering` | 400 | OBS/Blender/ffmpeg (inherits `performance`) |
| `streaming` | 250 | Media playback (inherits `balanced`) |
| `battery-saver` | 450 | Powersave + silent thermal (inherits `powersave`) |
| `idle` | 50 | Minimal resource usage after idle timeout |

### Conflict Resolution

When multiple profiles are simultaneously demanded, the one with the
highest `priority` wins. Ties are broken by registration order.

### IPC Access

```bash
dynalloc profiles              # human-readable status
dynalloc profiles --json       # JSON output
```

### Example

```json
{
  "ENABLE_PROFILE_MANAGER": true,
  "PROFILE_FILE_PATH": null,
  "PROFILE_IDLE_TIMEOUT_MS": 300000
}
```

See [ProfileManager.md](ProfileManager.md) for the complete profile
architecture, lifecycle, configuration format, priority rules,
inheritance, conflict resolution, and examples.

---

## Adaptive Switching Configuration (v0.5.0 Phase 4)

The Adaptive Switching Engine wraps the Profile Manager with
production-grade stability guarantees: debouncing, cooldowns,
oscillation detection, rollback on failure, and user overrides.

When disabled (default), the Profile Manager receives events directly
(Phase 3 behavior). When enabled, the AdaptiveEngine intercepts
events first.

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_ADAPTIVE_SWITCHING` | boolean | `false` | ✅ Yes | Master switch. |
| `ADAPTIVE_DEBOUNCE_MS` | number | `200` | ✅ Yes | Coalesce rapid events into one transition (0-5000). |
| `ADAPTIVE_COOLDOWN_MS` | number | `1000` | ✅ Yes | Minimum dwell time per profile (0-60000). |
| `ADAPTIVE_USER_OVERRIDE_PRIORITY` | integer | `1000` | ✅ Yes | User override priority (0-1000, wins all conflicts). |
| `ADAPTIVE_MAX_HISTORY` | integer | `100` | ✅ Yes | Transition history ring buffer size (10-1000). |
| `ADAPTIVE_OSCILLATION_WINDOW_MS` | number | `10000` | ✅ Yes | Window for oscillation detection (1000-300000). |
| `ADAPTIVE_OSCILLATION_THRESHOLD` | integer | `5` | ✅ Yes | Transitions in window before oscillation flag (3-20). |

### IPC Access

```bash
dynalloc adaptive                # human-readable status
dynalloc adaptive --json         # JSON output
```

### User Override

```bash
# Demand a user override
echo '{"cmd":"adaptive-override","args":{"action":"demand","profile":"performance"}}' | dynalloc-ipc

# Release the override
echo '{"cmd":"adaptive-override","args":{"action":"release"}}' | dynalloc-ipc
```

### Example

```json
{
  "ENABLE_ADAPTIVE_SWITCHING": true,
  "ADAPTIVE_DEBOUNCE_MS": 200,
  "ADAPTIVE_COOLDOWN_MS": 1000,
  "ADAPTIVE_OSCILLATION_THRESHOLD": 5
}
```

See [AdaptiveSwitching.md](AdaptiveSwitching.md) for the complete
architecture, event flow, transition lifecycle, rollback behavior,
and examples.

---

## Workload Recognition Configuration (v0.5.0 Phase 5)

The Workload Recognition Engine identifies workload categories using
deterministic rules and heuristics, then maps them to optimization
strategies.

When disabled (default), no recognition engine is constructed.

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_WORKLOAD_RECOGNITION` | boolean | `false` | ✅ Yes | Master switch. |
| `RECOGNITION_CONFIDENCE_THRESHOLD` | number | `0.60` | ✅ Yes | Minimum confidence to switch profiles (0-1). |
| `RECOGNITION_DEBOUNCE_MS` | number | `300` | ✅ Yes | Debounce for recognition events (0-5000). |

### 14 Workload Categories

gaming, development, web-browsing, office-productivity, video-editing,
audio-production, 3d-rendering, streaming, virtual-machines,
containers, ai-ml, file-compression, idle, background-tasks

### IPC Access

```bash
dynalloc recognition                # human-readable status
dynalloc recognition --json         # JSON output
```

### Example

```json
{
  "ENABLE_WORKLOAD_RECOGNITION": true,
  "RECOGNITION_CONFIDENCE_THRESHOLD": 0.60,
  "RECOGNITION_DEBOUNCE_MS": 300
}
```

See [WorkloadRecognition.md](WorkloadRecognition.md) for the complete
architecture, detection flow, categories, confidence model, strategy
mapping, and plugin extension guide.

---

## Monitoring Framework Configuration (v0.5.0 Phase 6)

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_MONITORING_FRAMEWORK` | boolean | `false` | ✅ Yes | Master switch. |
| `MONITORING_HEALTH_CHECK_INTERVAL_MS` | number | `30000` | ✅ Yes | Health check interval (5000-300000). |
| `MONITORING_BENCHMARK_ENABLED` | boolean | `true` | ✅ Yes | Allow on-demand benchmarks via IPC. |

### IPC Access

```bash
echo '{"cmd":"health","args":{}}' | dynalloc-ipc     # health check
echo '{"cmd":"monitor","args":{}}' | dynalloc-ipc     # system snapshot
echo '{"cmd":"diagnostics","args":{}}' | dynalloc-ipc  # diagnostics report
echo '{"cmd":"benchmark","args":{"name":"memory","iterations":100}}' | dynalloc-ipc
```

### Example

```json
{
  "ENABLE_MONITORING_FRAMEWORK": true,
  "MONITORING_HEALTH_CHECK_INTERVAL_MS": 30000,
  "MONITORING_BENCHMARK_ENABLED": true
}
```

---

## Plugin SDK Configuration (v0.5.0 Phase 7)

| Key | Type | Default | Hot-Reloadable | Description |
|---|---|---|---|---|
| `ENABLE_PLUGIN_SDK` | boolean | `false` | ✅ Yes | Master switch. |
| `PLUGIN_SDK_API_VERSION` | string | `"1.0"` | ✅ Yes | SDK API version. |
| `PLUGIN_SDK_STRICT_PERMISSIONS` | boolean | `false` | ✅ Yes | Reject plugins with unknown permissions. |
| `PLUGIN_SDK_DIR` | path | `null` | ✅ Yes | Directory containing SDK plugins. |

### IPC Access

```bash
echo '{"cmd":"sdk","args":{}}' | dynalloc-ipc    # SDK status
```

### Example

```json
{
  "ENABLE_PLUGIN_SDK": true,
  "PLUGIN_SDK_API_VERSION": "1.0",
  "PLUGIN_SDK_STRICT_PERMISSIONS": false,
  "PLUGIN_SDK_DIR": "/etc/dynalloc/sdk-plugins"
}
```
