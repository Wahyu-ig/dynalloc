#!/usr/bin/env node
'use strict';

/**
 * DynAlloc CLI — `dynalloc` command
 * =================================
 *
 * Client tool for the DynAlloc daemon. Connects to the daemon's IPC
 * Unix socket and issues commands. Run `dynalloc help` for usage.
 *
 * Socket resolution (same as daemon):
 *   1. --socket <path> flag
 *   2. $DYNALLOC_IPC_SOCKET env var
 *   3. $XDG_RUNTIME_DIR/dynalloc.sock
 *   4. /tmp/dynalloc-<uid>.sock
 *
 * Exit codes:
 *   0 = success
 *   1 = daemon error (returned ok:false)
 *   2 = connection error (daemon not running / socket not found)
 *   3 = invalid arguments
 */

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const VERSION = '1.0.0';

// ── Socket path resolution ─────────────────────────────────────────────

function resolveSocketPath(cliSocket) {
  if (cliSocket) return cliSocket;
  if (process.env.DYNALLOC_IPC_SOCKET) return process.env.DYNALLOC_IPC_SOCKET;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && fs.existsSync(path.join(xdgRuntime, 'dynalloc.sock'))) {
    return path.join(xdgRuntime, 'dynalloc.sock');
  }
  const uid = (process.getuid && process.getuid()) || os.userInfo().uid;
  return `/tmp/dynalloc-${uid}.sock`;
}

// ── IPC client ─────────────────────────────────────────────────────────

function sendCommand(socketPath, cmd, args = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(socketPath)) {
      reject(new ConnectionError(socketPath));
      return;
    }

    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify({ cmd, args }) + '\n');
    });

    let buffer = '';
    let settled = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx >= 0 && !settled) {
        settled = true;
        const line = buffer.slice(0, idx);
        try {
          const response = JSON.parse(line);
          resolve(response);
        } catch (err) {
          reject(new Error(`invalid response from daemon: ${err.message}`));
        }
        try { socket.end(); } catch (_) { /* noop */ }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new ConnectionError(socketPath));
        } else {
          reject(new Error(`socket error: ${err.message}`));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('connection closed before response received'));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.destroy(); } catch (_) { /* noop */ }
        reject(new Error(`timeout after ${timeoutMs}ms waiting for daemon response`));
      }
    }, timeoutMs).unref();
  });
}

class ConnectionError extends Error {
  constructor(socketPath) {
    super(`cannot connect to daemon at ${socketPath}\n` +
          'The daemon may not be running. Start it with:\n' +
          '  systemctl --user start dynalloc.service\n' +
          '  or\n' +
          '  node /opt/dynalloc/dynalloc-daemon.js');
    this.code = 'NO_DAEMON';
    this.socketPath = socketPath;
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || seconds < 0) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(mb) {
  if (typeof mb !== 'number') return 'N/A';
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// ── Command implementations ────────────────────────────────────────────

async function cmdPing(socketPath) {
  const res = await sendCommand(socketPath, 'ping');
  if (!res.ok) throw new Error(res.error);
  console.log('pong');
  console.log(`daemon: ${res.data.version || 'unknown'}, pid: ${res.data.pid}, uptime: ${formatDuration(res.data.uptime)}`);
}

async function cmdStatus(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'status');
  if (!res.ok) throw new Error(res.error);
  const d = res.data;

  if (opts.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  console.log('DynAlloc Status');
  console.log('='.repeat(60));
  console.log(`${pad('Stress Level:', 20)} ${d.stressLevel || 'N/A'}`);
  console.log(`${pad('Foreground PID:', 20)} ${d.foregroundPid || '(none)'}`);
  console.log(`${pad('Event-driven focus:', 20)} ${d.eventDrivenFocus ? 'yes' : 'no'}`);
  console.log(`${pad('Cgroups Ready:', 20)} ${d.cgroupsReady ? 'yes' : 'no'}`);
  console.log(`${pad('Adaptive Score:', 20)} ${typeof d.adaptiveScore === 'number' ? d.adaptiveScore.toFixed(2) : 'N/A'}`);
  console.log(`${pad('Throttled:', 20)} ${d.throttledCount} process(es)`);
  console.log(`${pad('Media Protected:', 20)} ${d.mediaProtectedCount} process(es)}`);
  console.log(`${pad('Plugins:', 20)} ${(d.plugins && d.plugins.length) ? d.plugins.join(', ') : '(none)'}`);

  if (d.policyEngine) {
    console.log(`${pad('Policy Engine:', 20)} ${d.policyEngine.running ? 'running' : 'stopped'}`);
    if (d.policyEngine.running) {
      console.log(`${pad('  Rules:', 20)} ${d.policyEngine.ruleCount}`);
      console.log(`${pad('  Uptime:', 20)} ${formatDuration(d.policyEngine.uptimeSeconds)}`);
      console.log(`${pad('  Policy file:', 20)} ${d.policyEngine.policyFile || '(none)'}`);
    }
  }

  // v2.1.8: Thermal protection state
  if (d.thermal) {
    console.log('');
    console.log('Thermal Protection:');
    console.log(`${pad('  Enabled:', 18)} ${d.thermal.enabled ? 'yes' : 'no'}`);
    if (d.thermal.enabled) {
      console.log(`${pad('  Last temp:', 18)} ${d.thermal.lastTemp !== null ? d.thermal.lastTemp.toFixed(1) + '°C' : 'N/A'}`);
      console.log(`${pad('  Pause threshold:', 18)} ${d.thermal.pauseThreshold}°C`);
      console.log(`${pad('  Resume threshold:', 18)} ${d.thermal.resumeThreshold}°C`);
      console.log(`${pad('  Paused:', 18)} ${d.thermal.paused ? 'YES' : 'no'}`);
      if (d.thermal.paused) {
        console.log(`${pad('  Remaining:', 18)} ${(d.thermal.pausedRemainingMs / 1000).toFixed(1)}s`);
      }
      console.log(`${pad('  Pause count:', 18)} ${d.thermal.pauseCount}`);
    }
  }

  if (d.throttledCount > 0 && d.throttledProcesses && d.throttledProcesses.length) {
    console.log('');
    console.log('Throttled processes:');
    for (const p of d.throttledProcesses) {
      console.log(`  PID ${p.pid}  ${p.comm || '(unknown)'}`);
    }
  }
}

async function cmdStats(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'stats');
  if (!res.ok) throw new Error(res.error);
  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  // The daemon returns the formatted text report
  console.log(res.data.report || JSON.stringify(res.data, null, 2));
}

async function cmdMetrics(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'metrics');
  if (!res.ok) throw new Error(res.error);
  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  const m = res.data;
  console.log('DynAlloc Metrics (JSON)');
  console.log('='.repeat(60));
  console.log(JSON.stringify(m, null, 2));
}

async function cmdBoost(socketPath, pidArg, opts = {}) {
  const pid = parseInt(pidArg, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`Error: invalid PID "${pidArg}"`);
    process.exit(3);
  }
  console.log(`Boosting PID ${pid}...`);
  const res = await sendCommand(socketPath, 'boost', { pid });
  if (!res.ok) throw new Error(res.error);
  const b = res.data;
  if (opts.json) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }
  console.log(`✓ Boosted PID ${pid} (${b.comm || 'unknown'})`);
  console.log(`  Class:    ${b.schedClass || 'N/A'}`);
  console.log(`  Nice:     ${b.nice}`);
  console.log(`  IO:       class ${b.ioClass}, level ${b.ioLevel}`);
  console.log(`  Cores:    [${(b.cores || []).join(', ')}]`);
  if (b.governor) console.log(`  Governor: ${b.governor}`);
}

async function cmdThrottle(socketPath, pidArg, opts = {}) {
  const pid = parseInt(pidArg, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`Error: invalid PID "${pidArg}"`);
    process.exit(3);
  }
  console.log(`Throttling PID ${pid}...`);
  const res = await sendCommand(socketPath, 'throttle', { pid });
  if (!res.ok) throw new Error(res.error);
  const t = res.data;
  if (opts.json) {
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  console.log(`✓ Throttled PID ${pid} (${t.comm || 'unknown'})`);
  console.log(`  Nice:   ${t.nice}`);
  console.log(`  IO:     class ${t.ioClass}, level ${t.ioLevel}`);
  console.log(`  Cores:  [${(t.cores || []).join(', ')}]`);
}

async function cmdRestore(socketPath, pidArg, opts = {}) {
  const pid = parseInt(pidArg, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`Error: invalid PID "${pidArg}"`);
    process.exit(3);
  }
  console.log(`Restoring PID ${pid}...`);
  const res = await sendCommand(socketPath, 'restore', { pid });
  if (!res.ok) throw new Error(res.error);
  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  console.log(`✓ Restored PID ${pid} to default state (nice=0, all cores, default IO)`);
}

async function cmdThrottled(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'throttled');
  if (!res.ok) throw new Error(res.error);
  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  const list = res.data.list || [];
  if (list.length === 0) {
    console.log('No processes currently throttled.');
    return;
  }
  console.log(`Throttled processes (${list.length}):`);
  console.log('  PID        Comm                  Throttled Since');
  console.log('  ' + '-'.repeat(56));
  for (const p of list) {
    const since = p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : 'N/A';
    console.log(`  ${pad(p.pid, 10)}  ${pad(p.comm || '(unknown)', 20)}  ${since}`);
  }
}

// v0.4.0 Phase 2: Network QoS status command
async function cmdNetwork(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'network');
  if (!res.ok) throw new Error(res.error);
  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  const s = res.data;
  if (!s || s.enabled === false) {
    console.log('Network QoS: disabled (set ENABLE_NETWORK_QOS=true in config to enable)');
    return;
  }
  console.log('Network QoS Status');
  console.log('='.repeat(60));
  console.log(`  ${pad('Enabled:', 22)} ${s.enabled ? 'yes' : 'no'}`);
  console.log(`  ${pad('Available:', 22)} ${s.available ? 'yes' : 'no'}`);
  console.log(`  ${pad('Interface:', 22)} ${s.interface || '(not resolved)'}`);
  console.log(`  ${pad('HTB qdisc installed:', 22)} ${s.qdiscInstalled ? 'yes' : 'no'}`);
  console.log(`  ${pad('nftables table:', 22)} ${s.nftTableCreated ? 'created' : 'not created'}`);
  console.log(`  ${pad('Use nftables:', 22)} ${s.useNftables ? 'yes' : 'no'}`);
  if (s.caps) {
    console.log(`  ${pad('tc binary:', 22)} ${s.caps.tc ? 'found' : 'missing'}`);
    console.log(`  ${pad('nft binary:', 22)} ${s.caps.nft ? 'found' : 'missing'}`);
    console.log(`  ${pad('Running as root:', 22)} ${s.caps.root ? 'yes' : 'no'}`);
  }
  if (s.rates) {
    console.log(`  ${pad('Foreground rate:', 22)} ${s.rates.foreground}`);
    console.log(`  ${pad('Background rate:', 22)} ${s.rates.background}`);
  }
}

async function cmdDoctor(socketPath, opts = {}) {
  console.log('DynAlloc Doctor');
  console.log('='.repeat(60));

  let allOk = true;

  // 1. Daemon connectivity
  let daemonInfo;
  try {
    const res = await sendCommand(socketPath, 'ping');
    if (!res.ok) throw new Error(res.error);
    daemonInfo = res.data;
    console.log(`${pad('Daemon:', 22)} ✓ running (PID ${daemonInfo.pid}, uptime ${formatDuration(daemonInfo.uptime)})`);
  } catch (err) {
    console.log(`${pad('Daemon:', 22)} ✗ not reachable`);
    console.log('');
    console.log('  ' + err.message);
    console.log('');
    console.log('The daemon is not running or the IPC socket is not accessible.');
    console.log('Start it with:');
    console.log('  systemctl --user start dynalloc.service');
    console.log('  or');
    console.log('  node /opt/dynalloc/dynalloc-daemon.js');
    process.exit(2);
  }

  // 2. Get full self-check report from daemon
  const scRes = await sendCommand(socketPath, 'doctor');
  if (!scRes.ok) {
    console.log(`${pad('Doctor:', 22)} ✗ ${scRes.error}`);
    process.exit(1);
  }
  const report = scRes.data;

  // 3. Print each check
  const checks = [
    ['PSI (CPU)', report.psi && report.psi.cpu],
    ['PSI (Memory)', report.psi && report.psi.memory],
    ['Cgroups v2', report.cgroupsV2 && report.cgroupsV2.available],
    ['cpufreq', report.cpufreq && report.cpufreq.available],
    ['PipeWire', report.pipewire],
    ['WirePlumber', report.wireplumber],
    ['GameMode', report.gamemode],
    ['Power Profiles Daemon', report.powerProfilesDaemon && report.powerProfilesDaemon.active],
    ['Hyprland', report.hyprland],
    ['Sway', report.sway],
    ['KDE/Wayland', report.kdeWayland],
    ['GNOME/Wayland', report.gnomeWayland],
    ['X11', report.x11],
  ];
  for (const [name, ok] of checks) {
    console.log(`${pad(name + ':', 22)} ${ok ? '✓' : '✗'} ${ok ? 'ok' : 'not available'}`);
    if (!ok) allOk = false;
  }

  // Foreground detection tools
  if (report.foregroundTool) {
    console.log('');
    console.log('Foreground tools:');
    const ft = report.foregroundTool;
    const toolDescs = {
      hyprctl: 'Hyprland IPC',
      swaymsg: 'Sway IPC',
      qdbus: 'KDE KWin DBus',
      kdotool: 'KWin (third-party)',
      xdotool: 'X11',
      gdbus: 'GNOME Shell DBus',
    };
    for (const [tool, present] of Object.entries(ft)) {
      console.log(`  ${pad(tool, 12)} ${present ? '✓' : '✗'} ${toolDescs[tool] || ''}`);
    }
  }

  // 4. Permissions
  const p = report.permissions || {};
  console.log('');
  console.log('Permissions:');
  console.log(`  renice:   ${p.canRenice ? '✓' : '✗'} ${p.canRenice ? '' : '(no CAP_SYS_NICE)'}`);
  console.log(`  ionice:   ${p.canIonice ? '✓' : '✗'} ${p.canIonice ? '' : '(no CAP_SYS_NICE)'}`);
  console.log(`  cgroup:   ${p.canCgroupWrite ? '✓' : '✗'} ${p.canCgroupWrite ? '' : '(no delegation)'}`);
  console.log(`  governor: ${p.canGovernorWrite ? '✓' : '✗'} ${p.canGovernorWrite ? '' : '(needs root or sudo)'}`);
  if (!p.canRenice || !p.canIonice) allOk = false;

  // 5. Capabilities
  if (report.capabilities && report.capabilities.length) {
    console.log('');
    console.log(`Capabilities: ${report.capabilities.join(', ')}`);
  }

  // 6. Warnings
  if (report.warnings && report.warnings.length) {
    console.log('');
    console.log('Warnings:');
    for (const w of report.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  // 7. Daemon state diagnostics
  if (report.daemonState) {
    const ds = report.daemonState;
    console.log('');
    console.log('Daemon state:');
    console.log(`  Stress level:     ${ds.stressLevel}`);
    console.log(`  Foreground PID:   ${ds.foregroundPid || '(none)'}`);
    console.log(`  Throttled:        ${ds.throttledCount} process(es)`);
    console.log(`  Cgroups ready:    ${ds.cgroupsReady ? 'yes' : 'no'}`);
  }

  // 8. Diagnostics & suggestions
  console.log('');
  console.log('Diagnostics:');
  const diags = [];
  if (!p.canRenice) {
    diags.push('⚠ renice/ionice need CAP_SYS_NICE — run: sudo setcap "cap_sys_nice+ep" /usr/bin/renice /usr/bin/ionice');
  }
  if (!p.canGovernorWrite && report.cpufreq && report.cpufreq.available) {
    diags.push('⚠ Governor write requires sudo — set GOVERNOR_USE_SUDO: true and add a sudoers rule for cpupower');
  }
  if (!p.canCgroupWrite && report.cgroupsV2 && report.cgroupsV2.available) {
    diags.push('⚠ Cgroup write failed — add Delegate=cpu to /etc/systemd/system/user@.service.d/delegate.conf');
  }
  if (!report.psi.cpu && !report.psi.memory) {
    diags.push('⚠ PSI not available — kernel must be >= 5.2 and not booted with psi=0');
  }
  // PPD coordination diagnostic
  if (report.powerProfilesDaemon && report.powerProfilesDaemon.active) {
    diags.push(`ℹ Power Profiles Daemon (PPD) is running (profile: "${report.powerProfilesDaemon.profile}") — DynAlloc governor switching is muted to avoid conflict. Set ENABLE_PPD_COORDINATION=false to override.`);
  }

  // Foreground detection tool suggestions
  if (report.foregroundTool) {
    const ft = report.foregroundTool;
    if (report.hyprland && !ft.hyprctl) {
      diags.push('⚠ Hyprland session detected but hyprctl not found — install hyprland package');
    }
    if (report.sway && !ft.swaymsg) {
      diags.push('⚠ Sway session detected but swaymsg not found — install sway package');
    }
    if (report.kdeWayland && !ft.qdbus && !ft.kdotool) {
      diags.push('⚠ KDE/Wayland session detected but neither qdbus nor kdotool available — install qt6-tools or kdotool');
    }
    if (report.gnomeWayland && !ft.gdbus) {
      diags.push('⚠ GNOME/Wayland session detected but gdbus not found — install glib2 package');
    }
    if (report.x11 && !ft.xdotool) {
      diags.push('⚠ X11 session detected but xdotool not found — install xdotool package');
    }
  }
  if (diags.length === 0) {
    console.log('  ✓ All critical systems operational');
  } else {
    for (const d of diags) console.log(`  ${d}`);
    allOk = false;
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(allOk ? 'Result: ✓ HEALTHY' : 'Result: ⚠ ISSUES DETECTED (see above)');
  process.exit(allOk ? 0 : 1);
}

function cmdHelp() {
  console.log(`
DynAlloc CLI v${VERSION} — Dynamic Resource Allocator

Usage:
  dynalloc <command> [arguments] [options]

Commands:
  status                 Show current daemon state (stress, foreground, throttled, etc.)
  stats                  Show full metrics report (latencies, counters, gauges)
  metrics                Show raw metrics as JSON (for scripting)
  throttled              List currently throttled processes
  network                Show Network QoS status (Phase 2; requires ENABLE_NETWORK_QOS=true)
  boost <pid>            Manually boost a process (foreground priority)
  throttle <pid>         Manually throttle a process (background priority)
  restore <pid>          Restore a process to default state
  doctor                 Run health diagnostics and check system requirements
  ping                   Check if daemon is running
  help                   Show this help message
  version                Show CLI version

Options:
  --socket <path>        Override IPC socket path
  --json                 Output as JSON (for status, stats, boost, throttle, restore)
  --timeout <ms>         Response timeout in milliseconds (default: 5000)

Environment variables:
  DYNALLOC_IPC_SOCKET    Override IPC socket path
  XDG_RUNTIME_DIR        Used for default socket location

Socket resolution order:
  1. --socket flag
  2. $DYNALLOC_IPC_SOCKET
  3. $XDG_RUNTIME_DIR/dynalloc.sock
  4. /tmp/dynalloc-<uid>.sock

Exit codes:
  0 = success
  1 = daemon error
  2 = connection error (daemon not running)
  3 = invalid arguments

Examples:
  dynalloc status
  dynalloc status --json | jq .stressLevel
  dynalloc boost 12345
  dynalloc throttle $(pgrep -x chrome)
  dynalloc doctor
  dynalloc stats --json > metrics.json

See also:
  man dynalloc           (if installed)
  /opt/dynalloc/Configuration.md
`);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    cmdHelp();
    process.exit(0);
  }

  // Parse global options
  let socketOverride = null;
  let jsonOutput = false;
  let timeoutMs = 5000;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--socket' || a === '-s') {
      socketOverride = args[++i];
    } else if (a === '--json' || a === '-j') {
      jsonOutput = true;
    } else if (a === '--timeout') {
      timeoutMs = parseInt(args[++i], 10);
    } else if (a === '--help' || a === '-h') {
      cmdHelp();
      process.exit(0);
    } else if (a === '--version' || a === '-V') {
      console.log(`dynalloc ${VERSION}`);
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown option: ${a}`);
      console.error('Run `dynalloc help` for usage.');
      process.exit(3);
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    cmdHelp();
    process.exit(0);
  }

  const command = positional[0].toLowerCase();
  const socketPath = resolveSocketPath(socketOverride);
  const opts = { json: jsonOutput, timeout: timeoutMs };

  try {
    switch (command) {
      case 'ping':
        await cmdPing(socketPath);
        break;
      case 'status':
        await cmdStatus(socketPath, opts);
        break;
      case 'stats':
        await cmdStats(socketPath, opts);
        break;
      case 'metrics':
        await cmdMetrics(socketPath, opts);
        break;
      case 'throttled':
      case 'list':
        await cmdThrottled(socketPath, opts);
        break;
      case 'network':
        await cmdNetwork(socketPath, opts);
        break;
      case 'boost':
        if (!positional[1]) {
          console.error('Error: boost requires a PID argument');
          console.error('Usage: dynalloc boost <pid>');
          process.exit(3);
        }
        await cmdBoost(socketPath, positional[1], opts);
        break;
      case 'throttle':
        if (!positional[1]) {
          console.error('Error: throttle requires a PID argument');
          console.error('Usage: dynalloc throttle <pid>');
          process.exit(3);
        }
        await cmdThrottle(socketPath, positional[1], opts);
        break;
      case 'restore':
        if (!positional[1]) {
          console.error('Error: restore requires a PID argument');
          console.error('Usage: dynalloc restore <pid>');
          process.exit(3);
        }
        await cmdRestore(socketPath, positional[1], opts);
        break;
      case 'doctor':
        await cmdDoctor(socketPath, opts);
        break;
      case 'help':
      case '--help':
      case '-h':
        cmdHelp();
        break;
      case 'version':
      case '--version':
      case '-V':
        console.log(`dynalloc ${VERSION}`);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run `dynalloc help` for usage.');
        process.exit(3);
    }
  } catch (err) {
    if (err && err.code === 'NO_DAEMON') {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
}

main();
