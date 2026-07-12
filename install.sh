#!/bin/bash
# DynAlloc — Manual Installation Script
# Usage: ./install.sh [--dry-run] [--prefix /opt/dynalloc]
#
# This script installs DynAlloc without a package manager.
# For package-based installation, use the .deb/.rpm/.pkg.tar.zst packages instead.

set -e

# Defaults
PREFIX="/opt/dynalloc"
DRY_RUN=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--prefix /opt/dynalloc]"
      echo ""
      echo "Options:"
      echo "  --dry-run    Show what would be installed without making changes"
      echo "  --prefix DIR Install to DIR instead of /opt/dynalloc"
      echo "  --help       Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          DynAlloc Installation                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Install prefix: $PREFIX"
echo "Dry run: $DRY_RUN"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Please install Node.js >= 18.0.0 first."
  exit 1
fi
NODE_VERSION=$(node --version | sed 's/v//')
echo "✓ Node.js found: $NODE_VERSION"

# Check minimum Node.js version
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18.0.0 required, found $NODE_VERSION"
  exit 1
fi
echo "✓ Node.js version OK (>= 18.0.0)"
echo ""

# Function to run command (or echo in dry-run)
run() {
  if $DRY_RUN; then
    echo "  [DRY-RUN] $*"
  else
    eval "$@"
  fi
}

# ── Install files ──────────────────────────────────────────────────────

echo "Installing files to $PREFIX..."

run "mkdir -p $PREFIX/policy-engine $PREFIX/plugins $PREFIX/systemd $PREFIX/detectors $PREFIX/profiles $PREFIX/adaptive $PREFIX/recognition $PREFIX/monitoring $PREFIX/sdk $PREFIX/lib/controllers"
run "cp -a $SCRIPT_DIR/*.js $SCRIPT_DIR/*.json $SCRIPT_DIR/*.sh $PREFIX/"
run "cp -a $SCRIPT_DIR/policy-engine/*.js $PREFIX/policy-engine/"
run "cp -a $SCRIPT_DIR/plugins/*.js $PREFIX/plugins/"
run "cp -a $SCRIPT_DIR/detectors/*.js $PREFIX/detectors/"
run "cp -a $SCRIPT_DIR/profiles/*.js $PREFIX/profiles/"
run "cp -a $SCRIPT_DIR/adaptive/*.js $PREFIX/adaptive/"
run "cp -a $SCRIPT_DIR/recognition/*.js $PREFIX/recognition/"
run "cp -a $SCRIPT_DIR/monitoring/*.js $PREFIX/monitoring/"
run "cp -a $SCRIPT_DIR/sdk/*.js $PREFIX/sdk/"
run "cp -a $SCRIPT_DIR/lib/*.js $PREFIX/lib/"
run "cp -a $SCRIPT_DIR/lib/controllers/*.js $PREFIX/lib/controllers/"
run "cp -a $SCRIPT_DIR/systemd/* $PREFIX/systemd/"
run "cp -a $SCRIPT_DIR/*.md $PREFIX/ 2>/dev/null || true"
run "chmod +x $PREFIX/dynalloc-cli.js $PREFIX/dynalloc-daemon.js $PREFIX/dynalloc-start.sh"
echo "✓ Files installed"
echo ""

# ── Create symlinks ────────────────────────────────────────────────────

echo "Creating CLI symlinks..."
run "ln -sf $PREFIX/dynalloc-cli.js /usr/local/bin/dynalloc"
run "ln -sf $PREFIX/dynalloc-daemon.js /usr/local/bin/dynalloc-daemon"
echo "✓ Symlinks created: /usr/local/bin/dynalloc, /usr/local/bin/dynalloc-daemon"
echo ""

# ── Install systemd user service ───────────────────────────────────────

echo "Installing systemd user service..."
# We install to the system location so users can enable it without copying
if [ -d /usr/lib/systemd/user ]; then
  run "cp $SCRIPT_DIR/systemd/dynalloc.service /usr/lib/systemd/user/dynalloc.service"
  echo "✓ Systemd service installed to /usr/lib/systemd/user/"
elif [ -d /etc/systemd/user ]; then
  run "cp $SCRIPT_DIR/systemd/dynalloc.service /etc/systemd/user/dynalloc.service"
  echo "✓ Systemd service installed to /etc/systemd/user/"
else
  echo "⚠ Systemd user directory not found. Manual copy required:"
  echo "  mkdir -p ~/.config/systemd/user"
  echo "  cp $PREFIX/systemd/dynalloc.service ~/.config/systemd/user/"
fi
echo ""

# ── Create config directory ────────────────────────────────────────────

echo "Creating config directory..."
run "mkdir -p /etc/dynalloc"
if [ -f "$SCRIPT_DIR/dynalloc.config.example.json" ]; then
  run "cp $SCRIPT_DIR/dynalloc.config.example.json /etc/dynalloc/config.json.example"
fi
if [ -f "$SCRIPT_DIR/policies.example.json" ]; then
  run "cp $SCRIPT_DIR/policies.example.json /etc/dynalloc/policies.json.example"
fi
if [ -f "$SCRIPT_DIR/policies.example.yaml" ]; then
  run "cp $SCRIPT_DIR/policies.example.yaml /etc/dynalloc/policies.yaml.example"
fi
echo "✓ Config directory: /etc/dynalloc"
echo ""

# ── Set capabilities (optional, for non-root use) ──────────────────────

if command -v setcap >/dev/null 2>&1; then
  echo "Setting CAP_SYS_NICE on renice/ionice (for non-root use)..."
  if $DRY_RUN; then
    echo "  [DRY-RUN] setcap 'cap_sys_nice+ep' /usr/bin/renice /usr/bin/ionice"
  else
    setcap 'cap_sys_nice+ep' /usr/bin/renice 2>/dev/null || echo "  ⚠ Could not set cap on renice (need root)"
    setcap 'cap_sys_nice+ep' /usr/bin/ionice 2>/dev/null || echo "  ⚠ Could not set cap on ionice (need root)"
  fi
  echo "✓ Capabilities set"
  echo ""
fi

# ── Done ────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Installation Complete!                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "1. Enable as a user service (recommended):"
echo "   systemctl --user daemon-reload"
echo "   systemctl --user enable --now dynalloc.service"
echo ""
echo "2. Or test in dry-run mode first:"
echo "   DYNALLOC_DRY_RUN=1 node $PREFIX/dynalloc-daemon.js"
echo ""
echo "3. Use the CLI:"
echo "   dynalloc status"
echo "   dynalloc doctor"
echo "   dynalloc boost <pid>"
echo ""
echo "4. Configure (optional):"
echo "   cp /etc/dynalloc/config.json.example ~/.config/dynalloc/config.json"
echo "   # Edit as needed, see $PREFIX/Configuration.md"
echo ""
echo "5. Check health:"
echo "   dynalloc doctor"
echo ""
echo "Documentation:"
echo "  $PREFIX/Configuration.md"
echo "  $PREFIX/Architecture.md"
echo "  $PREFIX/Troubleshooting.md"
echo ""

if $DRY_RUN; then
  echo "NOTE: This was a dry-run. No files were actually installed."
  echo "Run without --dry-run to perform the actual installation."
fi
