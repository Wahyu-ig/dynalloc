#!/bin/bash
# DynAlloc — Manual Uninstallation Script
# Usage: ./uninstall.sh [--purge]
#
# --purge: Also remove config files in /etc/dynalloc and user config

set -e

PREFIX="/opt/dynalloc"
PURGE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --purge)
      PURGE=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--purge]"
      echo ""
      echo "Options:"
      echo "  --purge  Also remove config files in /etc/dynalloc and ~/.config/dynalloc"
      echo "  --help   Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          DynAlloc Uninstallation                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Purge mode: $PURGE"
echo ""

# ── Stop daemon if running ─────────────────────────────────────────────

echo "Stopping daemon..."
systemctl --user stop dynalloc.service 2>/dev/null || echo "  (service not running)"
systemctl --user disable dynalloc.service 2>/dev/null || echo "  (service not enabled)"
pkill -f "dynalloc-daemon.js" 2>/dev/null || echo "  (no daemon process found)"
echo "✓ Daemon stopped"
echo ""

# ── Remove symlinks ────────────────────────────────────────────────────

echo "Removing CLI symlinks..."
rm -f /usr/local/bin/dynalloc
rm -f /usr/local/bin/dynalloc-daemon
echo "✓ Symlinks removed"
echo ""

# ── Remove systemd service ─────────────────────────────────────────────

echo "Removing systemd service..."
rm -f /usr/lib/systemd/user/dynalloc.service 2>/dev/null || true
rm -f /etc/systemd/user/dynalloc.service 2>/dev/null || true
rm -f ~/.config/systemd/user/dynalloc.service 2>/dev/null || true
systemctl --user daemon-reload 2>/dev/null || true
echo "✓ Systemd service removed"
echo ""

# ── Remove installation directory ──────────────────────────────────────

if [ -d "$PREFIX" ]; then
  echo "Removing $PREFIX..."
  rm -rf "$PREFIX"
  echo "✓ Installation directory removed"
else
  echo "Installation directory $PREFIX not found (already removed?)"
fi
echo ""

# ── Remove state files ─────────────────────────────────────────────────

echo "Removing state files..."
rm -f /tmp/dynalloc-state.json
rm -f /tmp/dynalloc-*.sock
echo "✓ State files removed"
echo ""

# ── Remove config (only with --purge) ──────────────────────────────────

if $PURGE; then
  echo "Purging config files..."
  rm -rf /etc/dynalloc
  rm -rf ~/.config/dynalloc
  echo "✓ Config files purged"
  echo ""
fi

# ── Done ────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Uninstallation Complete!                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
if $PURGE; then
  echo "DynAlloc has been fully removed including all config files."
else
  echo "DynAlloc has been removed. Config files preserved in:"
  echo "  /etc/dynalloc/"
  echo "  ~/.config/dynalloc/"
  echo ""
  echo "To fully purge config, run: $0 --purge"
fi
echo ""
