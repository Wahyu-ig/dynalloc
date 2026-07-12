# DynAlloc

**Adaptive Linux resource manager** — dynamic CPU/IO/memory priority based on PSI (Pressure Stall Information), cgroups v2, and foreground window detection (GNOME/Wayland, X11, Hyprland, Sway).

DynAlloc watches whatever app is currently focused and automatically boosts it (CPU affinity, niceness, I/O priority) while quietly deprioritizing everything running in the background — no manual tuning, no game-specific profiles to maintain.

```
✓ Foreground app          → boosted priority, dedicated cores, low-latency I/O
✓ Background apps         → deprioritized, throttled, kept out of the way
✓ System under pressure   → adapts automatically via PSI, backs off before it gets bad
✓ Zero config required    → sensible defaults, everything else is opt-in
```

---

## Features

- **PSI-driven scheduling** — reads `/proc/pressure/cpu` and `/proc/pressure/memory` to react to real system stress instead of guessing from CPU%.
- **Foreground-aware boosting** — detects the focused window across GNOME/Wayland (event-driven via the *Window Calls Extended* extension), X11 (`xdotool`), Hyprland (`hyprctl`), and Sway (`swaymsg`), then boosts its priority, CPU affinity, and I/O class in real time.
- **cgroups v2 + fallback** — uses cgroup delegation when available, falls back to `taskset` + `renice`/`ionice` when it isn't.
- **CPU governor coordination** — cooperates with `power-profiles-daemon` and Feral GameMode instead of fighting them.
- **Workload classification** — recognizes games, IDEs, browsers, terminals, compilers, containers, VMs, Steam/Lutris/Wine/Proton processes, and more, and schedules each class appropriately.
- **Plugin system** — built-in plugins for Steam, Discord, OBS, Spotify, browsers, and system processes, plus an SDK for writing your own.
- **Policy Engine** — optional rule engine (AND/OR/NOT, priority, cooldown, delay, hot-reloadable YAML/JSON config) for custom automation.
- **Safety first** — dry-run mode, automatic rollback on daemon exit, watchdog with auto-restart, thermal protection, OOM protection for the foreground app.
- **Zero overhead when idle** — every advanced subsystem (detector layer, adaptive switching, workload recognition, monitoring framework, plugin SDK) is off by default and only loaded when explicitly enabled.

## Requirements

- Linux with a 5.x+ kernel (PSI support: `CONFIG_PSI=y`)
- Node.js ≥ 18
- systemd (runs as a `systemd --user` service)

Optional, detected automatically if present: `cgroup-tools`, `cpupower`, `xdotool`, `libnotify`, `power-profiles-daemon`, `gamemode`, `pipewire`/`wireplumber`, `sway`/`hyprland`.

## Installation

### Arch / CachyOS (recommended)

```bash
cd packaging/arch
makepkg -si
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

### Manual install

```bash
./install.sh                       # installs to /opt/dynalloc
# or
./install.sh --prefix ~/.local/dynalloc
```

### After installing (any method)

```bash
systemctl --user daemon-reload
systemctl --user enable --now dynalloc.service
dynalloc doctor
```

## Usage

```bash
dynalloc status                       # current daemon state
dynalloc status --json | jq .stressLevel
dynalloc stats                        # full metrics report
dynalloc doctor                       # health check / diagnostics
dynalloc boost <pid>                  # manually boost a process
dynalloc throttle <pid>               # manually throttle a process
dynalloc restore <pid>                # restore a process to default
dynalloc throttled                    # list currently throttled processes
dynalloc help                         # full command reference
```

Live logs:

```bash
journalctl --user -u dynalloc.service -f
```

## Configuration

DynAlloc works out of the box with zero configuration. To customize it, copy the example config and edit it:

```bash
mkdir -p ~/.config/dynalloc
cp /etc/dynalloc/config.json.example ~/.config/dynalloc/config.json
```

See [`Configuration.md`](Configuration.md) for the full list of options, and [`PolicyEngine.md`](PolicyEngine.md) if you want to write custom automation rules.

## Documentation

| Doc | Covers |
|---|---|
| [`Architecture.md`](Architecture.md) | Module layout, data flow, design decisions |
| [`Configuration.md`](Configuration.md) | Every config option, explained |
| [`PolicyEngine.md`](PolicyEngine.md) | Writing custom rules (YAML/JSON) |
| [`Plugin.md`](Plugin.md) | Plugin SDK reference |
| [`Scheduler.md`](Scheduler.md) | How scheduling decisions are made |
| [`Testing.md`](Testing.md) | Running the test suite |
| [`Troubleshooting.md`](Troubleshooting.md) | Common issues and fixes |
| [`Performance.md`](Performance.md) | Overhead benchmarks |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## Development

```bash
npm test              # unit + integration tests
npm run verify:all    # all verify-*.js safety/behavior checks
bash scripts/ci-check.sh   # everything CI runs, locally
DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js   # run without touching the system
```

## Uninstall

```bash
./uninstall.sh
```

## License

MIT — see [`LICENSE`](LICENSE).
