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

const VERSION = '2.0.0';

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

// ── v2.0: Enhanced Doctor ─────────────────────────────────────────

// (cmdDoctor: see the v2.0 Intelligence-subsystem implementation further
// below, which is the one actually used — see note there.)

// ── watch command (v1.1.0) ────────────────────────────────────────────
//
// `dynalloc watch` displays a live, ANSI-rendered dashboard that
// refreshes every second. The renderer is in lib/watch-renderer.js;
// this function is responsible for:
//   - polling daemon state (status + metrics IPC commands)
//   - polling /proc for CPU/memory
//   - capturing Ctrl+C and exiting cleanly
//
// Anti-flicker: we use cursor-home + line padding rather than
// full-screen clear on every frame. See lib/watch-renderer.js.

const renderer = require('./lib/watch-renderer');

async function cmdWatch(socketPath, opts = {}) {
  // Verify daemon is reachable before entering the live loop
  let pingRes;
  try {
    pingRes = await sendCommand(socketPath, 'ping', {}, opts.timeout || 5000);
  } catch (err) {
    if (err && err.code === 'NO_DAEMON') {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (!pingRes.ok) {
    console.error(`Error: daemon ping failed: ${pingRes.error}`);
    process.exit(1);
  }

  // Daemon is alive — start the live loop
  const refreshMs = opts.refreshMs || 1000;
  const width = opts.width || (process.stdout.columns || 80);
  let firstFrame = true;
  let stopped = false;
  let lastCpuSample = null;
  const eventBuffer = []; // ring buffer of recent events, max 20

  // Handle Ctrl+C cleanly: on first SIGINT, exit immediately; show cursor.
  const onSigInt = () => {
    if (stopped) return;
    stopped = true;
    process.stdout.write('\n');
    process.stdout.write(renderer.renderExit());
    process.exit(0);
  };
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigInt);

  // Read /proc for CPU usage (sample-based)
  function readCpuSample() {
    try {
      const raw = fs.readFileSync('/proc/stat', 'utf8');
      const line = raw.split('\n')[0];
      // format: cpu  user nice system idle iowait irq softirq steal guest guest_nice
      const parts = line.split(/\s+/).slice(1).map((n) => parseInt(n, 10));
      const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
      const total = user + nice + system + idle + iowait + irq + softirq + steal;
      const idleAll = idle + iowait;
      return { total, idle: idleAll, ts: Date.now() };
    } catch (_) {
      return null;
    }
  }

  function calcCpuUsage(curr, prev) {
    if (!curr || !prev) return null;
    const totalDelta = curr.total - prev.total;
    const idleDelta = curr.idle - prev.idle;
    if (totalDelta <= 0) return null;
    return ((totalDelta - idleDelta) / totalDelta) * 100;
  }

  function readMemory() {
    try {
      const raw = fs.readFileSync('/proc/meminfo', 'utf8');
      const get = (key) => {
        const m = raw.match(new RegExp(`${key}:\\s+(\\d+)`));
        return m ? parseInt(m[1], 10) * 1024 : null; // kB → bytes
      };
      const memTotal = get('MemTotal');
      const memAvailable = get('MemAvailable');
      const memFree = get('MemFree');
      if (memTotal === null) return null;
      const used = memTotal - (memAvailable !== null ? memAvailable : memFree);
      return { totalBytes: memTotal, usedBytes: used };
    } catch (_) {
      return null;
    }
  }

  function readLoad1m() {
    try {
      const raw = fs.readFileSync('/proc/loadavg', 'utf8');
      const v = parseFloat(raw.split(' ')[0]);
      return Number.isFinite(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  function readCoreCount() {
    try {
      const raw = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const matches = raw.match(/^processor\s*:/gm);
      return matches ? matches.length : null;
    } catch (_) {
      return null;
    }
  }

  // Read CPU PSI (if available)
  function readCpuPsi() {
    try {
      const raw = fs.readFileSync('/proc/pressure/cpu', 'utf8');
      const m = raw.match(/avg10=(\d+\.\d+)/);
      return m ? parseFloat(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function readMemPsi() {
    try {
      const raw = fs.readFileSync('/proc/pressure/memory', 'utf8');
      const m = raw.match(/avg10=(\d+\.\d+)/);
      return m ? parseFloat(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  // Poll daemon for state + metrics. Failures degrade gracefully.
  async function fetchDaemonState() {
    const result = { status: null, metrics: null, throttled: null };
    try {
      const [statusRes, metricsRes, throttledRes] = await Promise.all([
        sendCommand(socketPath, 'status', {}, 2000),
        sendCommand(socketPath, 'metrics', {}, 2000),
        sendCommand(socketPath, 'throttled', {}, 2000),
      ]);
      if (statusRes.ok) result.status = statusRes.data;
      if (metricsRes.ok) result.metrics = metricsRes.data;
      if (throttledRes.ok) result.throttled = throttledRes.data;
    } catch (err) {
      // Daemon may have gone away mid-watch — show a degraded frame.
      result.error = err.message || String(err);
    }
    return result;
  }

  // Convert the daemon state into the snapshot shape expected by the
  // renderer. Returns null for fields that are unavailable.
  function buildSnapshot(daemonState, pingData) {
    const s = daemonState.status || {};
    const m = daemonState.metrics || {};
    const throttledList = (daemonState.throttled && daemonState.throttled.list) || [];

    // CPU
    const cpuSample = readCpuSample();
    const usagePercent = calcCpuUsage(cpuSample, lastCpuSample);
    lastCpuSample = cpuSample;
    const mem = readMemory();
    const load1m = readLoad1m();
    const coreCount = readCoreCount();
    const cpuPsi = readCpuPsi();
    const memPsi = readMemPsi();

    // Foreground process — try to read comm from /proc
    let foreground = null;
    if (s.foregroundPid) {
      let comm = null;
      try {
        comm = fs.readFileSync(`/proc/${s.foregroundPid}/comm`, 'utf8').trim();
      } catch (_) { /* foreground process may have exited */ }
      foreground = { pid: s.foregroundPid, comm };
    }

    // Throttled list (with comm resolved where possible)
    const throttled = throttledList.map((p) => ({
      pid: p.pid,
      comm: p.comm || null,
      since: p.timestamp || null,
    }));

    // Plugins
    const plugins = s.plugins || [];

    // Active policy — read from policy engine status if available
    let policy = null;
    if (s.policyEngine && s.policyEngine.running) {
      policy = {
        name: s.policyEngine.policyFile ? path.basename(s.policyEngine.policyFile, '.json') : null,
        priority: 0,
      };
    }

    // Current profile — read from metrics if available (Profile Manager)
    let profile = null;
    if (typeof m.current_profile === 'string' && m.current_profile.length > 0) {
      profile = { name: m.current_profile };
    }

    // Governor
    let governor = null;
    if (typeof m.current_governor === 'string' && m.current_governor.length > 0) {
      governor = { name: m.current_governor };
    }

    // Boosted PIDs — we don't have a direct IPC for this, but metrics
    // may include a list. Fall back to an empty list.
    const boosted = Array.isArray(m.boosted_pids)
      ? m.boosted_pids.map((pid) => ({ pid, comm: null }))
      : [];

    // Events — best-effort from a local ring buffer. The CLI doesn't
    // subscribe to the bus, so we approximate by diffing status. The
    // event buffer starts empty; this is informational only.
    const events = eventBuffer.slice();

    return {
      daemon: {
        version: pingData ? pingData.version : null,
        pid: pingData ? pingData.pid : null,
        uptime: pingData ? pingData.uptime : null,
      },
      cpu: {
        usagePercent,
        load1m,
        coreCount,
        pressurePercent: cpuPsi,
      },
      memory: mem ? {
        usedBytes: mem.usedBytes,
        totalBytes: mem.totalBytes,
        pressurePercent: memPsi,
      } : { pressurePercent: memPsi },
      scheduler: {
        stressLevel: s.stressLevel,
        adaptiveScore: s.adaptiveScore,
        fastTickMs: m.fast_tick_interval_ms,
      },
      policy,
      profile,
      governor,
      foreground,
      boosted,
      throttled,
      plugins,
      events,
      thermal: s.thermal ? {
        enabled: s.thermal.enabled,
        paused: s.thermal.paused,
        lastTemp: s.thermal.lastTemp,
        threshold: s.thermal.pauseThreshold,
      } : null,
    };
  }

  // Main loop — runs once per refresh interval
  let tickInProgress = false;  // guard against overlapping ticks
  async function tick() {
    if (stopped) return;
    // If the previous tick is still running (e.g. daemon is slow),
    // skip this one. This prevents out-of-order writes to stdout
    // and avoids piling up IPC requests.
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      const daemonState = await fetchDaemonState();
      const snapshot = buildSnapshot(daemonState, pingRes.data);

      // Detect simple state changes for the event buffer
      // (e.g. foreground changed, throttled count changed)
      // This is a best-effort approximation — not a full event subscription.
      // We keep the buffer small (max 20 entries).
      const fgPid = snapshot.foreground && snapshot.foreground.pid;
      if (fgPid && fgPid !== _lastFgPid) {
        eventBuffer.push({
          ts: Date.now(),
          type: 'foreground',
          comm: snapshot.foreground.comm,
          pid: fgPid,
        });
        _lastFgPid = fgPid;
      }
      const throttledCount = snapshot.throttled.length;
      if (throttledCount !== _lastThrottledCount) {
        const delta = throttledCount - _lastThrottledCount;
        if (delta > 0) {
          eventBuffer.push({
            ts: Date.now(),
            type: 'throttle',
            comm: snapshot.throttled[snapshot.throttled.length - 1]
              ? snapshot.throttled[snapshot.throttled.length - 1].comm : null,
            pid: snapshot.throttled[snapshot.throttled.length - 1]
              ? snapshot.throttled[snapshot.throttled.length - 1].pid : null,
          });
        } else if (delta < 0) {
          eventBuffer.push({
            ts: Date.now(),
            type: 'restore',
          });
        }
        _lastThrottledCount = throttledCount;
      }
      while (eventBuffer.length > 20) eventBuffer.shift();

      const frame = renderer.renderFrame(snapshot, { width, firstFrame });
      process.stdout.write(frame);
      firstFrame = false;
    } catch (err) {
      // Render an error frame instead of crashing
      const errFrame = renderer.renderFrame({
        daemon: {},
        cpu: {}, memory: {}, scheduler: {},
        foreground: null, boosted: [], throttled: [],
        plugins: [], events: [],
        error: err.message,
      }, { width, firstFrame });
      process.stdout.write(errFrame);
      firstFrame = false;
    } finally {
      tickInProgress = false;
    }
  }

  let _lastFgPid = null;
  let _lastThrottledCount = 0;

  // Initial frame immediately
  await tick();
  // Then refresh every refreshMs. Use unref() so the timer doesn't
  // keep the event loop alive if the user kills the process.
  const interval = setInterval(tick, refreshMs);
  if (typeof interval.unref === 'function') interval.unref();

  // Keep the process alive — the setInterval is unref'd, so we need
  // a blocking call. We use a Promise that never resolves; SIGINT
  // handler will exit the process.
  return new Promise(() => {});
}

// ── v2.0: Enhanced Doctor ─────────────────────────────────────────

async function cmdDoctor(socketPath, opts = {}) {
  console.log('DynAlloc Doctor v2.0');
  console.log('='.repeat(60));

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
    process.exit(2);
  }

  const res = await sendCommand(socketPath, 'doctor');
  if (!res.ok) {
    console.log(`${pad('Doctor:', 22)} ✗ ${res.error}`);
    process.exit(1);
  }

  const data = res.data;

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Print health score
  if (data.percentage != null) {
    const pct = data.percentage;
    let label = 'POOR';
    if (pct >= 90) label = 'EXCELLENT';
    else if (pct >= 70) label = 'GOOD';
    else if (pct >= 50) label = 'FAIR';
    console.log('');
    console.log(`${pad('Health Score:', 22)} ${pct}% (${label})`);
    console.log(`${pad('Summary:', 22)} ${data.summary}`);
    console.log('');
  }

  // Print checks
  const checks = data.checks || [];
  let passCount = 0, warnCount = 0, errCount = 0;
  for (const c of checks) {
    const icon = c.status === 'PASS' ? '✓' : c.status === 'WARNING' ? '⚠' : '✗';
    console.log(`  ${icon} ${pad(c.name, 35)} ${c.message}`);
    if (c.status === 'PASS') passCount++;
    else if (c.status === 'WARNING') warnCount++;
    else errCount++;
  }

  console.log('');
  console.log(`  ${pad('Result:', 35)} ${passCount} PASS, ${warnCount} WARNING, ${errCount} ERROR`);
}

// ── v2.0: HTML Report ──────────────────────────────────────────────

async function cmdReport(socketPath, opts = {}) {
  console.log('Generating diagnostic report...');
  const res = await sendCommand(socketPath, 'report', {}, 15000);
  if (!res.ok) {
    if (res.error) console.error(`Error: ${res.error}`);
    else console.error('Failed to generate report.');
    process.exit(1);
  }

  if (!res.data.html) {
    console.error('Error: daemon returned no HTML content.');
    process.exit(1);
  }

  const outputPath = opts.output || 'dynalloc-report.html';
  fs.writeFileSync(outputPath, res.data.html, 'utf8');
  console.log(`✓ Report saved to ${outputPath} (${(res.data.html.length / 1024).toFixed(1)} KB)`);
}

// ── v2.0: Timeline ────────────────────────────────────────────────

async function cmdTimeline(socketPath, opts = {}) {
  const args = {};
  if (opts.category) args.category = opts.category;
  if (opts.limit) args.limit = parseInt(opts.limit, 10);
  if (opts.search) args.search = opts.search;
  if (opts.severity) args.severity = opts.severity;

  const res = await sendCommand(socketPath, 'timeline', args);
  if (!res.ok) throw new Error(res.error);

  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  const { entries, total, filtered } = res.data;
  if (entries.length === 0) {
    console.log('No timeline events recorded.');
    return;
  }

  console.log(`Timeline (${filtered} of ${total} events):`);
  console.log('='.repeat(60));

  for (const e of entries) {
    const ts = new Date(e.ts).toLocaleTimeString();
    const sev = e.severity === 'warn' ? ' ⚠' : e.severity === 'error' ? ' ✗' : '';
    console.log(`  ${ts}  [${pad(e.category, 12)}]  ${e.summary}${sev}`);
  }
}

// ── v2.0: Recommendations ──────────────────────────────────────────

async function cmdRecommendations(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'recommendations', {});
  if (!res.ok) throw new Error(res.error);

  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (!res.data.enabled) {
    console.log('Recommendations: disabled (ENABLE_INTELLIGENCE=false)');
    return;
  }

  const pending = res.data.pending || [];
  if (pending.length === 0) {
    console.log('No pending recommendations.');
    return;
  }

  console.log(`Pending Recommendations (${pending.length}):`);
  console.log('='.repeat(60));

  for (const r of pending) {
    const confidence = (r.confidence * 100).toFixed(0);
    const priority = (r.priority || 'medium').toUpperCase();
    console.log(`  [${priority}] ${r.summary} (${confidence}% confidence)`);
    console.log(`         → ${r.suggestion}`);
    console.log(`         ID: ${r.id} | Type: ${r.type}`);
    console.log(`         Approve: dynalloc recommendations --approve ${r.id}`);
    console.log(`         Dismiss: dynalloc recommendations --dismiss ${r.id}`);
    console.log('');
  }
}

// ── v2.0: Explanations ────────────────────────────────────────────

async function cmdExplanations(socketPath, opts = {}) {
  const args = {};
  if (opts.type) args.type = opts.type;
  if (opts.limit) args.limit = parseInt(opts.limit, 10);

  const res = await sendCommand(socketPath, 'explanations', args);
  if (!res.ok) throw new Error(res.error);

  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (res.data.length === 0) {
    console.log('No explanations recorded yet.');
    return;
  }

  console.log('Recent Explanations:');
  console.log('='.repeat(60));

  for (const e of res.data) {
    console.log(`  ${new Date(e.ts).toLocaleTimeString()} | ${e.decision} | ${e.target}`);
    console.log(`  Outcome: ${e.outcome}`);
    for (const f of e.factors) {
      const icon = f.result ? '✓' : '✗';
      console.log(`    ${icon} ${f.check}${f.value != null ? ` (${f.value})` : ''}`);
    }
    console.log('');
  }
}

// ── v2.0: Intelligence Status ──────────────────────────────────────

async function cmdIntelligence(socketPath, opts = {}) {
  const res = await sendCommand(socketPath, 'intelligence');
  if (!res.ok) throw new Error(res.error);

  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (!res.data.enabled) {
    console.log('Intelligence subsystem: disabled');
    return;
  }

  const d = res.data;
  console.log('Intelligence Subsystem');
  console.log('='.repeat(60));

  if (d.learningEngine) {
    const le = d.learningEngine;
    console.log(`  Learning Engine:`);
    console.log(`    Observations: ${le.totalObservations}`);
    console.log(`    Unique Apps:  ${le.uniqueApps}`);
    console.log(`    Patterns:     ${le.uniquePatterns}`);
    console.log(`    CPU Intensive:${le.cpuIntensiveApps}`);
    console.log(`    Peak Hours:   [${(le.peakHours || []).join(', ')}]`);
    console.log(`    Top Apps:     ${(le.topApps || []).map(a => `${a.comm}(${a.count})`).join(', ')}`);
  }

  if (d.recommendationEngine) {
    const re = d.recommendationEngine;
    console.log(`  Recommendation Engine:`);
    console.log(`    Pending:    ${re.pendingCount}`);
    console.log(`    Dismissed:  ${re.dismissedCount}`);
    console.log(`    Approved:   ${re.approvedCount}`);
    console.log(`    Generated:  ${re.totalGenerated}`);
  }

  if (d.explainabilityEngine) {
    const ee = d.explainabilityEngine;
    console.log(`  Explainability Engine:`);
    console.log(`    Buffered:   ${ee.bufferSize}/${ee.maxBufferSize}`);
    console.log(`    Total:      ${ee.totalRecorded}`);
  }

  if (d.timelineEngine) {
    const te = d.timelineEngine;
    console.log(`  Timeline Engine:`);
    console.log(`    Events:     ${te.bufferSize}/${te.maxBufferSize}`);
    console.log(`    Total:      ${te.totalRecorded}`);
    console.log(`    Categories: ${JSON.stringify(te.byCategory || {})}`);
  }
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
  watch                  Live dashboard — refreshes every 1s (Ctrl+C to exit)
  throttled              List currently throttled processes
  network                Show Network QoS status (Phase 2; requires ENABLE_NETWORK_QOS=true)
  boost <pid>            Manually boost a process (foreground priority)
  throttle <pid>         Manually throttle a process (background priority)
  restore <pid>          Restore a process to default state
  doctor                 Run comprehensive health check with score (v2.0)
  report [file]          Generate standalone HTML diagnostic report (v2.0)
  timeline               Show event timeline (v2.0)
  recommendations        Show pending AI recommendations (v2.0)
  explanations           Show recent decision explanations (v2.0)
  intelligence           Show intelligence subsystem status (v2.0)
  ping                   Check if daemon is running
  help                   Show this help message
  version                Show CLI version

Options:
  --socket <path>        Override IPC socket path
  --json                 Output as JSON (for status, stats, boost, throttle, restore)
  --timeout <ms>         Response timeout in milliseconds (default: 5000)
  --refresh <ms>         Refresh interval for watch (default: 1000)
  --width <cols>         Terminal width for watch (default: auto-detect)

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
  dynalloc watch
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
  let refreshMs = 1000;
  let watchWidth = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--socket' || a === '-s') {
      socketOverride = args[++i];
    } else if (a === '--json' || a === '-j') {
      jsonOutput = true;
    } else if (a === '--timeout') {
      timeoutMs = parseInt(args[++i], 10);
    } else if (a === '--refresh') {
      // watch-only option: refresh interval in ms (minimum 100ms)
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v) && v >= 100) {
        refreshMs = v;
      } else {
        console.error(`Error: --refresh must be a number >= 100 (got "${v}")`);
        process.exit(3);
      }
    } else if (a === '--width') {
      // watch-only option: terminal width override
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v) && v >= 40) {
        watchWidth = v;
      } else {
        console.error(`Error: --width must be a number >= 40 (got "${v}")`);
        process.exit(3);
      }
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
  const opts = {
    json: jsonOutput,
    timeout: timeoutMs,
    refreshMs,
    width: watchWidth,
  };

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
      case 'watch':
        await cmdWatch(socketPath, opts);
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
      case 'report':
        opts.output = positional[1] || null;
        await cmdReport(socketPath, opts);
        break;
      case 'timeline':
        await cmdTimeline(socketPath, opts);
        break;
      case 'recommendations':
        await cmdRecommendations(socketPath, opts);
        break;
      case 'explanations':
        await cmdExplanations(socketPath, opts);
        break;
      case 'intelligence':
        await cmdIntelligence(socketPath, opts);
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
