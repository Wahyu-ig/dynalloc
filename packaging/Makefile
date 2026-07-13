# DynAlloc — Packaging Makefile
# Build all package types: .deb, .rpm, .pkg.tar.zst
#
# Usage:
#   make deb        — build Debian .deb package
#   make rpm        — build RPM .rpm package
#   make arch       — build Arch .pkg.tar.zst package
#   make all        — build all available package types
#   make clean      — clean build artifacts
#   make install    — install to /opt/dynalloc (manual, no package)
#   make uninstall  — uninstall from /opt/dynalloc
#   make test       — run test suite
#   make help       — show this help
#
# NOTE: This Makefile can be invoked from any working directory
# (e.g. `make -C packaging all`, or `cd packaging && make all`).
# All paths are resolved relative to this Makefile's own location,
# not the caller's current directory.

.PHONY: help deb rpm arch all clean install uninstall test check-deps

VERSION ?= 1.0.0
RELEASE ?= 1
PKG_NAME := dynalloc

# ── Self-locating paths ────────────────────────────────────────────────
# MAKEFILE_DIR  = .../dylok/packaging   (where this file lives)
# PROJECT_ROOT  = .../dylok             (one level up; source lives here)
# BUILD_DIR     = .../dylok/packaging/build
MAKEFILE_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
PROJECT_ROOT := $(patsubst %/,%,$(MAKEFILE_DIR)/..)
BUILD_DIR := $(MAKEFILE_DIR)/build

# ── Help ────────────────────────────────────────────────────────────────

help:
	@echo "DynAlloc Packaging Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  deb        Build Debian .deb package"
	@echo "  rpm        Build RPM .rpm package"
	@echo "  arch       Build Arch .pkg.tar.zst package"
	@echo "  all        Build all available package types"
	@echo "  clean      Clean build artifacts"
	@echo "  install    Install to /opt/dynalloc (manual, no package manager)"
	@echo "  uninstall  Uninstall from /opt/dynalloc"
	@echo "  test       Run test suite"
	@echo "  check-deps Check build dependencies"
	@echo ""
	@echo "Variables:"
	@echo "  VERSION=$(VERSION)  Package version (default: 0.2.1)"
	@echo "  RELEASE=$(RELEASE)  Package release (default: 1)"
	@echo ""

# ── Dependency checks ──────────────────────────────────────────────────

check-deps:
	@echo "Checking build dependencies..."
	@command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (need >= 18.0.0)"; exit 1; }
	@node --version | head -1
	@command -v dpkg-deb >/dev/null 2>&1 && echo "dpkg-deb: available" || echo "dpkg-deb: not available (skip .deb build)"
	@command -v rpmbuild >/dev/null 2>&1 && echo "rpmbuild: available" || echo "rpmbuild: not available (skip .rpm build)"
	@command -v makepkg >/dev/null 2>&1 && echo "makepkg: available" || echo "makepkg: not available (skip .pkg.tar.zst build)"
	@echo "All checks passed."

# ── Source tarball ──────────────────────────────────────────────────────

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

source: $(BUILD_DIR)
	@echo "Building source tarball..."
	@mkdir -p "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION)"
	@cp -a "$(PROJECT_ROOT)"/*.js "$(PROJECT_ROOT)"/*.json "$(PROJECT_ROOT)"/*.sh "$(PROJECT_ROOT)"/*.md "$(PROJECT_ROOT)"/*.yaml "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION)/" 2>/dev/null || true
	@cp -a "$(PROJECT_ROOT)/policy-engine" "$(PROJECT_ROOT)/plugins" "$(PROJECT_ROOT)/systemd" "$(PROJECT_ROOT)/scripts" "$(PROJECT_ROOT)/test" "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION)/"
	@mkdir -p "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION)/packaging"
	@cp -a "$(MAKEFILE_DIR)/arch" "$(MAKEFILE_DIR)/debian" "$(MAKEFILE_DIR)/rpm" "$(MAKEFILE_DIR)/Makefile" "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION)/packaging/"
	@cd "$(BUILD_DIR)" && tar czf "$(PKG_NAME)-$(VERSION).tar.gz" "$(PKG_NAME)-$(VERSION)"
	@echo "Source tarball: $(BUILD_DIR)/$(PKG_NAME)-$(VERSION).tar.gz"

# ── Debian .deb ─────────────────────────────────────────────────────────

deb: check-deps source
	@echo "Building .deb package..."
	@if ! command -v dpkg-deb >/dev/null 2>&1; then \
		echo "ERROR: dpkg-deb not available. Install with: sudo apt install dpkg-dev"; \
		exit 1; \
	fi
	@mkdir -p "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/policy-engine"
	@mkdir -p "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/plugins"
	@mkdir -p "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/systemd"
	@mkdir -p "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN"
	# Copy files
	@cp -a "$(PROJECT_ROOT)"/*.js "$(PROJECT_ROOT)"/*.json "$(PROJECT_ROOT)"/*.sh "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/"
	@cp -a "$(PROJECT_ROOT)"/policy-engine/*.js "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/policy-engine/"
	@cp -a "$(PROJECT_ROOT)"/plugins/*.js "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/plugins/"
	@cp -a "$(PROJECT_ROOT)"/systemd/* "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/systemd/"
	@cp -a "$(PROJECT_ROOT)"/*.md "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/" 2>/dev/null || true
	# Copy DEBIAN control files
	@cp "$(MAKEFILE_DIR)/debian/control" "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/control"
	@cp "$(MAKEFILE_DIR)/debian/postinst" "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/postinst"
	@cp "$(MAKEFILE_DIR)/debian/prerm" "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/prerm"
	@cp "$(MAKEFILE_DIR)/debian/postrm" "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/postrm"
	# Fix version in control file
	@sed -i "s/Version: .*/Version: $(VERSION)/" "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/control"
	# Make scripts executable
	@chmod 755 "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/postinst"
	@chmod 755 "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/prerm"
	@chmod 755 "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/DEBIAN/postrm"
	@chmod +x "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/dynalloc-cli.js"
	@chmod +x "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/dynalloc-daemon.js"
	@chmod +x "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all/opt/dynalloc/dynalloc-start.sh"
	# Build .deb
	@dpkg-deb --build "$(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all"
	@echo ""
	@echo "✓ Debian package built: $(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all.deb"
	@echo "  Install with: sudo dpkg -i $(BUILD_DIR)/deb/$(PKG_NAME)_$(VERSION)-$(RELEASE)_all.deb"

# ── RPM .rpm ────────────────────────────────────────────────────────────

rpm: check-deps source
	@echo "Building .rpm package..."
	@if ! command -v rpmbuild >/dev/null 2>&1; then \
		echo "ERROR: rpmbuild not available. Install with:"; \
		echo "  Fedora: sudo dnf install rpm-build"; \
		echo "  Ubuntu: sudo apt install rpm"; \
		exit 1; \
	fi
	@mkdir -p "$(BUILD_DIR)/rpmbuild/BUILD" "$(BUILD_DIR)/rpmbuild/RPMS" "$(BUILD_DIR)/rpmbuild/SOURCES" "$(BUILD_DIR)/rpmbuild/SPECS"
	@cp "$(BUILD_DIR)/$(PKG_NAME)-$(VERSION).tar.gz" "$(BUILD_DIR)/rpmbuild/SOURCES/"
	@cp "$(MAKEFILE_DIR)/rpm/dynalloc.spec" "$(BUILD_DIR)/rpmbuild/SPECS/"
	@rpmbuild -ba \
		--define "_topdir $(BUILD_DIR)/rpmbuild" \
		--define "version $(VERSION)" \
		--define "release $(RELEASE)" \
		"$(BUILD_DIR)/rpmbuild/SPECS/dynalloc.spec"
	@echo ""
	@find "$(BUILD_DIR)/rpmbuild/RPMS" -name "*.rpm" -exec echo "✓ RPM package built: {}" \;
	@echo "  Install with: sudo dnf install <path-to.rpm>"

# ── Arch .pkg.tar.zst ───────────────────────────────────────────────────

arch: check-deps source
	@echo "Building .pkg.tar.zst package..."
	@if ! command -v makepkg >/dev/null 2>&1; then \
		echo "ERROR: makepkg not available. This is an Arch-only feature."; \
		exit 1; \
	fi
	@cp "$(MAKEFILE_DIR)/arch/PKGBUILD" "$(BUILD_DIR)/"
	@cp "$(MAKEFILE_DIR)/arch/dynalloc.install" "$(BUILD_DIR)/"
	# Point source= at the tarball already built by `make source`, which sits
	# right next to PKGBUILD in $(BUILD_DIR) — makepkg treats a bare filename
	# (no URL) as a local file and skips downloading it.
	@cd "$(BUILD_DIR)" && \
		sed 's|^source=.*|source=("$(PKG_NAME)-$(VERSION).tar.gz")|' PKGBUILD > PKGBUILD.local && \
		mv PKGBUILD.local PKGBUILD && \
		makepkg -sf --skipinteg
	@echo ""
	@find "$(BUILD_DIR)" -name "*.pkg.tar.zst" -exec echo "✓ Arch package built: {}" \;
	@echo "  Install with: sudo pacman -U <path-to.pkg.tar.zst>"

# ── All ─────────────────────────────────────────────────────────────────

all: check-deps
	@echo "Building all available package types..."
	@command -v dpkg-deb >/dev/null 2>&1 && $(MAKE) deb || echo "Skipping .deb (dpkg-deb not available)"
	@command -v rpmbuild >/dev/null 2>&1 && $(MAKE) rpm || echo "Skipping .rpm (rpmbuild not available)"
	@command -v makepkg >/dev/null 2>&1 && $(MAKE) arch || echo "Skipping .pkg.tar.zst (makepkg not available)"
	@echo ""
	@echo "All available packages built in $(BUILD_DIR)/"

# ── Manual install (no package manager) ─────────────────────────────────

install:
	@echo "Installing DynAlloc to /opt/dynalloc..."
	@sudo mkdir -p /opt/dynalloc/policy-engine /opt/dynalloc/plugins /opt/dynalloc/systemd
	@sudo cp -a "$(PROJECT_ROOT)"/*.js "$(PROJECT_ROOT)"/*.json "$(PROJECT_ROOT)"/*.sh /opt/dynalloc/
	@sudo cp -a "$(PROJECT_ROOT)"/policy-engine/*.js /opt/dynalloc/policy-engine/
	@sudo cp -a "$(PROJECT_ROOT)"/plugins/*.js /opt/dynalloc/plugins/
	@sudo cp -a "$(PROJECT_ROOT)"/systemd/* /opt/dynalloc/systemd/
	@sudo cp -a "$(PROJECT_ROOT)"/*.md /opt/dynalloc/ 2>/dev/null || true
	@sudo chmod +x /opt/dynalloc/dynalloc-cli.js /opt/dynalloc/dynalloc-daemon.js /opt/dynalloc/dynalloc-start.sh
	@sudo ln -sf /opt/dynalloc/dynalloc-cli.js /usr/local/bin/dynalloc
	@sudo ln -sf /opt/dynalloc/dynalloc-daemon.js /usr/local/bin/dynalloc-daemon
	@sudo mkdir -p /etc/dynalloc
	@echo ""
	@echo "✓ DynAlloc installed to /opt/dynalloc"
	@echo "  CLI: dynalloc status"
	@echo "  Service: cp /opt/dynalloc/systemd/dynalloc.service ~/.config/systemd/user/"
	@echo "           systemctl --user enable --now dynalloc.service"

uninstall:
	@echo "Uninstalling DynAlloc..."
	@sudo rm -f /usr/local/bin/dynalloc /usr/local/bin/dynalloc-daemon
	@sudo rm -rf /opt/dynalloc
	@sudo rm -f /tmp/dynalloc-state.json /tmp/dynalloc-*.sock
	@echo "✓ DynAlloc uninstalled. Config preserved in /etc/dynalloc (if exists)."
	@echo "  To fully purge: sudo rm -rf /etc/dynalloc"

# ── Test ────────────────────────────────────────────────────────────────

test:
	@echo "Running test suite..."
	@cd "$(PROJECT_ROOT)" && node test/unit/test-all.js
	@cd "$(PROJECT_ROOT)" && node test/unit/test-policy-engine.js
	@cd "$(PROJECT_ROOT)" && node test/integration/test-integration.js
	@cd "$(PROJECT_ROOT)" && node test/integration/test-policy-integration.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-fixes.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-cli.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-foreground.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-pid-reuse.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-memory-cgroup.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-ppd.js
	@cd "$(PROJECT_ROOT)" && node scripts/verify-thermal.js
	@echo ""
	@echo "✓ All tests passed"

# ── Clean ───────────────────────────────────────────────────────────────

clean:
	@echo "Cleaning build artifacts..."
	@rm -rf "$(BUILD_DIR)"
	@echo "✓ Cleaned"
