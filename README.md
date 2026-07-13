# DynAlloc 🚀

> **AI-Powered Adaptive Linux Resource Manager**  
> A lightweight daemon for dynamic CPU core pinning, priority scheduling, and resource QoS (CPU/Memory/IO/Network) based on system pressure (PSI) and active workload detection.

---

## 🌟 Key Features

* **Pressure-Aware Scheduling:** Real-time PSI (Pressure Stall Information) monitoring to dynamically adapt CPU core pinning, scheduling class, and niceness values.
* **Smart Foreground Boosting:** Instant prioritization (using D-Bus GNOME Shell monitor, Hyprland socket, or X11 xdotool fallback) to give the active window lowest scheduling latency and maximum resource budget.
* **Resource Controller (cgroups v2):** Restricts background or heavy compilation tasks dynamically via memory limits, IO throttle rates, and CPU weights.
* **Multimedia Protection:** Auto-detects active audio/video playback (monitoring PipeWire/PulseAudio) and shields media players (like Spotify, browser tabs, or discord voice) from performance hiccups.
* **Modular Plugin SDK:** Easily add custom behavior or application-specific resource rules with simple, sandboxed JavaScript plugins.
* **Hybrid CPU-Topology Aware:** Optimizes core placement for SMT/Hyperthreading, AMD CCD boundaries, and Intel Hybrid (P-Core/E-Core) layouts.

---

## 🛠️ System Architecture

DynAlloc runs as a background daemon process, polling lightweight kernel pressure metrics (`/proc/pressure/cpu` and `/proc/pressure/memory`) to compute system stress levels (`NORMAL`, `WARN`, `CRITICAL`).

```
                    +-----------------------------+
                    |   dynalloc-daemon.js        |  <-- CLI/Systemd Service
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    |          daemon.js          |  <-- Orchestrator Loop
                    +--------------+--------------+
                                   |
    +---------------+--------------+--------------+---------------+
    |               |                             |               |
+---v---+       +---v---+                     +---v---+       +---v---+
|Config |       |Sensors|                     |Sched  |       |Actuat |
+-------+       +---+---+                     +---+---+       +---+---+
                    |                             |               |
            (PSI, Focus, D-Bus,             (Hysteresis,    (cgroups v2,
              PipeWire, Temp)              Classification)   taskset, renice)
```

For more deep-dive design details, read [Architecture.md](Architecture.md) and [Scheduler.md](Scheduler.md).

---

## 📦 Installation & Setup

### Requirements
* **OS:** Linux Kernel >= 5.2 (with PSI enabled: `psi=1` in boot options)
* **Runtime:** Node.js >= 18.0.0
* **Dependencies (optional):** `cgroup-tools` (cgroups v2 support), `xdotool` (X11 focus detection), `gdbus` (GNOME Wayland support), `hyprland` (Hyprland focus support).

### 1. Build and Install via OS Packages

DynAlloc contains pre-configured files to build native packages:

* **Arch Linux / AUR:**
  ```bash
  cd packaging/arch
  makepkg -si
  ```
* **Debian / Ubuntu:**
  ```bash
  make -C packaging deb
  sudo dpkg -i packaging/build/deb/*.deb
  ```
* **Fedora / RHEL:**
  ```bash
  make -C packaging rpm
  sudo dnf install packaging/build/rpmbuild/RPMS/noarch/*.rpm
  ```

### 2. Manual Installation
Alternatively, install manually to `/opt/dynalloc` using the bundle script:
```bash
sudo ./install.sh
```

---

## 🚀 How to Run

### Managing the Service (Systemd User Service)
By default, the package installs a systemd user unit:

```bash
# Enable and start the daemon
systemctl --user enable --now dynalloc

# Check status and logs
systemctl --user status dynalloc
```

### Running Manually (for development)
Run the daemon in dry-run mode (safely prints actions without modifying cgroups or process priorities):
```bash
DYNALLOC_DRY_RUN=1 node dynalloc-daemon.js
```

To run and apply actual system modifications:
```bash
sudo node dynalloc-daemon.js
```

### Using the CLI

The `dynalloc` CLI talks to the daemon over a Unix socket. Common commands:

```bash
dynalloc status              # Show current daemon state
dynalloc stats               # Full metrics report
dynalloc throttled           # List throttled processes
dynalloc boost <pid>         # Manually boost a process
dynalloc throttle <pid>      # Manually throttle a process
dynalloc restore <pid>       # Restore a process to defaults
dynalloc doctor              # Run health diagnostics
dynalloc watch               # Live dashboard (Ctrl+C to exit)
```

The `dynalloc watch` command (new in v1.1.0) shows a live, ANSI-colored
dashboard that refreshes every second. It displays CPU/memory usage,
scheduler stress level, current governor, foreground process, boosted
and throttled processes, loaded plugins, and recent events. Use
`--refresh <ms>` to change the refresh interval and `--width <cols>`
to override the terminal width.

```bash
dynalloc watch                          # default: 1s refresh
dynalloc watch --refresh 500            # refresh every 500ms
dynalloc watch --width 120              # wider layout
```

---

## ⚙️ Configuration & Policies

DynAlloc looks for configuration at `/etc/dynalloc/config.json` or `~/.config/dynalloc/config.json`.

Example configuration snippet:
```json
{
  "DRY_RUN": false,
  "LOG_LEVEL": "info",
  "FAST_TICK_MS": 1000,
  "SLOW_TICK_MS": 3000,
  "PSI_CPU_WARN": 8.0,
  "PSI_CPU_CRITICAL": 20.0,
  "ENABLE_CGROUPS_V2": true
}
```

Learn more about config properties in [Configuration.md](Configuration.md) and engine rule writing in [PolicyEngine.md](PolicyEngine.md).

---

## 🧪 Testing

DynAlloc has a thorough test suite verifying daemon logic, scheduling state transition, parsing, and resource limits.

```bash
# Run all unit and integration tests
npm test

# Run only unit tests
npm run test:unit

# Verify all scripts and packaging integrity
npm run verify:all
node scripts/verify-packaging.js
```

---

## 📄 License
This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
