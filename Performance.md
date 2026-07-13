# Performance

## Resource Usage Targets

DynAlloc is designed to be lightweight enough to run continuously on a desktop system without perceptible overhead.

| Metric | Target | Notes |
|---|---|---|
| **CPU (idle)** | < 0.5% | During NORMAL stress with idle backoff active. |
| **CPU (active)** | < 2% | During WARN/CRITICAL with process scanning. |
| **RSS (memory)** | < 30 MB | Steady-state with all features enabled. |
| **File descriptors** | < 20 | Includes log file, config watcher, D-Bus monitor. |

These targets are achievable because:
- **fastTick** only reads two small files (`/proc/pressure/cpu`, `/proc/pressure/memory`) and does in-memory computation.
- **slowTick** is the expensive path (spawns external processes) but runs at a lower cadence (3s default).
- The daemon self-deprioritizes on startup: `nice 10`, I/O priority `Idle,0`.

## Tick Interval Tuning

### Default Intervals

| Timer | Default | When Active |
|---|---|---|
| `FAST_TICK_MS` | 1000 ms | PSI reading, scheduler evaluation |
| `SLOW_TICK_MS` | 3000 ms | Foreground detection, process scan, throttling |
| `FAST_TICK_IDLE_MS` | 2500 ms | Fast tick interval when idle (>10 consecutive NORMAL ticks) |

### Tuning Guidance

- **Faster response** (gaming, real-time workloads):
  ```json
  { "FAST_TICK_MS": 500, "SLOW_TICK_MS": 2000, "FAST_TICK_IDLE_MS": 1500 }
  ```
  Trade-off: slightly higher CPU usage (~0.3% more during idle).

- **Lower overhead** (battery, background server):
  ```json
  { "FAST_TICK_MS": 2000, "SLOW_TICK_MS": 5000, "FAST_TICK_IDLE_MS": 4000 }
  ```
  Trade-off: up to 5 seconds of delay before detecting stress changes.

- **Very aggressive** (latency-sensitive):
  ```json
  { "FAST_TICK_MS": 200, "SLOW_TICK_MS": 1000 }
  ```
  Warning: `FAST_TICK_MS` below 200 is not recommended due to PSI file read latency.

### Minimum and Maximum

- `FAST_TICK_MS`: minimum 100 ms, maximum 60000 ms.
- `SLOW_TICK_MS`: minimum 500 ms, maximum 60000 ms.
- `FAST_TICK_IDLE_MS`: minimum 500 ms, maximum 60000 ms.

## Idle Backoff Mechanism

The daemon dynamically adjusts its polling rate based on system activity:

```
consecutiveNormalTicks > 10  →  fastTick interval = FAST_TICK_IDLE_MS
any non-NORMAL tick          →  fastTick interval = FAST_TICK_MS (immediate)
```

With default values, this means:

1. System is loaded → daemon polls PSI every **1000 ms**.
2. System is idle for >10 seconds → daemon polls PSI every **2500 ms**.
3. Any stress detected → daemon immediately reverts to **1000 ms**.

This saves ~0.1–0.2% CPU during extended idle periods while maintaining responsive detection.

The metrics gauge `fast_tick_interval_ms` tracks the current interval in real time.

## Cost Breakdown per Tick

### fastTick (cheap)

| Operation | Estimated Cost |
|---|---|
| Read `/proc/pressure/cpu` | ~0.01 ms (file read) |
| Read `/proc/pressure/memory` | ~0.01 ms |
| Read battery sysfs | ~0.01 ms (if available) |
| Read thermal sysfs | ~0.01 ms (if available) |
| CpuHistory push + average | ~0.001 ms (in-memory) |
| Adaptive score calculation | ~0.001 ms (in-memory) |
| Hysteresis evaluation | ~0.001 ms (in-memory) |
| **Total** | **~0.05 ms** |

### slowTick (expensive, only when stress ≠ NORMAL)

| Operation | Estimated Cost |
|---|---|
| `getForegroundPID()` (xdotool) | ~5–20 ms |
| `getForegroundPID()` (gdbus GNOME/Wayland) | ~10–30 ms |
| `listProcesses()` (ps) | ~10–50 ms (depends on process count) |
| `getActiveMediaPids()` (pw-cli) | ~20–50 ms |
| `getActiveMediaPids()` (pactl fallback) | ~10–30 ms |
| Plugin detection (N plugins × M procs) | ~0.1–1 ms |
| Throttle actions (taskset/renice/ionice per PID) | ~2–5 ms per PID |
| **Total (no throttling)** | **~30–100 ms** |
| **Total (with 5 PIDs throttled)** | **~50–130 ms** |

## Benchmark Mode

Set `ENABLE_BENCHMARK: true` in config to enable benchmark mode. When enabled, the daemon logs additional timing information for each tick phase.

Combined with `ENABLE_METRICS: true` (default), you can access latency histograms:

```
-- Latencies (ms) --
Scheduler Tick: avg=0.05 p95=0.08
Process Scan: avg=15.2 p95=25.4
Foreground Detect: avg=12.1 p95=18.3
Media Detect: avg=35.7 p95=48.2
```

Key metrics to watch:

| Metric | Healthy Range | Concern |
|---|---|---|
| `scheduler_tick_latency_ms` p95 | < 0.5 ms | > 2 ms suggests system pressure affecting the daemon itself. |
| `process_scan_latency_ms` p95 | < 100 ms | > 500 ms suggests too many processes or slow `ps`. |
| `foreground_detect_latency_ms` p95 | < 50 ms | > 200 ms suggests D-Bus or xdotool slowness. |
| `media_detect_latency_ms` p95 | < 100 ms | > 500 ms suggests PipeWire/PulseAudio issues. |
| `daemon_rss_mb` | < 30 MB | Steady growth beyond 30 MB suggests a memory leak. |
| `daemon_cpu_percent` | < 0.5% idle, < 2% active | Higher suggests excessive tick rates or plugin overhead. |

## Optimization Tips

1. **Use cgroups v2** instead of taskset+renice when available. Cgroup assignment (writing a PID to `cgroup.procs`) is a single syscall vs. spawning `taskset`, `renice`, and `ionice` processes.

2. **Keep `CPU_HISTORY_SIZE` low** (3–5) unless you need very smooth readings. Each additional sample adds negligible CPU but increases the lag before the scheduler reacts to real changes.

3. **Disable multimedia detection** if you don't need it (`ENABLE_MULTIMEDIA_DETECTOR: false`). The `pw-cli list-objects` call is the single most expensive operation in the slowTick path.

4. **Disable plugins** if you don't need them (`ENABLE_PLUGINS: false`). Each plugin's `detect()` iterates the full process list.

5. **Increase `SLOW_TICK_MS`** to 5000+ if you don't need rapid response to foreground changes. This halves the cost of the expensive path.

6. **Use event-driven focus** on GNOME/Wayland (`ENABLE_EVENT_DRIVEN_FOCUS: true`). This avoids the polling cost of `gdbus call` every slowTick when no focus change has occurred.

7. **Self-deprioritize** is automatic — the daemon sets itself to `nice 10` and I/O priority `Idle,0` on startup so it never competes with user processes.

8. **Log level** matters — `trace` and `debug` levels produce significantly more I/O. In production, use `info` or `warn`.