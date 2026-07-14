'use strict';

/**
 * DynAlloc — Self Check Module
 *
 * Pre-flight environment validation. Checks for required system
 * features and reports availability with graceful fallbacks.
 *
 * v2.1: Comprehensive capability detection, no crashes on missing features.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const logger = require('./logger');
const { info, warn, debug } = logger;

/**
 * Run all self-checks and return a capability report.
 * Never crashes — all checks are wrapped in try-catch.
 *
 * @returns {object} capability report
 */
function runSelfCheck() {
  const report = {
    psi: checkPSI(),
    cgroupsV2: checkCgroupsV2(),
    systemd: checkSystemd(),
    cpufreq: checkCpufreq(),
    governor: checkGovernor(),
    intelPstate: checkIntelPstate(),
    amdPstate: checkAmdPstate(),
    pipewire: checkPipeWire(),
    wireplumber: checkWirePlumber(),
    gamemode: checkGameMode(),
    powerProfilesDaemon: checkPowerProfilesDaemon(),
    hyprland: !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
    sway: checkSway(),
    kdeWayland: checkKdeWayland(),
    gnomeWayland: checkGnomeWayland(),
    x11: checkX11(),
    foregroundTool: checkForegroundTool(),
    permissions: checkPermissions(),
    kernelVersion: getKernelVersion(),
    nodeVersion: process.version,
    capabilities: [],  // list of available capabilities
    warnings: [],      // list of warnings
  };

  // Build capabilities list
  if (report.psi) report.capabilities.push('PSI');
  if (report.cgroupsV2.available) report.capabilities.push('CGROUPS_V2');
  if (report.cpufreq.available) report.capabilities.push('CPUFREQ');
  if (report.governor) report.capabilities.push('GOVERNOR_SWITCH');
  if (report.gamemode) report.capabilities.push('GAMEMODE');
  if (report.powerProfilesDaemon && report.powerProfilesDaemon.active) {
    report.capabilities.push('POWER_PROFILES_DAEMON');
  }
  if (report.pipewire) report.capabilities.push('PIPEWIRE');
  if (report.wireplumber) report.capabilities.push('WIREPLUMBER');
  if (report.hyprland) report.capabilities.push('HYPRLAND');
  if (report.sway) report.capabilities.push('SWAY');
  if (report.kdeWayland) report.capabilities.push('KDE_WAYLAND');
  if (report.gnomeWayland) report.capabilities.push('GNOME_WAYLAND');

  // Kernel compatibility
  const kv = parseVersion(report.kernelVersion);
  if (kv && (kv.major < 5 || (kv.major === 5 && kv.minor < 2))) {
    report.warnings.push('Kernel < 5.2 — PSI mungkin tidak tersedia atau tidak stabil.');
  }

  return report;
}

function checkPSI() {
  try {
    const cpuPath = '/proc/pressure/cpu';
    const memPath = '/proc/pressure/memory';
    const cpuExists = fs.existsSync(cpuPath);
    const memExists = fs.existsSync(memPath);
    if (!cpuExists && !memExists) {
      return { cpu: false, memory: false, reason: '/proc/pressure/ tidak tersedia' };
    }
    return { cpu: cpuExists, memory: memExists };
  } catch (_) {
    return { cpu: false, memory: false, reason: 'Error checking PSI' };
  }
}

function checkCgroupsV2() {
  try {
    const cgroupV2 = fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
    if (!cgroupV2) {
      return { available: false, reason: 'cgroups v2 tidak terdeteksi (tidak ada cgroup.controllers)' };
    }
    const controllers = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8');
    const hasCpu = controllers.includes('cpu');
    // v2.1.6: also report memory and io controller availability
    const hasMemory = controllers.includes('memory');
    const hasIo = controllers.includes('io');
    return {
      available: hasCpu,
      reason: hasCpu ? 'ok' : 'controller cpu tidak tersedia',
      controllers: {
        cpu: hasCpu,
        memory: hasMemory,
        io: hasIo,
      },
    };
  } catch (_) {
    return { available: false, reason: 'Error checking cgroups' };
  }
}

function checkSystemd() {
  try {
    const result = execFileSync('systemctl', ['--version'], { encoding: 'utf8', timeout: 3000 });
    const match = result.match(/systemd (\d+)/);
    return !!match;
  } catch (_) {
    return false;
  }
}

function checkCpufreq() {
  try {
    const exists = fs.existsSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
    return {
      available: exists,
      reason: exists ? 'ok' : 'cpufreq sysfs tidak tersedia',
    };
  } catch (_) {
    return { available: false, reason: 'Error checking cpufreq' };
  }
}

function checkGovernor() {
  try {
    const gov = fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim();
    const avail = fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors', 'utf8').trim();
    return { current: gov, available: avail.split(' ') };
  } catch (_) {
    return null;
  }
}

function checkIntelPstate() {
  try {
    return fs.existsSync('/sys/devices/system/cpu/intel_pstate');
  } catch (_) {
    return false;
  }
}

function checkAmdPstate() {
  try {
    return fs.existsSync('/sys/devices/system/cpu/amd_pstate');
  } catch (_) {
    return false;
  }
}

function checkPipeWire() {
  try {
    const result = execFileSync('pw-cli', ['info', '0'], { encoding: 'utf8', timeout: 2000 });
    return result.includes('PipeWire');
  } catch (_) {
    return false;
  }
}

function checkWirePlumber() {
  try {
    const result = execFileSync('wpctl', ['status'], { encoding: 'utf8', timeout: 2000 });
    return result.includes('WirePlumber');
  } catch (_) {
    return false;
  }
}

function checkGameMode() {
  try {
    const result = execFileSync('gamemoded', ['--status'], { encoding: 'utf8', timeout: 2000 });
    return result.includes('gamemoded is active') || result.includes('active');
  } catch (_) {
    return false;
  }
}

/**
 * v2.1.7: Check if power-profiles-daemon (PPD) is running.
 * PPD is the default power management daemon on Fedora, Ubuntu, GNOME,
 * and KDE Plasma. It manages CPU governor switching via DBus.
 *
 * Returns:
 *   - { active: true, profile: "balanced" } if PPD is running
 *   - { active: false } if PPD is not running
 *
 * When PPD is active, DynAlloc mutes its own governor switching to
 * avoid conflicts (see daemon.js bootstrap step 9).
 */
function checkPowerProfilesDaemon() {
  try {
    const result = execFileSync('gdbus', [
      'call', '--system',
      '--dest', 'net.hadess.PowerProfiles',
      '--object-path', '/net/hadess/PowerProfiles',
      '--method', 'org.freedesktop.DBus.Properties.Get',
      'net.hadess.PowerProfiles', 'ActiveProfile',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    const profileMatch = result.match(/<["']([^"']+)["']>/);
    if (profileMatch) {
      return { active: true, profile: profileMatch[1] };
    }
    return { active: true, profile: 'unknown' };
  } catch (_) {
    return { active: false };
  }
}

function checkGnomeWayland() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const sessionType = process.env.XDG_SESSION_TYPE;
  return desktop.includes('gnome') && sessionType === 'wayland';
}

/**
 * v2.1.4: Sway session detection.
 * Sway sets SWAYSOCK env var on startup. Also accepts XDG_CURRENT_DESKTOP=sway.
 */
function checkSway() {
  return !!process.env.SWAYSOCK ||
    (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('sway');
}

/**
 * v2.1.4: KDE Plasma Wayland session detection.
 * Checks XDG_CURRENT_DESKTOP includes "kde" and session is Wayland
 * (either XDG_SESSION_TYPE=wayland or WAYLAND_DISPLAY is set).
 */
function checkKdeWayland() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const sessionType = process.env.XDG_SESSION_TYPE || '';
  const waylandDisplay = !!process.env.WAYLAND_DISPLAY;
  return desktop.includes('kde') && (sessionType === 'wayland' || waylandDisplay);
}

/**
 * v2.1.4: Check which foreground detection tools are available.
 * Returns an object with boolean flags for each tool the daemon may use.
 */
function checkForegroundTool() {
  const tools = {
    hyprctl: false,
    swaymsg: false,
    qdbus: false,
    kdotool: false,
    xdotool: false,
    gdbus: false,
  };
  // Each tool is checked by attempting `--version` or `--help` with a short timeout.
  const checks = [
    ['hyprctl', ['--version']],
    ['swaymsg', ['--version']],
    ['qdbus', ['--version']],
    ['kdotool', ['--version']],
    ['xdotool', ['--version']],
    ['gdbus', ['--help']],
  ];
  for (const [cmd, args] of checks) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 1500, encoding: 'utf8' });
      tools[cmd] = true;
    } catch (_) { /* not installed or not in PATH */ }
  }
  return tools;
}

function checkX11() {
  const sessionType = process.env.XDG_SESSION_TYPE;
  return sessionType === 'x11';
}

function checkPermissions() {
  const perms = {
    canRenice: false,
    canIonice: false,
    canCgroupWrite: false,
    canGovernorWrite: false,
  };

  // Test renice on self
  try {
    execFileSync('renice', ['-n', '0', '-p', String(process.pid)], { stdio: 'ignore', timeout: 2000 });
    perms.canRenice = true;
  } catch (_) { /* no CAP_SYS_NICE */ }

  // Test ionice on self
  try {
    execFileSync('ionice', ['-c', '2', '-n', '4', '-p', String(process.pid)], { stdio: 'ignore', timeout: 2000 });
    perms.canIonice = true;
  } catch (_) { /* no capability */ }

  // Test cgroup write
  //
  // BUG FIX (v2.1.1): The previous implementation actually wrote the
  // daemon's own PID to `cgroup.procs`, which MOVES the daemon process
  // into the test cgroup. After that, resolveOwnCgroupRelativePath()
  // returns `/dynalloc-self-test` and all subsequent cgroup operations
  // (foreground/background slices, etc.) resolve to wrong paths. The
  // test cgroup was also never cleaned up.
  //
  // The new implementation only tests the ability to mkdir a cgroup
  // directory and write to its `cpu.weight` file (which is the actual
  // resource-control knob the daemon uses). It then removes the test
  // directory. The daemon's own cgroup membership is never touched.
  try {
    const testPath = '/sys/fs/cgroup/dynalloc-self-test';
    fs.mkdirSync(testPath, { recursive: true });
    // Write to cpu.weight — this is a non-destructive control file.
    // If we can write here, we have delegated write access to cgroup v2.
    fs.writeFileSync(path.join(testPath, 'cpu.weight'), '100');
    perms.canCgroupWrite = true;
    // Clean up: remove the test cgroup. rmdir works on empty cgroup
    // directories (we never wrote any PIDs to it).
    try { fs.rmdirSync(testPath); } catch (_) { /* leave it if removal fails */ }
  } catch (_) { /* no cgroup delegation */ }

  // Test governor write
  try {
    fs.accessSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', fs.constants.W_OK);
    perms.canGovernorWrite = true;
  } catch (_) { /* no write access */ }

  return perms;
}

function getKernelVersion() {
  try {
    return fs.readFileSync('/proc/version', 'utf8').trim().split(/\s+/)[2] || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function parseVersion(v) {
  if (!v || typeof v !== 'string') return null;
  const parts = v.split('.').map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0])) return null;
  return { major: parts[0], minor: parts[1] || 0, patch: parts[2] || 0 };
}

/**
 * Print a formatted self-check report.
 */
function printReport(report) {
  info('=== Self-Check Report ===');
  info(`Kernel: ${report.kernelVersion} | Node.js: ${report.nodeVersion}`);

  info(`PSI: cpu=${report.psi.cpu} mem=${report.psi.memory}`);
  info(`Cgroups v2: ${report.cgroupsV2.available ? 'available' : report.cgroupsV2.reason}`);
  if (report.cgroupsV2.controllers) {
    const c = report.cgroupsV2.controllers;
    info(`  Controllers: cpu=${c.cpu} memory=${c.memory} io=${c.io}`);
  }
  info(`cpufreq: ${report.cpufreq.available ? 'available' : 'not available'}`);
  info(`Governor: ${report.governor ? `${report.governor.current} (${report.governor.available.join(', ')})` : 'not available'}`);
  info(`Intel pstate: ${report.intelPstate}`);
  info(`AMD pstate: ${report.amdPstate}`);
  info(`PipeWire: ${report.pipewire}`);
  info(`WirePlumber: ${report.wireplumber}`);
  info(`GameMode: ${report.gamemode}`);
  if (report.powerProfilesDaemon) {
    const ppd = report.powerProfilesDaemon;
    info(`Power Profiles Daemon: ${ppd.active ? `active (profile: "${ppd.profile}")` : 'not running'}`);
  }
  info(`Hyprland: ${report.hyprland}`);
  info(`Sway: ${report.sway}`);
  info(`KDE/Wayland: ${report.kdeWayland}`);
  info(`GNOME/Wayland: ${report.gnomeWayland}`);
  info(`X11: ${report.x11}`);
  if (report.foregroundTool) {
    const ft = report.foregroundTool;
    const present = Object.keys(ft).filter((k) => ft[k]);
    const absent = Object.keys(ft).filter((k) => !ft[k]);
    info(`Foreground tools: ${present.length ? present.join(', ') : '(none)'}${absent.length ? ` | missing: ${absent.join(', ')}` : ''}`);
  }

  info(`Permissions: renice=${report.permissions.canRenice} ionice=${report.permissions.canIonice} cgroup=${report.permissions.canCgroupWrite} governor=${report.permissions.canGovernorWrite}`);
  info(`Capabilities: ${report.capabilities.join(', ') || 'none'}`);

  if (report.warnings.length > 0) {
    for (const w of report.warnings) {
      warn(`Self-check warning: ${w}`);
    }
  }

  if (!report.psi.cpu && !report.psi.memory) {
    warn('PSI tidak tersedia — scheduler tidak bisa membaca pressure. Daemon tetap berjalan tapi tidak ada throttling.');
  }

  info('=== End Self-Check ===');
}

module.exports = {
  runSelfCheck,
  printReport,
};