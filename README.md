# DynAlloc

**AI-Powered Adaptive Linux Resource Manager** — a lightweight daemon for dynamic CPU core pinning, priority scheduling, and CPU/memory/IO/network/GPU QoS based on real system pressure (PSI) and active workload detection.

DynAlloc watches whatever app is currently focused and automatically boosts it (CPU affinity, niceness, I/O priority, GPU power) while quietly deprioritizing everything running in the background — no manual tuning, no per-game profiles to maintain. v2.1 adds predictive pre-allocation, per-app energy accounting, a CPU+GPU shared power budget arbiter, and GPU VRAM reclaim — features no other Linux resource daemon currently ships.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-linux-blue)
![License](https://img.shields.io/badge/license-MIT-informational)
![Version](https://img.shields.io/badge/version-2.1.0-orange)

```
✓ Foreground app          → boosted priority, dedicated cores, low-latency I/O
✓ Background apps         → deprioritized, throttled, kept out of the way
✓ Next app you'll open     → pre-warmed before you even click it (predictive)
✓ System under pressure   → adapts automatically via PSI, backs off before it gets bad
✓ CPU + GPU power draw    → arbitrated as one shared budget, not two silos
✓ VRAM about to run out   → background hogs briefly paused before the game OOMs
✓ Zero config required    → sensible defaults, everything advanced is opt-in
```

---

## Table of contents

- [Why DynAlloc](#why-dynalloc)
- [Features](#features)
- [Tier 1 Killer Features (v2.1.0)](#tier-1-killer-features-v210)
- [Intelligence Subsystem (v2.0.0)](#intelligence-subsystem-v200)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Policy Engine (optional)](#policy-engine-optional)
- [Plugin SDK (optional)](#plugin-sdk-optional)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Uninstall](#uninstall)
- [License](#license)

## Why DynAlloc

Most "gaming performance" tools on Linux are static and reactive: they set one governor, one set of tweaks, and leave it there whether you're compiling code, watching a video, or actually gaming — and they only respond *after* something has already gone wrong. DynAlloc reads real kernel pressure metrics (PSI) and *which window you're actually looking at* every tick, continuously reallocating CPU affinity, niceness, I/O class, GPU power, and (optionally) governor/cgroup limits between foreground and background work — automatically, per-process, with no per-game configuration. On top of that, v2.1 makes it **predictive**: it learns your habits and pre-allocates resources for the app it thinks you're about to open next, instead of waiting for you to open it and stutter for the first few seconds.

## Features

### Core scheduling
- **PSI-driven scheduling** — reads `/proc/pressure/cpu` and `/proc/pressure/memory` to react to real system stress instead of guessing from raw CPU%.
- **Smart foreground boosting** — detects the focused window across GNOME/Wayland (event-driven via the *Window Calls Extended* extension, no polling), KDE Plasma/Wayland (KWin D-Bus via `qdbus`), Hyprland (`hyprctl`), Sway (`swaymsg`), and X11 (`xdotool`) — **5 desktop environments** covered — then boosts its priority, CPU affinity, and I/O class in real time.
- **cgroups v2 + fallback** — uses cgroup delegation when available, falls back cleanly to `taskset` + `renice`/`ionice` when it isn't.
- **CPU governor coordination** — cooperates with `power-profiles-daemon` and Feral GameMode instead of fighting them; governor switching mutes itself automatically when PPD is already managing power state.
- **Workload classification** — recognizes games, IDEs, browsers, terminals, compilers, containers, VMs, Steam/Lutris/Wine/Proton processes, and more.
- **Hybrid CPU-topology aware** — detects Intel Hybrid P-core/E-core layouts and AMD CCD boundaries, and reserves foreground cores accordingly.
- **Multimedia protection** — auto-detects active audio/video playback (PipeWire/WirePlumber) and shields media players (Spotify, browser tabs, Discord voice) from performance hiccups caused by background load.
- **Safety first** — dry-run mode, automatic rollback of all changes on daemon exit, watchdog with auto-restart, thermal protection (pauses governor switching during thermal throttle), OOM protection for the foreground app.
- **Zero overhead when idle** — every advanced subsystem below is **off by default** and only loaded into memory when explicitly enabled; the core daemon behaves identically whether or not you ever touch the rest of this list.

### Extensibility
- **10 resource controllers** — CPU, memory, I/O, thermal, power, governor, network, GPU, power-budget arbiter, VRAM reclaim — behind one unified facade.
- **Plugin system** — built-in plugins for Steam, Discord, OBS, Spotify, browsers, system processes, wallpaper engines, multimedia, and KDE/Wayland, plus a versioned, permission-gated SDK for writing your own.
- **Policy Engine** — optional rule engine (AND/OR/NOT, priority, cooldown, delay, once) with hot-reloadable YAML/JSON config — no restart needed, changes apply in ~300ms.
- **Per-app profile overrides** — drop a JSON file per application in `~/.config/dynalloc/apps.d/` to force specific nice/IO/affinity values, overriding the automatic classifier for that app.
- **Learning mode** — the daemon logs every manual `boost`/`throttle` you issue; after enough occurrences it can suggest a Policy Engine rule to automate what you were doing by hand (`dynalloc learn --suggest`).

## Tier 1 Killer Features (v2.1.0)

Four new subsystems — all opt-in, all degrade gracefully without their hardware/dependency prerequisites, and (per the project's own changelog) not currently offered by any other Linux resource daemon (GameMode, system76-scheduler, ananicy, TLP, LACT, CoreCtrl included):

- **Predictive Pre-Allocation Engine** (`ENABLE_PREDICTIVE_ENGINE`) — uses the Learning Engine's observed foreground-transition history to predict the next app you're likely to launch (`P(next | current, hour, battery)`, no ML libraries) and pre-warms resources for it *before* you open it, eliminating the "first 5 seconds of stutter." Confidence-gated, auto-reverts if the prediction misses, cooldown-limited to avoid spam.
- **Per-App Energy Accounting via RAPL** (`ENABLE_ENERGY_ACCOUNTING`) — reads Intel/AMD RAPL energy counters and attributes joules to individual PIDs/cgroups by CPU time share, so you can see "Discord: 47 Wh this week, Blender: 312 Wh" instead of only a system-wide `powerstat` number.
- **CPU+GPU Shared Power Budget Arbiter** (`ENABLE_POWER_BUDGET_ARBITER`) — treats CPU and GPU as one shared power budget instead of two independently-managed silos; when total draw exceeds budget, decides who to throttle based on which one is actually the bottleneck (GPU-bound / CPU-bound / balanced), with hysteresis to prevent oscillation.
- **GPU VRAM Pressure Reclaim** (`ENABLE_VRAM_RECLAIM`) — when VRAM usage crosses a high watermark (default 92%) or a GPU-OOM signature shows up in `dmesg`, briefly `SIGSTOP`s the largest non-foreground VRAM consumers so the driver can reclaim memory — never kills, only pauses, with per-PID cooldown and a critical-process skip-list (compositors, audio servers, Steam itself, etc.).

New CLI: `dynalloc predict`, `dynalloc energy`, `dynalloc vram`, `dynalloc powerbudget`. Full design rationale, decision trees, and every config key in [`CHANGELOG.md`](CHANGELOG.md).

## Intelligence Subsystem (v2.0.0)

- **`dynalloc doctor`** — health-check reported as a score (EXCELLENT/GOOD/FAIR/POOR) with a per-item PASS/WARNING/ERROR breakdown, including granular foreground-detection tool diagnostics (tells you exactly which binary is missing for your desktop session).
- **`dynalloc report`** — generates a standalone HTML diagnostic report (system info, CPU/memory history, active subsystems) you can open in a browser or send to someone else for help debugging.
- **`dynalloc timeline`** — a filterable log of significant daemon events (by category, severity, keyword) for reconstructing "what happened right before things got laggy."
- **`dynalloc recommendations`** — the Learning Engine watches your usage patterns and surfaces actionable suggestions; **nothing is ever auto-applied** — you explicitly `--approve <id>` or `--dismiss <id>`.
- **`dynalloc explanations`** — every automatic decision the daemon makes (boost/throttle/policy match) is queryable with a structured explanation, so it's not a black box.

## Architecture

Core pipeline: **Sensor → Brain → Actuator**, with optional subsystems layered on top (all default OFF, zero overhead when disabled):

```
                    +-----------------------------+
                    |   dynalloc-daemon.js         |  <-- CLI / systemd --user service
                    +--------------+---------------+
                                   |
                    +--------------v---------------+
                    |          daemon.js            |  <-- Orchestrator loop
                    +--------------+---------------+
                                   |
    +---------------+--------------+--------------+---------------+
    |               |                             |               |
+---v---+       +---v---+                     +---v---+       +---v----+
|Config |       |Sensors|                     |Sched  |       |Actuator|
+-------+       +---+---+                     +---+---+       +---+----+
                    |                             |               |
            (PSI, focus, D-Bus,           (Hysteresis,     (cgroups v2,
           PipeWire, RAPL, temp)          Classification)  taskset, renice,
                                                             GPU profiles)

  User Events
       ↓
  Detector Layer               ← event-driven idle/power/workload detectors
       ↓
  Workload Recognition Engine  ← 14 categories, confidence scoring
       ↓
  Profile Manager              ← 9 built-in profiles, demand set, priority
       ↓
  Adaptive Switching Engine    ← debounce, cooldown, oscillation guard, rollback
       ↓
  Resource Controller          ← 10 controllers (cpu/mem/io/thermal/power/governor/
       ↓                          network/gpu/power-budget/vram), unified facade
  Operating System
       ↑
  Monitoring Framework         ← system monitor, diagnostics, health checks, benchmarks
       ↑
  Intelligence Layer           ← doctor, timeline, learning, recommendations,
       ↑                          explainability, predictive pre-allocation
  Plugin SDK                   ← stable versioned API, permissions, lifecycle, manifest
```

Every subsystem is independently toggleable in config, and enabling any subset never breaks the others — the daemon behaves identically to the minimal core build when everything optional is disabled. Full module dependency graph and per-tick data flow in [`Architecture.md`](Architecture.md); design rationale for major decisions in [`docs/adr/`](docs/adr).

## Requirements

- Linux with a 5.2+ kernel, PSI enabled (`CONFIG_PSI=y`, and `psi=1` on the kernel boot line if your distro ships it disabled — most modern distros including CachyOS, Arch, Fedora, Ubuntu 22.04+ enable it by default)
- Node.js ≥ 18
- systemd (runs as a `systemd --user` service — no root daemon required)

Optional, auto-detected if present (DynAlloc degrades gracefully without any of these):

| Tool | Used for |
|---|---|
| `cgroup-tools` | cgroups v2 management |
| `cpupower` | CPU governor switching |
| `xdotool` | X11 foreground detection |
| `hyprctl` / `swaymsg` | Hyprland / Sway foreground detection |
| `qdbus` / `kdotool` | KDE Plasma/Wayland foreground detection |
| `libnotify` | Desktop notifications |
| `power-profiles-daemon` | Power profile coordination |
| `gamemode` | Feral GameMode coexistence |
| `pipewire` / `wireplumber` | Multimedia workload detection |
| `nvidia-smi` / `intel_gpu_top` / `radeontop` | GPU utilization + VRAM reclaim candidate selection |
| Intel/AMD RAPL (`/sys/class/powercap/intel-rapl/`) | Per-app energy accounting |

## Installation

### Arch / CachyOS (recommended — proper package, tracked by pacman)

```bash
cd packaging/arch
makepkg -si
```

### Manual install (extract & copy directly)

If you'd rather not build a package — e.g. installing straight from a downloaded release zip, or upgrading an existing manual install in place — extract and copy everything straight to `/opt/dynalloc`:

```bash
# 1. Extract the source
unzip dynalloc-v2.1.0.zip -d ~/Downloads/
# (or: git clone <repo-url> ~/Downloads/dynalloc && cd ~/Downloads/dynalloc)

# 2. Stop the daemon first if you're upgrading an existing install
systemctl --user stop dynalloc.service

# 3. Copy everything to /opt/dynalloc (this brings ALL module folders —
#    detectors/, profiles/, adaptive/, recognition/, monitoring/, sdk/,
#    lib/, intelligence/ — along with the core files, in one shot)
sudo mkdir -p /opt/dynalloc
sudo cp -a ~/Downloads/dynalloc-v2.1.0/. /opt/dynalloc/
sudo chmod +x /opt/dynalloc/dynalloc-cli.js /opt/dynalloc/dynalloc-daemon.js

# 4. Symlink the CLI
sudo ln -sf /opt/dynalloc/dynalloc-cli.js /usr/local/bin/dynalloc
sudo ln -sf /opt/dynalloc/dynalloc-daemon.js /usr/local/bin/dynalloc-daemon

# 5. Install/refresh the systemd user unit
mkdir -p ~/.config/systemd/user
cp /opt/dynalloc/systemd/dynalloc.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 6. Set capabilities for non-root priority control (only needed once)
sudo setcap 'cap_sys_nice+ep' /usr/bin/renice /usr/bin/ionice
```

This is also the fastest way to pick up a single fixed/updated file without reinstalling everything — e.g. after pulling a fix, just `sudo cp <file> /opt/dynalloc/<file>` and `systemctl --user restart dynalloc.service`.

### Manual install (via `install.sh` or `make`)

Same result as the manual copy above, scripted:

```bash
./install.sh                       # installs to /opt/dynalloc
# or
./install.sh --prefix ~/.local/dynalloc
# or, using the packaging Makefile:
make -C packaging install
```

### Debian / Ubuntu

```bash
make -C packaging deb
sudo dpkg -i packaging/build/deb/*.deb
# or, without make:
cd packaging/debian && dpkg-buildpackage -us -uc -b && sudo apt install ../dynalloc_*.deb
```

### Fedora / RHEL / openSUSE

```bash
make -C packaging rpm
sudo dnf install packaging/build/rpmbuild/RPMS/noarch/*.rpm
# or, without make:
rpmbuild -bb packaging/rpm/dynalloc.spec && sudo dnf install ~/rpmbuild/RPMS/noarch/dynalloc-*.rpm
```

### After installing (any method)

```bash
systemctl --user daemon-reload
systemctl --user enable --now dynalloc.service
dynalloc doctor
```

A full step-by-step Indonesian-language install walkthrough (including how to turn on each v2.1.0 Tier 1 feature) is in [`installation.md`](installation.md).

`dynalloc doctor` runs a full health check and reports it as a score:

```
DynAlloc Doctor
============================================================
Health Score:          94% (EXCELLENT)
Summary:                All core subsystems operational

  ✓ Daemon                              running (PID 61121, uptime 7s)
  ✓ PSI (CPU)                           ok
  ✓ PSI (Memory)                        ok
  ✓ Cgroups v2                          ok
  ✓ D-Bus Session                       Desktop environment detected: GNOME/Wayland
  ✓ Foreground tool: gdbus              GNOME Shell DBus available
  ✓ Permissions: renice                 ok
  ✓ Permissions: ionice                 ok

  Result: 12 PASS, 1 WARNING, 0 ERROR
============================================================
```

## Usage

```bash
dynalloc status                       # current daemon state
dynalloc status --json | jq .stressLevel
dynalloc stats                        # full metrics report (latencies, counters, gauges)
dynalloc watch                        # live ANSI dashboard (Ctrl+C to exit)
dynalloc doctor                       # health check / diagnostics (health score)
dynalloc report                       # generate a shareable HTML diagnostic report
dynalloc timeline                     # browse significant daemon events
dynalloc recommendations              # view/approve/dismiss learned suggestions
dynalloc explanations                 # why did the daemon make decision X?
dynalloc predict [--top]              # predictive pre-allocation status
dynalloc energy [--apps] [--history]  # per-app energy accounting (RAPL)
dynalloc vram [--force-release]       # GPU VRAM reclaim status
dynalloc powerbudget [--force-release] # CPU+GPU power budget arbiter status
dynalloc boost <pid>                  # manually boost a process
dynalloc throttle <pid>               # manually throttle a process
dynalloc restore <pid>                # restore a process to default
dynalloc throttled                    # list currently throttled processes
dynalloc network                      # network QoS status (if ENABLE_NETWORK_QOS=true)
dynalloc help                         # full command reference
```

`dynalloc watch` shows a live, ANSI-colored dashboard refreshing every second — CPU/memory usage, scheduler stress level, governor, foreground process, boosted/throttled processes, loaded plugins, and recent events:

```bash
dynalloc watch                          # default: 1s refresh
dynalloc watch --refresh 500            # refresh every 500ms
dynalloc watch --width 120              # wider layout
```

Live logs:

```bash
journalctl --user -u dynalloc.service -f
```

Every command supports `--json` for scripting, `--socket <path>` to target a specific instance, and `--timeout <ms>`. Full reference: `dynalloc help`.

### Running manually (development)

```bash
DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js     # safely prints actions, changes nothing
sudo node dynalloc-daemon.js                    # run with real system modifications
```

## Configuration

DynAlloc works out of the box with zero configuration. To customize it:

```bash
mkdir -p ~/.config/dynalloc
cp dynalloc.config.example.json ~/.config/dynalloc/config.json
```

A few of the most commonly tuned options:

```jsonc
{
  "DRY_RUN": false,
  "LOG_LEVEL": "info",
  "FAST_TICK_MS": 1000,             // PSI polling interval
  "SLOW_TICK_MS": 3000,             // foreground detection + process scan interval
  "PSI_CPU_WARN": 8.0,              // % PSI avg10 that triggers a stress state change
  "PSI_CPU_CRITICAL": 20.0,
  "ENABLE_CGROUPS_V2": true,
  "FOREGROUND_CORE_RESERVE": null,  // null = auto (50% of cores); ignored on Hybrid CPUs
  "HEAVY_BG_PATTERNS": ["^(cc1|cc1plus|ld|rustc|clang|gcc)$", "(chrome|firefox|brave)"],
  "CRITICAL_PROCESS_PATTERNS": ["^(gnome-shell|mutter)$", "^(pipewire|wireplumber)$"]
}
```

Every v2.1.0 Tier 1 feature has its own `ENABLE_*` master switch plus tuning keys — see [`CHANGELOG.md`](CHANGELOG.md#new-configuration-keys) for the full table (prediction confidence/hold/cooldown, RAPL sampling interval, power budget watts/hysteresis, VRAM watermarks/hold/cooldown).

Most keys are **hot-reloadable** — edit the file, save, and changes apply without restarting the daemon. See [`Configuration.md`](Configuration.md) for the complete, annotated list of every option.

## Policy Engine (optional)

For rule-based automation beyond the built-in scheduler, enable the Policy Engine and drop a YAML or JSON file at `~/.config/dynalloc/policies.yaml`:

```yaml
profiles:
  gaming:
    governor: performance
    governorCores: foreground
    schedulerMode: aggressive
    foregroundBoost: true

  powersave:
    governor: powersave
    governorCores: all
    schedulerMode: conservative
    foregroundBoost: false
```

v2.1.0 adds new action types for the Tier 1 features: `setPowerBudget` (release/engage/set-budget), `reclaimVram` (release/status), and `preAllocate` (informational). Hot-reload is active by default — changes take effect within ~300ms, no daemon restart. Full rule syntax (AND/OR/NOT, priority, cooldown, delay, once) in [`PolicyEngine.md`](PolicyEngine.md).

## Plugin SDK (optional)

Third-party plugins get a stable, versioned, permission-gated API (`ENABLE_PLUGIN_SDK: true`) — read config/metrics/diagnostics, subscribe to the event bus, register custom detectors/profiles/controllers/rules/CLI commands. Every plugin call is sandboxed: a failing plugin gets disabled, not the daemon. Built-in plugins you can use as reference: Steam, Discord, OBS, Spotify, browser, system, wallpaper, multimedia, KDE/Wayland. See [`Plugin.md`](Plugin.md) and [`sdk/plugin-template.js`](sdk/plugin-template.js) for a starting point.

## Documentation

| Doc | Covers |
|---|---|
| [`installation.md`](installation.md) | Full step-by-step install guide (Indonesian), including v2.1.0 Tier 1 feature setup |
| [`Architecture.md`](Architecture.md) | Module layout, dependency graph, per-tick data flow |
| [`Configuration.md`](Configuration.md) | Every config option, explained |
| [`PolicyEngine.md`](PolicyEngine.md) | Writing custom rules (YAML/JSON) |
| [`Plugin.md`](Plugin.md) | Plugin SDK reference |
| [`Scheduler.md`](Scheduler.md) | How scheduling decisions are made |
| [`AdaptiveSwitching.md`](AdaptiveSwitching.md) | Debounce/cooldown/rollback logic |
| [`WorkloadRecognition.md`](WorkloadRecognition.md) | The 14-category classifier + confidence scoring |
| [`ProfileManager.md`](ProfileManager.md) | Built-in profiles and demand-set resolution |
| [`Testing.md`](Testing.md) | Running the test suite |
| [`Troubleshooting.md`](Troubleshooting.md) | Common issues and fixes |
| [`Performance.md`](Performance.md) | Overhead benchmarks |
| [`docs/adr/`](docs/adr) | Architecture Decision Records |
| [`CHANGELOG.md`](CHANGELOG.md) | Full release history, including complete v2.1.0 Tier 1 design docs |

## Troubleshooting

**Service doesn't start automatically on boot, needs `systemctl restart` manually** — usually a race between the daemon starting and your desktop's D-Bus session (or, on GNOME, the "Window Calls Extended" extension) becoming ready. The bundled [`systemd/dynalloc.service`](systemd/dynalloc.service) already waits for this on GNOME; if you're on another desktop and hit this, see [`Troubleshooting.md`](Troubleshooting.md).

**`dynalloc doctor` shows a permissions warning** — `renice`/`ionice` need `CAP_SYS_NICE` to raise priority as a non-root user. The install scripts set this automatically via `setcap`; if it's missing:
```bash
sudo setcap 'cap_sys_nice+ep' /usr/bin/renice /usr/bin/ionice
```

**Governor switching needs sudo** — set `GOVERNOR_USE_SUDO: true` in your config and add a sudoers rule for `cpupower`, or leave governor switching off (it's optional; `power-profiles-daemon` coordination covers most cases without it).

**Cgroup write failed / no delegation** — add `Delegate=cpu` to `/etc/systemd/system/user@.service.d/delegate.conf` and re-login. DynAlloc works fine without this via the `taskset`/`renice` fallback, just with slightly coarser control.

**Energy accounting shows no data** — RAPL requires either root or read access to `/sys/class/powercap/intel-rapl/*/energy_uj`; some distros restrict this by default. Check with `cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj`.

**VRAM reclaim / power budget arbiter do nothing** — both require a supported GPU vendor tool (`nvidia-smi`, `intel_gpu_top`, or `radeontop`) to be installed and on `PATH`; check `dynalloc doctor` for GPU detection status.

More in [`Troubleshooting.md`](Troubleshooting.md).

## Development

```bash
npm test                    # unit + integration tests
npm run test:unit           # unit tests only
npm run syntax-check        # node --check across every module
npm run verify:all          # all verify-*.js safety/behavior assertions
bash scripts/ci-check.sh    # everything CI runs, locally, in one command
DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js   # run without touching the system
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs syntax checks, the full unit + integration suite, all verify scripts, config validation, and a dry-run boot check on every push and PR.

## Uninstall

```bash
./uninstall.sh
# or
make -C packaging uninstall
```

## License

MIT — see [`LICENSE`](LICENSE).
