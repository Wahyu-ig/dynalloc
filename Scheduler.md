# Scheduler

The scheduler is the decision-making core of DynAlloc. It determines when to boost the foreground application, when to throttle background processes, and when to restore everything to normal.

## Priority Classes

Every process is classified into one of five scheduler classes, each with configurable priority, niceness, and I/O priority:

| Class | Description | Default Priority | Default Nice | Default I/O Prio |
|---|---|---|---|---|
| **REALTIME** | System-critical processes (systemd, dbus, display compositor, audio server) | 100 | -10 | RT, 0 |
| **INTERACTIVE** | User-facing apps (games, browsers, IDEs) and their Electron child processes | 80 | -5 | RT, 4 |
| **MULTIMEDIA** | Audio/video players, streaming tools, video wallpapers | 70 | -3 | RT, 2 |
| **BACKGROUND** | Compilers, build tools, containers, VMs, Steam/Lutris/Wine/Proton, Flatpak/Snap | 30 | 10 | Idle, 0 |
| **IDLE** | All other unrecognized processes | 10 | 19 | Idle, 7 |

### Category-to-Class Mapping

The `classifier.js` module maps process name patterns to categories, and categories to scheduler classes:

```
SYSTEM, DAEMON     → REALTIME
GAME, IDE, BROWSER, ELECTRON → INTERACTIVE
AUDIO, VIDEO, STREAMING, WALLPAPER → MULTIMEDIA
COMPILER, STEAM, LUTRIS, WINE, PROTON, CONTAINER, VM, FLATPAK, SNAP → BACKGROUND
UNKNOWN            → IDLE
```

### Protection Rules

Processes in the **REALTIME** and **MULTIMEDIA** classes are **never throttled**, regardless of stress level. Additionally:

- The foreground process and all its descendants (child tree) are never throttled.
- Any PID in the multimedia detector's active media set is never throttled.
- Processes matching `CRITICAL_PROCESS_PATTERNS` are never throttled.

## Stress Levels

The scheduler operates in one of three stress levels, determined by PSI (Pressure Stall Information) readings:

| Level | Condition | Behavior |
|---|---|---|
| **NORMAL** | CPU avg < WARN and Mem avg < WARN (and adaptive score ≤ 0.6) | No throttling. Auto-restore kicks in. Idle backoff may activate. |
| **WARN** | CPU avg ≥ WARN or Mem avg ≥ WARN (or adaptive score > 0.6) | Background processes matching heavy patterns get throttled. |
| **CRITICAL** | CPU avg ≥ CRITICAL or Mem avg ≥ CRITICAL | Same as WARN but also forces an immediate slowTick for faster response. |

### Hysteresis

Hysteresis prevents rapid oscillation between stress levels (which would cause constant boost/throttle cycling). Each transition has a minimum dwell time:

| Transition | Default Dwell Time | Config Key |
|---|---|---|
| NORMAL → WARN | 3000 ms | `HYSTERESIS_NORMAL_TO_WARN_MS` |
| WARN → CRITICAL | 3000 ms | `HYSTERESIS_WARN_TO_CRITICAL_MS` |
| CRITICAL → NORMAL | 5000 ms | `HYSTERESIS_CRITICAL_TO_NORMAL_MS` |
| WARN → NORMAL | 3000 ms | `HYSTERESIS_NORMAL_TO_WARN_MS` |
| CRITICAL → WARN | 3000 ms | `HYSTERESIS_WARN_TO_CRITICAL_MS` |
| NORMAL → CRITICAL (skip) | 6000 ms | Sum of NORMAL→WARN + WARN→CRITICAL |

When hysteresis is enabled (`ENABLE_HYSTERESIS`), the scheduler tracks a "pending" level and the time since it became pending. The transition only fires once the pending duration exceeds the required dwell time. Setting `ENABLE_HYSTERESIS` to `false` allows immediate transitions.

## Adaptive Scoring Algorithm

The adaptive scheduler computes a normalized score [0.0, 1.0] that can elevate the effective stress level even when raw PSI is below thresholds. This allows the daemon to react proactively.

### Score Calculation

```
score = (cpuNorm * W_CPU) + (memNorm * W_MEM) + (fgActive * W_FG)
        - (mediaPlaying * W_MEDIA) - (onBattery * 0.5 * W_BATTERY)
        + (thermalNorm * W_THERMAL)

normalized = score / maxPossible
clamped    = max(0, min(1, normalized))
```

Where:

| Factor | Normalization | Default Weight | Effect |
|---|---|---|---|
| CPU pressure | `min(cpuPSI / PSI_CPU_CRITICAL, 1.0)` | 1.0 | Higher pressure → higher score |
| Memory pressure | `min(memPSI / PSI_MEM_CRITICAL, 1.0)` | 0.8 | Higher pressure → higher score |
| Foreground active | 1 if foreground PID exists, else 0 | 0.5 | Active foreground → higher urgency |
| Media playing | 1 if media PIDs detected, else 0 | 1.2 | Media active → reduces score (less urgency to throttle) |
| On battery | 1 if discharging, else 0 | 0.3 | On battery → reduces score |
| Thermal | `min(max(temp - 50, 0) / 30, 1.0)` | 0.4 | Higher temp → higher score |

### Score Impact on Stress Level

If raw PSI says `NORMAL` but the adaptive score exceeds **0.6**, the scheduler elevates to `WARN` before hysteresis evaluation. This enables proactive throttling when multiple factors suggest rising pressure even if no single PSI threshold is breached.

## CPU History Moving Average

PSI `avg10` values are fed into a circular buffer (`CpuHistory`) before being used for stress decisions. This smooths out transient spikes.

- **Buffer size**: configurable via `CPU_HISTORY_SIZE` (default: 5, range: 1–60).
- **CPU average**: arithmetic mean of the last N CPU PSI `avg10` samples.
- **Memory average**: arithmetic mean of the last N memory PSI `avg10` samples.
- The scheduler uses these averages (not raw PSI) for all threshold comparisons.

Example with `CPU_HISTORY_SIZE=5`:

```
Raw PSI avg10:  [5.0, 12.0, 8.0, 3.0, 7.0]
Moving avg:     7.0  (sum / 5)
```

A single spike of 12.0 only contributes 1/5 to the average, preventing false CRITICAL triggers.

## Auto-Restore Mechanism

When the scheduler transitions back to `NORMAL`, all previously throttled processes are automatically restored:

1. **Tracking**: Every time a process is throttled, its PID is recorded in `AutoRestoreTracker` with a timestamp and comm name.
2. **Trigger**: When `scheduler.tick()` returns stress level `NORMAL` and `AUTO_RESTORE` is enabled, it generates `RESTORE` actions for all tracked PIDs.
3. **Execution**: The daemon calls `actuator.restoreProcess(pid, allCores)` which:
   - Moves the PID back to the base cgroup (or resets affinity to all cores)
   - Resets niceness to 0
   - Resets I/O priority to BE,4
   - Resets `oom_score_adj` to 0
4. **Cleanup**: After restoration, the tracker is cleared. Dead PIDs are pruned from the tracker on every slowTick.

Auto-restore ensures no process is left in a degraded state after a transient load spike.

## CPU Topology-Aware Scheduling

When `ENABLE_CPU_TOPOLOGY` and `ENABLE_TOPOLOGY` are both enabled, the scheduler uses the detected CPU layout to optimize core assignment.

### Standard (Non-Hybrid) CPUs

- `FOREGROUND_CORE_RESERVE` (default: 50% of total cores, or explicitly set) cores are designated as foreground.
- By default, the **highest-numbered** cores are used for foreground (convention: higher core numbers often map to higher-frequency cores on many systems).
- Remaining cores are background.

### Intel Hybrid CPUs (P-Core/E-Core)

On Intel 12th Gen+ and Core Ultra processors:

- **P-Cores** (Performance) are automatically used as foreground cores.
- **E-Cores** (Efficiency) are used as background cores.
- The `FOREGROUND_CORE_RESERVE` setting is **ignored** — P-Core/E-Core detection overrides it.
- Detection uses `cpu_capacity` sysfs entries or CPU model name matching.

### Example: 8-Core Intel Hybrid (4P + 4E)

```
P-Cores: [0, 1, 2, 3]   → foreground (games, browser, IDE)
E-Cores: [4, 5, 6, 7]   → background (compilers, containers)
```

The topology module also detects AMD CCD (Compute Complex Die) layout and SMT thread siblings, which are available for future scheduling optimizations.

## Foreground Boost

When the foreground window changes, the scheduler generates a boost for the new foreground process:

1. The previous foreground process is restored to normal.
2. The new foreground PID is classified and assigned its scheduler class settings.
3. If cgroups are available, the PID is moved to `foreground.slice`.
4. If not, the PID is pinned to foreground cores via `taskset`.
5. Niceness and I/O priority are set according to the scheduler class.
6. If `ENABLE_OOM_PROTECTION` is enabled, `oom_score_adj` is set to `FOREGROUND_OOM_SCORE_ADJ` (default: -500).
7. If `ENABLE_GOVERNOR_SWITCH` is enabled, foreground cores switch to the boost governor.
8. If Feral GameMode is active for the PID and `ENABLE_GAMEMODE_COEXIST` is enabled, niceness and governor changes are **skipped** to avoid conflicts. Core pinning, cgroups, and OOM protection are still applied.

## Heavy Background Detection

A process is considered "heavy background" (and thus a throttle candidate) if **any** of these are true:

1. Its scheduler class is `BACKGROUND` (matched by classifier patterns or `%CPU` threshold).
2. Its `%CPU` ≥ `HEAVY_BG_CPU_THRESHOLD` (default: 15%).
3. Its category is `COMPILER`, `CONTAINER`, or `VM`.

Processes in the foreground tree, media-protected PIDs, and REALTIME/MULTIMEDIA classes are excluded regardless.