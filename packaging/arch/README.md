# DynAlloc — AUR Package

This directory contains the Arch User Repository (AUR) package files for DynAlloc.

## Installation via AUR (recommended for Arch users)

Using an AUR helper (yay/paru):
```bash
yay -S dynalloc
# or
paru -S dynalloc
```

Manual build:
```bash
git clone https://aur.archlinux.org/dynalloc.git
cd dynalloc
makepkg -si
```

## Files

- `PKGBUILD` — Arch package build script
- `dynalloc.install` — pre/post install hooks

## Post-install

```bash
# Enable as user service (recommended)
systemctl --user enable --now dynalloc.service

# Or test in dry-run mode first
DYNALLOC_DRY_RUN=1 node /opt/dynalloc/dynalloc-daemon.js

# Use CLI
dynalloc status
dynalloc doctor
```

## Updating the AUR package

When a new version is released:

1. Update `pkgver` in PKGBUILD
2. Update `sha256sums` (or set to SKIP for -git packages)
3. Test build locally: `makepkg -si`
4. Push to AUR:
   ```bash
   git clone ssh://aur@aur.archlinux.org/dynalloc.git
   cp PKGBUILD dynalloc.install aur/
   cd aur
   git add PKGBUILD dynalloc.install
   git commit -m "Update to 2.0.0"
   git push
   ```
