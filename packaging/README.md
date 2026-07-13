# DynAlloc — Packaging

This directory contains packaging files for building native Linux packages
for DynAlloc. Three package formats are supported:

| Format | Distro | Build Command |
|--------|--------|---------------|
| `.deb` | Debian, Ubuntu, Mint, Pop!_OS | `make deb` |
| `.rpm` | Fedora, openSUSE, RHEL, CentOS | `make rpm` |
| `.pkg.tar.zst` | Arch, Manjaro, EndeavourOS, CachyOS | `make arch` |

## Quick Start

### Build all available packages
```bash
cd packaging/
make all
```
Packages will be in `build/`.

### Build a specific package
```bash
make deb    # Debian .deb
make rpm    # RPM .rpm
make arch   # Arch .pkg.tar.zst
```

### Manual install (no package manager)
```bash
# From project root:
./install.sh

# Or to a custom prefix:
./install.sh --prefix /usr/local/dynalloc

# Dry-run to see what would be installed:
./install.sh --dry-run
```

### Uninstall
```bash
./uninstall.sh           # Remove binaries, keep config
./uninstall.sh --purge   # Remove everything including config
```

## Prerequisites

### For building packages
- **.deb**: `dpkg-deb` (install: `sudo apt install dpkg-dev`)
- **.rpm**: `rpmbuild` (install: `sudo dnf install rpm-build` or `sudo apt install rpm`)
- **.pkg.tar.zst**: `makepkg` (Arch-only, comes with `pacman`)

### Runtime dependencies (installed automatically by packages)
- `nodejs >= 18.0.0`
- `procps` (for `ps`)
- `util-linux` (for `taskset`, `ionice`)
- `cgroup-tools` (for cgroup v2 management)

### Recommended optional dependencies
- `gdbus` / `glib2` — DBus calls for foreground detection + PPD coordination
- `cpupower` / `linux-tools-common` — CPU governor switching
- `xdotool` — X11 foreground detection fallback
- `libnotify` / `libnotify-bin` — desktop notifications
- `power-profiles-daemon` — PPD coordination (auto-detected)
- `gamemode` — Feral GameMode coexistence
- `pipewire` + `pipewire-pulse` + `wireplumber` — multimedia detection

## Directory Structure

```
packaging/
├── Makefile              — Build all package types
├── debian/
│   ├── control           — Debian package metadata + dependencies
│   ├── postinst          — Post-installation script
│   ├── prerm             — Pre-removal script (stop daemon)
│   ├── postrm            — Post-removal script (cleanup)
│   ├── install           — File list
│   ├── rules             — dpkg-buildpackage makefile
│   ├── changelog         — Debian changelog
│   └── copyright         — License file
├── rpm/
│   └── dynalloc.spec     — RPM spec file
└── arch/
    ├── PKGBUILD          — Arch package build script
    ├── dynalloc.install  — Pre/post install hooks
    └── README.md         — AUR submission guide
```

## Installation Paths

All packages install to the same locations:

| Path | Content |
|------|---------|
| `/opt/dynalloc/` | All daemon JS files, plugins, policy-engine |
| `/opt/dynalloc/systemd/dynalloc.service` | systemd user service file |
| `/usr/local/bin/dynalloc` | Symlink → `dynalloc-cli.js` (CLI tool) |
| `/usr/local/bin/dynalloc-daemon` | Symlink → `dynalloc-daemon.js` |
| `/etc/dynalloc/` | Config directory (config.json, policies.json) |
| `/usr/lib/systemd/user/dynalloc.service` | systemd user service (Arch/RPM) |
| `/etc/systemd/user/dynalloc.service` | systemd user service (Debian) |

## Post-Install

### Enable as user service (recommended)
```bash
systemctl --user daemon-reload
systemctl --user enable --now dynalloc.service

# Check status
systemctl --user status dynalloc.service
journalctl --user -u dynalloc.service -f
```

### Or run manually
```bash
# Dry-run mode (safe — no system changes)
DYNALLOC_DRY_RUN=1 node /opt/dynalloc/dynalloc-daemon.js

# Live mode
node /opt/dynalloc/dynalloc-daemon.js
```

### Use CLI
```bash
dynalloc status          # Current state
dynalloc doctor          # Health check
dynalloc boost <pid>     # Manually boost a process
dynalloc throttle <pid>  # Manually throttle a process
```

## AUR Submission (Arch maintainers)

To publish to AUR:

```bash
# Clone the AUR repo (need AUR account + SSH key)
git clone ssh://aur@aur.archlinux.org/dynalloc.git aur-dynalloc
cd aur-dynalloc

# Copy PKGBUILD + install hook
cp ../packaging/arch/PKGBUILD .
cp ../packaging/arch/dynalloc.install .

# Update version + checksums
updpkgsums  # or: makepkg -g >> PKGBUILD

# Test build
makepkg -si

# If it works, commit and push
git add PKGBUILD dynalloc.install
git commit -m "dynalloc 2.0.0-1"
git push
```

## CI/CD Integration

Example GitHub Actions workflow to build packages on push:

```yaml
# .github/workflows/packages.yml
name: Build Packages
on: [push, pull_request]

jobs:
  deb:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd packaging && make deb
      - uses: actions/upload-artifact@v4
        with:
          name: dynalloc-deb
          path: build/deb/*.deb

  rpm:
    runs-on: fedora-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd packaging && make rpm
      - uses: actions/upload-artifact@v4
        with:
          name: dynalloc-rpm
          path: build/rpmbuild/RPMS/**/*.rpm

  arch:
    runs-on: archlinux-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd packaging && make arch
      - uses: actions/upload-artifact@v4
        with:
          name: dynalloc-arch
          path: build/*.pkg.tar.zst
```

## Verification

After building, verify the package:

```bash
# .deb
dpkg-deb -I build/deb/dynalloc_2.0.0-1_all.deb    # Show info
dpkg-deb -c build/deb/dynalloc_2.0.0-1_all.deb    # Show contents

# .rpm
rpm -qpi build/rpmbuild/RPMS/noarch/dynalloc-2.0.0-1.noarch.rpm  # Info
rpm -qpl build/rpmbuild/RPMS/noarch/dynalloc-2.0.0-1.noarch.rpm  # Contents

# .pkg.tar.zst
pacman -Qip build/dynalloc-2.0.0-1-any.pkg.tar.zst  # Info
pacman -Qlp build/dynalloc-2.0.0-1-any.pkg.tar.zst  # Contents
```
