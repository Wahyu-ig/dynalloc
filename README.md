# DynAlloc

**Adaptive Linux resource manager** — dynamic CPU/IO/memory priority based on PSI (Pressure Stall Information), cgroups v2, and foreground window detection (GNOME/Wayland, X11, Hyprland, Sway).

DynAlloc watches whatever app is currently focused and automatically boosts it (CPU affinity, niceness, I/O priority) while quietly deprioritizing everything running in the background — no manual tuning, no game-specific profiles to maintain.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-linux-blue)
![License](https://img.shields.io/badge/license-MIT-informational)
![Tests](https://img.shields.io/badge/tests-817%20passing-success)

```
✓ Foreground app          → boosted priority, dedicated cores, low-latency I/O
✓ Background apps         → deprioritized, throttled, kept out of the way
✓ System under pressure   → adapts automatically via PSI, backs off before it gets bad
✓ Zero config required    → sensible defaults, everything else is opt-in
```

---

## Table of contents

- [Why DynAlloc](#why-dynalloc)
- [Features](#features)
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

Most "gaming performance" tools on Linux are static: they set one governor, one set of tweaks, and leave it there whether you're compiling code, watching a video, or actually gaming. DynAlloc instead reads real kernel pressure metrics (PSI) and *which window you're actually looking at* every tick, and continuously reallocates CPU affinity, niceness, I/O class, and (optionally) governor/cgroup limits between foreground and background work — automatically, per-process, with no per-game configuration.

## Features

- **PSI-driven scheduling** — reads `/proc/pressure/cpu` and `/proc/pressure/memory` to react to real system stress instead of guessing from raw CPU%.
- **Foreground-aware boosting** — detects the focused window across GNOME/Wayland (event-driven via the *Window Calls Extended* extension, no polling), X11 (`xdotool`), Hyprland (`hyprctl`), and Sway (`swaymsg`), then boosts its priority, CPU affinity, and I/O class in real time.
- **cgroups v2 + fallback** — uses cgroup delegation when available, falls back cleanly to `taskset` + `renice`/`ionice` when it isn't.
- **CPU governor coordination** — cooperates with `power-profiles-daemon` and Feral GameMode instead of fighting them; governor switching mutes itself automatically when PPD is already managing power state.
- **Workload classification** — recognizes games, IDEs, browsers, terminals, compilers, containers, VMs, Steam/Lutris/Wine/Proton processes, and more, and schedules each class appropriately (see [`classifier.js`](classifier.js)).
- **Plugin system** — built-in plugins for Steam, Discord, OBS, Spotify, browsers, and system processes, plus an SDK for writing your own (permissions, lifecycle, manifest validation).
- **Policy Engine** — optional rule engine (AND/OR/NOT, priority, cooldown, delay, once) with hot-reloadable YAML/JSON config — no restart needed, changes apply in ~300ms.
- **CPU topology aware** — detects Intel Hybrid P-core/E-core layouts and AMD CCDs, and reserves foreground cores accordingly.
- **Safety first** — dry-run mode, automatic rollback of all changes on daemon exit, watchdog with auto-restart, thermal protection (pauses governor switching during thermal throttle), OOM protection for the foreground app.
- **Zero overhead when idle** — every advanced subsystem (detector layer, resource controller layer, profile manager, adaptive switching, workload recognition, monitoring framework, plugin SDK) is **off by default** and only loaded into memory when explicitly enabled.

## Architecture

Core pipeline: **Sensor → Brain → Actuator**, plus 8 optional subsystems layered on top (all default OFF, zero overhead when disabled):

```
  User Events
       ↓
  Detector Layer               ← 3 detectors, event-driven
       ↓
  Workload Recognition Engine  ← 14 categories, confidence scoring
       ↓
  Profile Manager              ← 9 built-in profiles, demand set, priority
       ↓
  Adaptive Switching Engine    ← debounce, cooldown, oscillation guard, rollback
       ↓
  Resource Controller          ← 7 controllers (cpu/mem/io/thermal/power/governor/network), unified facade
       ↓
  Operating System
       ↑
  Monitoring Framework         ← system monitor, diagnostics, health checks, benchmarks
       ↑
  Plugin SDK                   ← stable versioned API, permissions, lifecycle, manifest
```

Every subsystem is independently toggleable in config, and enabling any subset never breaks the others — the daemon behaves identically to the minimal core build when everything optional is disabled. Full module dependency graph and per-tick data flow in [`Architecture.md`](Architecture.md).

## Requirements

- Linux with a 5.x+ kernel (PSI support: `CONFIG_PSI=y`, enabled by default on most modern distros including CachyOS, Arch, Fedora, Ubuntu 22.04+)
- Node.js ≥ 18
- systemd (runs as a `systemd --user` service — no root daemon required)

Optional, auto-detected if present (DynAlloc degrades gracefully without any of these):

| Tool | Used for |
|---|---|
| `cgroup-tools` | cgroups v2 management |
| `cpupower` | CPU governor switching |
| `xdotool` | X11 foreground detection |
| `hyprctl` / `swaymsg` | Hyprland / Sway foreground detection |
| `libnotify` | Desktop notifications |
| `power-profiles-daemon` | Power profile coordination |
| `gamemode` | Feral GameMode coexistence |
| `pipewire` / `wireplumber` | Multimedia workload detection |

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
unzip dynalloc-v1.0.0.zip -d ~/Downloads/
# (or: git clone <repo-url> ~/Downloads/dynalloc && cd ~/Downloads/dynalloc)

# 2. Stop the daemon first if you're upgrading an existing install
systemctl --user stop dynalloc.service

# 3. Copy everything to /opt/dynalloc (this brings ALL module folders —
#    detectors/, profiles/, adaptive/, recognition/, monitoring/, sdk/,
#    lib/ — along with the core files, in one shot)
sudo mkdir -p /opt/dynalloc
sudo cp -a ~/Downloads/dylok/. /opt/dynalloc/
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

### Manual install (via `install.sh`)

Same result as the manual copy above, scripted:

```bash
./install.sh                       # installs to /opt/dynalloc
# or
./install.sh --prefix ~/.local/dynalloc
```

### Debian / Ubuntu

```bash
cd packaging/debian
dpkg-buildpackage -us -uc -b
sudo apt install ../dynalloc_*.deb
```

### Fedora / openSUSE

```bash
rpmbuild -bb packaging/rpm/dynalloc.spec
sudo dnf install ~/rpmbuild/RPMS/noarch/dynalloc-*.rpm
```

### After installing (any method)

```bash
systemctl --user daemon-reload
systemctl --user enable --now dynalloc.service
dynalloc doctor
```

`dynalloc doctor` runs a full health check — it tells you exactly what's available on your system (PSI, cgroups, governor, foreground detection method, permissions) and what's missing:

```
DynAlloc Doctor
============================================================
Daemon:                 ✓ running (PID 61121, uptime 7s)
PSI (CPU):              ✓ ok
PSI (Memory):           ✓ ok
Cgroups v2:              ✓ ok
cpufreq:                ✓ ok
Foreground tools:
  gdbus      ✓ GNOME Shell DBus
Permissions:
  renice:   ✓
  ionice:   ✓
Capabilities: PSI, CGROUPS_V2, CPUFREQ, GOVERNOR_SWITCH, GNOME_WAYLAND
============================================================
Result: ✓ All checks passed
```

## Usage

```bash
dynalloc status                       # current daemon state
dynalloc status --json | jq .stressLevel
dynalloc stats                        # full metrics report (latencies, counters, gauges)
dynalloc doctor                       # health check / diagnostics
dynalloc boost <pid>                  # manually boost a process
dynalloc throttle <pid>               # manually throttle a process
dynalloc restore <pid>                # restore a process to default
dynalloc throttled                    # list currently throttled processes
dynalloc network                      # network QoS status (if ENABLE_NETWORK_QOS=true)
dynalloc help                         # full command reference
```

Live logs:

```bash
journalctl --user -u dynalloc.service -f
```

Every command supports `--json` for scripting, `--socket <path>` to target a specific instance, and `--timeout <ms>`. Full reference: `dynalloc help`.

## Configuration

DynAlloc works out of the box with zero configuration. To customize it:

```bash
mkdir -p ~/.config/dynalloc
cp /etc/dynalloc/config.json.example ~/.config/dynalloc/config.json
```

A few of the most commonly tuned options:

```jsonc
{
  "FAST_TICK_MS": 1000,           // PSI polling interval
  "SLOW_TICK_MS": 3000,           // foreground detection + process scan interval
  "PSI_CPU_WARN": 8.0,            // % PSI avg10 that triggers a stress state change
  "PSI_CPU_CRITICAL": 20.0,
  "FOREGROUND_CORE_RESERVE": null, // null = auto (50% of cores); ignored on Hybrid CPUs
  "HEAVY_BG_PATTERNS": ["^(cc1|cc1plus|ld|rustc|clang|gcc)$", "(chrome|firefox|brave)"],
  "CRITICAL_PROCESS_PATTERNS": ["^(gnome-shell|mutter)$", "^(pipewire|wireplumber)$"]
}
```

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

Hot-reload is active by default — changes take effect within ~300ms, no daemon restart. Full rule syntax (AND/OR/NOT, priority, cooldown, delay, once) in [`PolicyEngine.md`](PolicyEngine.md).

## Plugin SDK (optional)

Third-party plugins get a stable, versioned, permission-gated API (`ENABLE_PLUGIN_SDK: true`) — read config/metrics/diagnostics, subscribe to the event bus, register custom detectors/profiles/controllers/rules/CLI commands. Every plugin call is sandboxed: a failing plugin gets disabled, not the daemon. See [`Plugin.md`](Plugin.md) and [`sdk/plugin-template.js`](sdk/plugin-template.js) for a starting point.

## Documentation

| Doc | Covers |
|---|---|
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
| [`CHANGELOG.md`](CHANGELOG.md) | Full release history |

## Troubleshooting

**Service doesn't start automatically on boot, needs `systemctl restart` manually** — usually a race between the daemon starting and your desktop's D-Bus session (or, on GNOME, the "Window Calls Extended" extension) becoming ready. The bundled [`systemd/dynalloc.service`](systemd/dynalloc.service) already waits for this on GNOME; if you're on another desktop and hit this, see [`Troubleshooting.md`](Troubleshooting.md).

**`dynalloc doctor` shows a permissions warning** — `renice`/`ionice` need `CAP_SYS_NICE` to raise priority as a non-root user. The install scripts set this automatically via `setcap`; if it's missing:
```bash
sudo setcap 'cap_sys_nice+ep' /usr/bin/renice /usr/bin/ionice
```

**Governor switching needs sudo** — set `GOVERNOR_USE_SUDO: true` in your config and add a sudoers rule for `cpupower`, or leave governor switching off (it's optional; `power-profiles-daemon` coordination covers most cases without it).

**Cgroup write failed / no delegation** — add `Delegate=cpu` to `/etc/systemd/system/user@.service.d/delegate.conf` and re-login. DynAlloc works fine without this via the `taskset`/`renice` fallback, just with slightly coarser control.

More in [`Troubleshooting.md`](Troubleshooting.md).

## Development

```bash
npm test                    # unit + integration tests (817 tests)
npm run verify:all          # all verify-*.js safety/behavior assertions (513 checks)
bash scripts/ci-check.sh    # everything CI runs, locally, in one command
DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js   # run without touching the system
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs syntax checks, the full unit + integration suite across Node 18/20/22/24, all verify scripts, config validation, and a dry-run boot check on every push and PR.

## Uninstall

```bash
./uninstall.sh
```

## License

MIT — see [`LICENSE`](LICENSE).
