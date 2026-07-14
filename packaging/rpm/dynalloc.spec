# RPM spec file for DynAlloc
# Build: rpmbuild -ba dynalloc.spec
# Install: sudo dnf install dynalloc-2.1.0-1.noarch.rpm

Name:           dynalloc
Version:        2.1.0
Release:        1%{?dist}
Summary:        AI-Powered Adaptive Linux Resource Manager

License:        MIT
URL:            https://github.com/Wahyu-ig/dynalloc
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch
Requires:       nodejs >= 18.0.0
Requires:       procps-ng
Requires:       util-linux
Requires:       cgroup-tools
Recommends:     gdbus
Recommends:     kernel-tools
Recommends:     xdotool
Recommends:     libnotify
Suggests:       power-profiles-daemon
Suggests:       gamemode
Suggests:       pipewire
Suggests:       wireplumber

%description
DynAlloc is a lightweight daemon that monitors PSI (Pressure Stall Information)
and dynamically manages CPU affinity, niceness, I/O priority, cgroups v2,
CPU governor, OOM score, and memory/IO limits based on active workload detection.

Key features:
  * Multi-level scheduler (Realtime/Interactive/Multimedia/Background/Idle)
  * Process classifier (Game, Browser, IDE, Compiler, Media, etc.)
  * Multimedia detector (PipeWire, PulseAudio, media players)
  * CPU topology awareness (SMT, NUMA, Intel Hybrid, AMD CCD)
  * Hysteresis + adaptive scoring (CPU, memory, foreground, media, battery, thermal)
  * Memory & IO cgroup limits (protect foreground from background OOM)
  * PID reuse protection via start-time validation
  * PPD coordination (no conflict with power-profiles-daemon)
  * Thermal-aware boosting (prevent thermal throttle death spiral)
  * Universal foreground detection (GNOME/KDE/Hyprland/Sway/X11)
  * Intelligence subsystem (learning, recommendations, explainability, timeline)
  * Predictive pre-allocation engine ("Crystal Ball")
  * Per-app energy accounting via RAPL (Intel/AMD)
  * CPU+GPU shared power budget arbiter
  * GPU VRAM pressure reclaim controller
  * Plugin system (browser, game, spotify, discord, obs, steam, wallpaper)
  * Policy engine (JSON/YAML rules with event-driven actions)
  * Hot-reload config without restart
  * Safe rollback + crash recovery
  * CLI tool for status/control (`dynalloc status`, `dynalloc boost <pid>`)

%prep
%setup -q

%build
# No build step — Node.js is interpreted

%install
# Install to /opt/dynalloc
mkdir -p %{buildroot}/opt/dynalloc/policy-engine
mkdir -p %{buildroot}/opt/dynalloc/plugins
mkdir -p %{buildroot}/opt/dynalloc/systemd
mkdir -p %{buildroot}/opt/dynalloc/detectors
mkdir -p %{buildroot}/opt/dynalloc/profiles
mkdir -p %{buildroot}/opt/dynalloc/adaptive
mkdir -p %{buildroot}/opt/dynalloc/recognition
mkdir -p %{buildroot}/opt/dynalloc/monitoring
mkdir -p %{buildroot}/opt/dynalloc/sdk
mkdir -p %{buildroot}/opt/dynalloc/intelligence
mkdir -p %{buildroot}/opt/dynalloc/lib/controllers
mkdir -p %{buildroot}/etc/dynalloc

# Copy all root-level files
cp -a *.js %{buildroot}/opt/dynalloc/
cp -a *.json %{buildroot}/opt/dynalloc/
cp -a *.sh %{buildroot}/opt/dynalloc/

# Copy all subdirectory files
cp -a policy-engine/*.js %{buildroot}/opt/dynalloc/policy-engine/
cp -a plugins/*.js %{buildroot}/opt/dynalloc/plugins/
cp -a detectors/*.js %{buildroot}/opt/dynalloc/detectors/
cp -a profiles/*.js %{buildroot}/opt/dynalloc/profiles/
cp -a adaptive/*.js %{buildroot}/opt/dynalloc/adaptive/
cp -a recognition/*.js %{buildroot}/opt/dynalloc/recognition/
cp -a monitoring/*.js %{buildroot}/opt/dynalloc/monitoring/
cp -a sdk/*.js %{buildroot}/opt/dynalloc/sdk/
cp -a intelligence/*.js %{buildroot}/opt/dynalloc/intelligence/
cp -a lib/*.js %{buildroot}/opt/dynalloc/lib/
cp -a lib/controllers/*.js %{buildroot}/opt/dynalloc/lib/controllers/
cp -a systemd/* %{buildroot}/opt/dynalloc/systemd/
cp -a *.md %{buildroot}/opt/dynalloc/ 2>/dev/null || true

# Make CLI and daemon executable
chmod +x %{buildroot}/opt/dynalloc/dynalloc-cli.js
chmod +x %{buildroot}/opt/dynalloc/dynalloc-daemon.js
chmod +x %{buildroot}/opt/dynalloc/dynalloc-start.sh 2>/dev/null || true

# Create symlink in /usr/local/bin
mkdir -p %{buildroot}/usr/local/bin
ln -sf /opt/dynalloc/dynalloc-cli.js %{buildroot}/usr/local/bin/dynalloc
ln -sf /opt/dynalloc/dynalloc-daemon.js %{buildroot}/usr/local/bin/dynalloc-daemon

# Install systemd user service
mkdir -p %{buildroot}%{_userunitdir}
cp systemd/dynalloc.service %{buildroot}%{_userunitdir}/

%files
%license packaging/debian/copyright
%dir /opt/dynalloc
/opt/dynalloc/*.js
/opt/dynalloc/*.json
/opt/dynalloc/*.sh
/opt/dynalloc/*.md
/opt/dynalloc/policy-engine/
/opt/dynalloc/plugins/
/opt/dynalloc/systemd/
/opt/dynalloc/detectors/
/opt/dynalloc/profiles/
/opt/dynalloc/adaptive/
/opt/dynalloc/recognition/
/opt/dynalloc/monitoring/
/opt/dynalloc/sdk/
/opt/dynalloc/intelligence/
/opt/dynalloc/lib/
/usr/local/bin/dynalloc
/usr/local/bin/dynalloc-daemon
%{_userunitdir}/dynalloc.service
%dir /etc/dynalloc

%post
# Set capabilities for non-root use
if command -v setcap >/dev/null 2>&1; then
  setcap 'cap_sys_nice+ep' /usr/bin/renice 2>/dev/null || true
  setcap 'cap_sys_nice+ep' /usr/bin/ionice 2>/dev/null || true
fi

echo ""
echo "DynAlloc v2.1.0 installed successfully!"
echo ""
echo "To enable as a user service:"
echo "  mkdir -p ~/.config/systemd/user"
echo "  cp %{_userunitdir}/dynalloc.service ~/.config/systemd/user/"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now dynalloc.service"
echo ""
echo "To test in dry-run mode:"
echo "  DYNALLOC_DRY_RUN=1 node /opt/dynalloc/dynalloc-daemon.js"
echo ""
echo "CLI: dynalloc status | doctor | predict | energy | vram"
echo ""

%preun
# Stop daemon before uninstall
if [ $1 -eq 0 ]; then
  systemctl --user stop dynalloc.service 2>/dev/null || true
  systemctl --user disable dynalloc.service 2>/dev/null || true
  pkill -f "dynalloc-daemon.js" 2>/dev/null || true
fi

%postun
if [ $1 -eq 0 ]; then
  # Full removal — clean up state files
  rm -f /tmp/dynalloc-state.json
  rm -f /tmp/dynalloc-*.sock
  echo "DynAlloc removed. Config preserved in /etc/dynalloc."
fi

%changelog
* Mon Jul 14 2026 Wahyu-ig <wyuhono@gmail.com> - 2.1.0-1
- v2.1.0 Tier 1 Killer Features release
- Added Predictive Pre-Allocation Engine ("Crystal Ball")
- Added Per-App Energy Accounting via RAPL
- Added CPU+GPU Shared Power Budget Arbiter
- Added GPU VRAM Pressure Reclaim Controller
- New CLI commands: predict, energy, vram, powerbudget
- 103 new unit tests (all passing in DRY_RUN mode)

* Sun Jul 13 2026 Wahyu-ig <wyuhono@gmail.com> - 2.0.0-1
- v2.0.0 Intelligence, Diagnostics & Transparency release
- Added Intelligence subsystem (learning, recommendations, explainability, timeline)
- Added Doctor engine, report generator
- Added Thermal protection, adaptive scheduler
- Comprehensive test suite

* Fri Jul 11 2025 Wahyu-ig <wyuhono@gmail.com> - 0.2.1-1
- Initial RPM package release
- Features: CLI tool, universal foreground detection, PID reuse protection,
  memory/IO cgroup limits, PPD coordination, thermal-aware boosting