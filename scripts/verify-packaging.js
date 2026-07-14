'use strict';

/**
 * Regression tests for v2.1.9 packaging files.
 *
 * Tests cover:
 *   - Debian package files exist and are valid
 *   - RPM spec file exists and is valid
 *   - Arch PKGBUILD exists and is valid
 *   - Makefile has correct targets
 *   - install.sh / uninstall.sh exist and are valid bash
 *   - All scripts are executable
 *   - Package metadata is correct (version, name, dependencies)
 *
 * Run with: node scripts/verify-packaging.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Verifying packaging files...\n');

const PKG_DIR = path.join(__dirname, '..', 'packaging');
const ROOT_DIR = path.join(__dirname, '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const version = packageJson.version;

// ── Test: Debian package files ─────────────────────────────────────────

test('Fix #70a: Debian control file exists', () => {
  const f = path.join(PKG_DIR, 'debian', 'control');
  assert.ok(fs.existsSync(f), 'debian/control should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('Package: dynalloc'), 'should have Package: dynalloc');
  assert.ok(content.includes(`Version: ${version}`), `should have Version: ${version}`);
  assert.ok(content.includes('Architecture: all'), 'should be Architecture: all');
  assert.ok(content.includes('Depends:'), 'should have Depends field');
  assert.ok(content.includes('nodejs'), 'should depend on nodejs');
});

test('Fix #70b: Debian postinst script exists and is valid bash', () => {
  const f = path.join(PKG_DIR, 'debian', 'postinst');
  assert.ok(fs.existsSync(f), 'debian/postinst should exist');
  // Validate bash syntax
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  // Check content
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('configure'), 'should handle configure case');
  assert.ok(content.includes('dynalloc'), 'should mention dynalloc');
  assert.ok(content.includes('systemctl'), 'should mention systemctl');
});

test('Fix #70c: Debian prerm script exists and is valid bash', () => {
  const f = path.join(PKG_DIR, 'debian', 'prerm');
  assert.ok(fs.existsSync(f), 'debian/prerm should exist');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('remove'), 'should handle remove case');
  assert.ok(content.includes('stop dynalloc.service'), 'should stop daemon');
});

test('Fix #70d: Debian postrm script exists and is valid bash', () => {
  const f = path.join(PKG_DIR, 'debian', 'postrm');
  assert.ok(fs.existsSync(f), 'debian/postrm should exist');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('purge'), 'should handle purge case');
  assert.ok(content.includes('remove'), 'should handle remove case');
});

test('Fix #70e: Debian install file list exists', () => {
  const f = path.join(PKG_DIR, 'debian', 'install');
  assert.ok(fs.existsSync(f), 'debian/install should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('dynalloc-daemon.js'), 'should install daemon');
  assert.ok(content.includes('dynalloc-cli.js'), 'should install CLI');
  assert.ok(content.includes('policy-engine/'), 'should install policy-engine');
  assert.ok(content.includes('plugins/'), 'should install plugins');
});

test('Fix #70f: Debian changelog exists', () => {
  const f = path.join(PKG_DIR, 'debian', 'changelog');
  assert.ok(fs.existsSync(f), 'debian/changelog should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('dynalloc (0.2.1-1)'), 'should have version 0.2.1-1');
  assert.ok(content.includes('urgency=medium'), 'should have urgency');
});

test('Fix #70g: Debian copyright file exists', () => {
  const f = path.join(PKG_DIR, 'debian', 'copyright');
  assert.ok(fs.existsSync(f), 'debian/copyright should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('MIT'), 'should be MIT license');
  assert.ok(content.includes('Format:'), 'should have Format header');
});

test('Fix #70h: Debian rules file exists', () => {
  const f = path.join(PKG_DIR, 'debian', 'rules');
  assert.ok(fs.existsSync(f), 'debian/rules should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('dh $@'), 'should use debhelper');
  assert.ok(content.includes('override_dh_auto_install'), 'should override install');
});

// ── Test: RPM spec file ────────────────────────────────────────────────

test('Fix #71a: RPM spec file exists', () => {
  const f = path.join(PKG_DIR, 'rpm', 'dynalloc.spec');
  assert.ok(fs.existsSync(f), 'rpm/dynalloc.spec should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('Name:           dynalloc'), 'should have Name');
  assert.ok(content.includes(`Version:        ${version}`), `should have Version ${version}`);
  assert.ok(content.includes('Release:'), 'should have Release');
  assert.ok(content.includes('License:        MIT'), 'should be MIT');
  assert.ok(content.includes('BuildArch:      noarch'), 'should be noarch');
});

test('Fix #71b: RPM spec has correct dependencies', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  assert.ok(content.includes('Requires:       nodejs'), 'should require nodejs');
  assert.ok(content.includes('Requires:       procps-ng'), 'should require procps-ng');
  assert.ok(content.includes('Recommends:     gdbus'), 'should recommend gdbus');
  assert.ok(content.includes('Suggests:       power-profiles-daemon'), 'should suggest PPD');
});

test('Fix #71c: RPM spec has install sections', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  assert.ok(content.includes('%prep'), 'should have %prep section');
  assert.ok(content.includes('%build'), 'should have %build section');
  assert.ok(content.includes('%install'), 'should have %install section');
  assert.ok(content.includes('%files'), 'should have %files section');
  assert.ok(content.includes('%post'), 'should have %post section');
  assert.ok(content.includes('%preun'), 'should have %preun section');
  assert.ok(content.includes('%postun'), 'should have %postun section');
  assert.ok(content.includes('%changelog'), 'should have %changelog section');
});

test('Fix #71d: RPM spec installs to /opt/dynalloc', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  assert.ok(content.includes('/opt/dynalloc'), 'should install to /opt/dynalloc');
  assert.ok(content.includes('/usr/local/bin/dynalloc'), 'should create symlink');
});

// ── Test: Arch PKGBUILD ────────────────────────────────────────────────

test('Fix #72a: Arch PKGBUILD exists and is valid bash', () => {
  const f = path.join(PKG_DIR, 'arch', 'PKGBUILD');
  assert.ok(fs.existsSync(f), 'arch/PKGBUILD should exist');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
});

test('Fix #72b: PKGBUILD has correct package metadata', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(content.includes('pkgname=dynalloc'), 'should have pkgname');
  assert.ok(content.includes(`pkgver=${version}`), `should have pkgver=${version}`);
  assert.ok(content.includes('pkgrel=1'), 'should have pkgrel=1');
  assert.ok(content.includes("arch=('any')"), 'should be arch=any');
  assert.ok(content.includes("license=('MIT')"), 'should be MIT license');
  assert.ok(content.includes("depends=('nodejs>=18'"), 'should depend on nodejs >= 18');
});

test('Fix #72c: PKGBUILD has optdepends for optional features', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(content.includes('optdepends='), 'should have optdepends');
  assert.ok(content.includes('cgroup-tools'), 'should mention cgroup-tools');
  assert.ok(content.includes('cpupower'), 'should mention cpupower');
  assert.ok(content.includes('xdotool'), 'should mention xdotool');
  assert.ok(content.includes('power-profiles-daemon'), 'should mention PPD');
  assert.ok(content.includes('gamemode'), 'should mention gamemode');
  assert.ok(content.includes('pipewire'), 'should mention pipewire');
  assert.ok(content.includes('sway'), 'should mention sway');
  assert.ok(content.includes('hyprland'), 'should mention hyprland');
});

test('Fix #72d: PKGBUILD has package() function', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(content.includes('package()'), 'should have package() function');
  assert.ok(content.includes('install -dm755'), 'should use install command');
  assert.ok(content.includes('/opt/dynalloc'), 'should install to /opt/dynalloc');
  assert.ok(content.includes('/usr/local/bin/dynalloc'), 'should create symlink');
});

test('Fix #72e: PKGBUILD has check() function for tests', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(content.includes('check()'), 'should have check() function');
  assert.ok(content.includes('node test/unit/test-all.js'), 'should run tests');
});

test('Fix #72f: Arch dynalloc.install hook exists and is valid', () => {
  const f = path.join(PKG_DIR, 'arch', 'dynalloc.install');
  assert.ok(fs.existsSync(f), 'arch/dynalloc.install should exist');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('post_install'), 'should have post_install');
  assert.ok(content.includes('post_upgrade'), 'should have post_upgrade');
  assert.ok(content.includes('pre_remove'), 'should have pre_remove');
  assert.ok(content.includes('post_remove'), 'should have post_remove');
});

test('Fix #72g: Arch README.md exists with AUR submission guide', () => {
  const f = path.join(PKG_DIR, 'arch', 'README.md');
  assert.ok(fs.existsSync(f), 'arch/README.md should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('AUR'), 'should mention AUR');
  assert.ok(content.includes('makepkg'), 'should mention makepkg');
  assert.ok(content.includes('aur.archlinux.org'), 'should link to AUR');
});

// ── Test: Makefile ─────────────────────────────────────────────────────

test('Fix #73a: Makefile exists and is valid', () => {
  const f = path.join(PKG_DIR, 'Makefile');
  assert.ok(fs.existsSync(f), 'packaging/Makefile should exist');
  // Verify Makefile syntax by running make -n help (dry run)
  execFileSync('make', ['-C', PKG_DIR, '-n', 'help'], { stdio: 'pipe' });
});

test('Fix #73b: Makefile has all build targets', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');
  assert.ok(content.includes('deb:'), 'should have deb target');
  assert.ok(content.includes('rpm:'), 'should have rpm target');
  assert.ok(content.includes('arch:'), 'should have arch target');
  assert.ok(content.includes('all:'), 'should have all target');
  assert.ok(content.includes('clean:'), 'should have clean target');
  assert.ok(content.includes('install:'), 'should have install target');
  assert.ok(content.includes('uninstall:'), 'should have uninstall target');
  assert.ok(content.includes('test:'), 'should have test target');
  assert.ok(content.includes('check-deps:'), 'should have check-deps target');
  assert.ok(content.includes('source:'), 'should have source target');
});

test('Fix #73c: Makefile references correct version', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');
  assert.ok(content.includes(`VERSION ?= ${version}`), `should default to version ${version}`);
  assert.ok(content.includes('PKG_NAME := dynalloc'), 'should use PKG_NAME dynalloc');
});

test('Fix #73d: Makefile deb target builds .deb', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');
  assert.ok(content.includes('dpkg-deb --build'), 'deb target should call dpkg-deb --build');
  assert.ok(content.includes('DEBIAN/control'), 'should copy control file');
  assert.ok(content.includes('DEBIAN/postinst'), 'should copy postinst');
  assert.ok(content.includes('DEBIAN/prerm'), 'should copy prerm');
  assert.ok(content.includes('DEBIAN/postrm'), 'should copy postrm');
});

test('Fix #73e: Makefile rpm target builds .rpm', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');
  assert.ok(content.includes('rpmbuild -ba'), 'rpm target should call rpmbuild -ba');
  assert.ok(content.includes('dynalloc.spec'), 'should use dynalloc.spec');
});

test('Fix #73f: Makefile arch target builds .pkg.tar.zst', () => {
  const content = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');
  assert.ok(content.includes('makepkg -sf'), 'arch target should call makepkg');
  assert.ok(content.includes('.pkg.tar.zst'), 'should reference .pkg.tar.zst output');
});

// ── Test: install.sh / uninstall.sh ────────────────────────────────────

test('Fix #74a: install.sh exists and is valid bash', () => {
  const f = path.join(ROOT_DIR, 'install.sh');
  assert.ok(fs.existsSync(f), 'install.sh should exist in project root');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  // Check executable
  const stat = fs.statSync(f);
  assert.ok(stat.mode & 0o111, 'install.sh should be executable');
});

test('Fix #74b: install.sh checks Node.js version', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'install.sh'), 'utf8');
  assert.ok(content.includes('command -v node'), 'should check for node');
  assert.ok(content.includes('18.0.0'), 'should check for Node >= 18');
  assert.ok(content.includes('--dry-run'), 'should support --dry-run flag');
  assert.ok(content.includes('--prefix'), 'should support --prefix flag');
});

test('Fix #74c: install.sh installs to /opt/dynalloc by default', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'install.sh'), 'utf8');
  assert.ok(content.includes('PREFIX="/opt/dynalloc"'), 'should default to /opt/dynalloc');
  assert.ok(content.includes('/usr/local/bin/dynalloc'), 'should create symlink');
  assert.ok(content.includes('systemd'), 'should install systemd service');
  assert.ok(content.includes('/etc/dynalloc'), 'should create config dir');
});

test('Fix #74d: install.sh sets capabilities for non-root use', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'install.sh'), 'utf8');
  assert.ok(content.includes('setcap'), 'should use setcap');
  assert.ok(content.includes('cap_sys_nice'), 'should set cap_sys_nice');
  assert.ok(content.includes('renice'), 'should set cap on renice');
  assert.ok(content.includes('ionice'), 'should set cap on ionice');
});

test('Fix #74e: uninstall.sh exists and is valid bash', () => {
  const f = path.join(ROOT_DIR, 'uninstall.sh');
  assert.ok(fs.existsSync(f), 'uninstall.sh should exist in project root');
  execFileSync('bash', ['-n', f], { stdio: 'pipe' });
  const stat = fs.statSync(f);
  assert.ok(stat.mode & 0o111, 'uninstall.sh should be executable');
});

test('Fix #74f: uninstall.sh stops daemon and removes files', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'uninstall.sh'), 'utf8');
  assert.ok(content.includes('systemctl --user stop'), 'should stop daemon');
  assert.ok(content.includes('systemctl --user disable'), 'should disable daemon');
  assert.ok(content.includes('pkill -f "dynalloc-daemon.js"'), 'should kill daemon process');
  assert.ok(content.includes('/usr/local/bin/dynalloc'), 'should remove symlink');
  assert.ok(content.includes('/opt/dynalloc'), 'should remove install dir');
  assert.ok(content.includes('--purge'), 'should support --purge flag');
});

// ── Test: packaging README ─────────────────────────────────────────────

test('Fix #75: packaging/README.md exists with build instructions', () => {
  const f = path.join(PKG_DIR, 'README.md');
  assert.ok(fs.existsSync(f), 'packaging/README.md should exist');
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('make deb'), 'should mention make deb');
  assert.ok(content.includes('make rpm'), 'should mention make rpm');
  assert.ok(content.includes('make arch'), 'should mention make arch');
  assert.ok(content.includes('AUR'), 'should mention AUR');
  assert.ok(content.includes('install.sh'), 'should mention install.sh');
});

// ── Test: consistency across package formats ───────────────────────────

test('Fix #76a: All package formats install to /opt/dynalloc', () => {
  const debControl = fs.readFileSync(path.join(PKG_DIR, 'debian', 'install'), 'utf8');
  const rpmSpec = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  const pkgbuild = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(debControl.includes('/opt/dynalloc/'), 'Debian should install to /opt/dynalloc');
  assert.ok(rpmSpec.includes('/opt/dynalloc'), 'RPM should install to /opt/dynalloc');
  assert.ok(pkgbuild.includes('/opt/dynalloc'), 'PKGBUILD should install to /opt/dynalloc');
});

test('Fix #76b: All package formats create dynalloc CLI symlink', () => {
  const debPostinst = fs.readFileSync(path.join(PKG_DIR, 'debian', 'postinst'), 'utf8');
  const rpmSpec = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  const pkgbuild = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(debPostinst.includes('/usr/local/bin/dynalloc'), 'Debian should create CLI symlink');
  assert.ok(rpmSpec.includes('/usr/local/bin/dynalloc'), 'RPM should create CLI symlink');
  assert.ok(pkgbuild.includes('/usr/local/bin/dynalloc'), 'PKGBUILD should create CLI symlink');
});

test('Fix #76c: All package formats install systemd user service', () => {
  const debInstall = fs.readFileSync(path.join(PKG_DIR, 'debian', 'install'), 'utf8');
  const rpmSpec = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  const pkgbuild = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(debInstall.includes('dynalloc.service'), 'Debian should install systemd service');
  assert.ok(rpmSpec.includes('dynalloc.service'), 'RPM should install systemd service');
  assert.ok(pkgbuild.includes('dynalloc.service'), 'PKGBUILD should install systemd service');
});

test('Fix #76d: All package formats mention nodejs dependency', () => {
  const debControl = fs.readFileSync(path.join(PKG_DIR, 'debian', 'control'), 'utf8');
  const rpmSpec = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  const pkgbuild = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  assert.ok(debControl.includes('nodejs'), 'Debian should depend on nodejs');
  assert.ok(rpmSpec.includes('nodejs'), 'RPM should require nodejs');
  assert.ok(pkgbuild.includes("nodejs>=18"), 'PKGBUILD should depend on nodejs>=18');
});

// ── Test: version consistency ──────────────────────────────────────────

test('Fix #77: Version is consistent across all package files', () => {
  const debControl = fs.readFileSync(path.join(PKG_DIR, 'debian', 'control'), 'utf8');
  const debChangelog = fs.readFileSync(path.join(PKG_DIR, 'debian', 'changelog'), 'utf8');
  const rpmSpec = fs.readFileSync(path.join(PKG_DIR, 'rpm', 'dynalloc.spec'), 'utf8');
  const pkgbuild = fs.readFileSync(path.join(PKG_DIR, 'arch', 'PKGBUILD'), 'utf8');
  const makefile = fs.readFileSync(path.join(PKG_DIR, 'Makefile'), 'utf8');

  assert.ok(debControl.includes(`Version: ${version}`), `Debian control should have Version: ${version}`);
  assert.ok(debChangelog.includes(`dynalloc (${version}-1)`), `Debian changelog should have version ${version}-1`);
  assert.ok(rpmSpec.includes(`Version:        ${version}`), `RPM spec should have Version: ${version}`);
  assert.ok(pkgbuild.includes(`pkgver=${version}`), `PKGBUILD should have pkgver=${version}`);
  assert.ok(makefile.includes(`VERSION ?= ${version}`), `Makefile should have VERSION ?= ${version}`);
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Packaging tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}, 1000);
