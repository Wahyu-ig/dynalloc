'use strict';

/**
 * DynAlloc v2.1 — Performance Benchmark
 *
 * Measures latencies and resource usage of the daemon's pure-logic modules.
 * All I/O is mocked (DRY_RUN); no real system modifications occur.
 *
 * Targets:
 *   CPU idle  < 0.5%   (measured over 5 s of idle)
 *   RAM       < 30 MB
 *   No CPU spike during idle
 *
 * Usage:  node bench.js
 *         node --expose-gc bench.js   (for accurate RSS)
 */

// ═══════════════════════════════════════════════════════════════════════
//  Imports & Setup
// ═══════════════════════════════════════════════════════════════════════

const os = require('os');

// Suppress all logging so it doesn't pollute benchmark output
const loggerMod = require('./logger');
loggerMod.setLevel('fatal');

const { CpuHistory } = require('./sensor');
const classifier = require('./classifier');
const { Scheduler, calculateAdaptiveScore } = require('./scheduler');
const { PluginManager } = require('./plugin-manager');
const Actuator = require('./actuator');
const GovernorManager = require('./governor');
const { DEFAULT_CONFIG } = require('./config');

// Start with a clean classifier cache
classifier.clearCache();

// ═══════════════════════════════════════════════════════════════════════
//  Constants & Mock Data
// ═══════════════════════════════════════════════════════════════════════

const NUM_CORES = os.cpus().length || 8;

const MOCK_TOPOLOGY = {
  logicalCount: NUM_CORES,
  physicalCount: Math.ceil(NUM_CORES / 2),
  smtEnabled: NUM_CORES > 1,
  threadsPerCore: 2,
  numaNodes: [],
  isHybrid: false,
  pCores: [],
  eCores: [],
  isAMD: false,
  ccds: [],
  ccdCount: 0,
  logicalToPhysical: new Map(),
  threadSiblings: new Map(),
};

// Dry-run config — disables all real filesystem / child_process I/O
const CONFIG = { ...DEFAULT_CONFIG, DRY_RUN: true, ENABLE_HYSTERESIS: false };

// ── Realistic process names for classification benchmark ──────────────

const PROCESS_NAMES = [
  'systemd', 'dbus-daemon', 'dbus-broker', 'Xorg', 'Xwayland',
  'gnome-shell', 'mutter', 'gnome-terminal', 'kwin_wayland', 'plasmashell',
  'pipewire', 'pipewire-pulse', 'wireplumber', 'pulseaudio',
  'NetworkManager', 'wpa_supplicant', 'sddm', 'gdm', 'polkitd',
  'firefox', 'firefox-esr', 'chrome', 'chromium', 'brave', 'vivaldi',
  'opera', 'edge', 'msedge', 'com.brave.Browser', 'org.mozilla.firefox',
  'code', 'codium', 'cursor', 'windsurf', 'idea', 'clion', 'goland',
  'rustrover', 'sublime_text', 'vim', 'nvim', 'emacs', 'kate', 'gedit',
  'rustc', 'cargo', 'clang', 'clang++', 'gcc', 'g++', 'cc', 'node',
  'deno', 'bun', 'make', 'cmake', 'ninja', 'java', 'javac', 'gradle',
  'python3', 'pip3', 'go', 'gopls',
  'spotify', 'spotifyd', 'ncspot', 'mpv', 'vlc', 'obs-studio', 'obs64',
  'discord', 'Discord', 'teamspeak3', 'mumble', 'zoom', 'skype',
  'dockerd', 'containerd', 'podman', 'lxc', 'runc', 'buildah',
  'qemu-system-x86_64', 'virt-manager', 'libvirtd', 'VirtualBoxVM',
  'steam', 'steamwebhelper', 'lutris', 'wine', 'wine64', 'proton',
  'mpvpaper', 'xwinwrap', 'swww', 'hyprpaper', 'swaybg', 'feh', 'wpaperd',
  'bash', 'sh', 'zsh', 'fish', 'cat', 'ls', 'grep', 'sed', 'awk',
  'sshd', 'crond', 'journald', 'rsyslogd', 'irqbalance',
  'myapp', 'test-proc', 'worker-1', 'custom-daemon',
  'chrome-crashpad-handler', 'SteamApp', 'bwrap', 'unity-editor', 'godot',
];

// ── Mock ps output generator ─────────────────────────────────────────

function generateMockPsOutput(count) {
  const comms = [
    'systemd', 'bash', 'node', 'firefox', 'chrome', 'code',
    'pipewire', 'dbus-daemon', 'Xorg', 'gnome-shell', 'kwin_wayland',
    'NetworkManager', 'sshd', 'systemd-journald', 'pulseaudio', 'spotify',
    'dockerd', 'containerd', 'rustc', 'cargo', 'clang', 'g++',
    'make', 'cmake', 'java', 'python3', 'vim', 'emacs', 'discord',
    'obs-studio', 'mpv', 'vlc', 'steam', 'wine', 'proton',
    'polkitd', 'colord', 'udisksd', 'upowerd', 'accounts-daemon',
    'gdm', 'sddm', 'lightdm', 'crond', 'rsyslogd', 'avahi-daemon',
    'bluetoothd', 'cupsd', 'cups-browsed', 'irqbalance', 'rngd',
  ];
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const comm = comms[(i - 1) % comms.length];
    const pcpu = (Math.random() * 25).toFixed(1);
    const ppid = Math.max(1, Math.floor(i / 8));
    lines.push(`${i} ${ppid} ${pcpu} ${comm}`);
  }
  return lines.join('\n');
}

// Parse `ps -eo pid,ppid,pcpu,comm --no-headers` output
// (mirrors the parsing logic in sensor.listProcesses)
function parsePsOutput(stdout) {
  return stdout.trim().split('\n').map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const pcpu = parseFloat(parts[2]);
    const comm = parts.slice(3).join(' ');
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, ppid, pcpu, comm };
  }).filter(Boolean);
}

// ── Mock process list for plugin detection ───────────────────────────

function generateMockProcesses(count) {
  const templates = [
    { comm: 'systemd', pcpu: 0.1 },
    { comm: 'firefox', pcpu: 12.5 },
    { comm: 'chrome', pcpu: 15.0 },
    { comm: 'code', pcpu: 8.0 },
    { comm: 'spotify', pcpu: 2.0 },
    { comm: 'discord', pcpu: 3.0 },
    { comm: 'obs-studio', pcpu: 10.0 },
    { comm: 'steam', pcpu: 1.5 },
    { comm: 'mpvpaper', pcpu: 5.0 },
    { comm: 'dockerd', pcpu: 0.5 },
    { comm: 'rustc', pcpu: 25.0 },
    { comm: 'node', pcpu: 5.0 },
    { comm: 'bash', pcpu: 0.0 },
    { comm: 'pipewire', pcpu: 0.3 },
    { comm: 'gnome-shell', pcpu: 3.0 },
    { comm: 'kwin_wayland', pcpu: 2.0 },
    { comm: 'Xwayland', pcpu: 1.0 },
    { comm: 'vlc', pcpu: 8.0 },
    { comm: 'zoom', pcpu: 4.0 },
    { comm: 'vim', pcpu: 0.1 },
  ];
  const procs = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    procs.push({
      pid: 1000 + i,
      ppid: i < 5 ? 1 : 1000 + Math.floor(i / 5),
      pcpu: t.pcpu + (Math.random() * 2 - 1),
      comm: t.comm,
    });
  }
  return procs;
}

// ═══════════════════════════════════════════════════════════════════════
//  Benchmark Infrastructure
// ═══════════════════════════════════════════════════════════════════════

const NS_US = 1_000;
const NS_MS = 1_000_000;

function hrtime() { return process.hrtime.bigint(); }

/**
 * Run `fn()` `iterations` times, collect per-call nanosecond timings.
 * Includes a small warmup phase. Returns sorted percentile stats.
 */
function bench(iterations, fn) {
  const warmup = Math.min(50, Math.floor(iterations * 0.05));
  for (let i = 0; i < warmup; i++) fn();

  const times = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = hrtime();
    fn();
    times[i] = Number(hrtime() - t0);
  }
  times.sort();

  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  const pct = (p) => times[Math.min(Math.floor((p / 100) * times.length), times.length - 1)];

  return { avg, p50: pct(50), p95: pct(95), p99: pct(99), min: times[0], max: times[times.length - 1] };
}

/** Format a nanosecond duration for display. */
function fmtDur(ns) {
  if (ns < NS_US) return (ns).toFixed(0).padStart(5) + ' ns';
  if (ns < NS_MS) return (ns / NS_US).toFixed(2).padStart(8) + ' µs';
  return (ns / NS_MS).toFixed(3).padStart(8) + ' ms';
}

/** Print a formatted latency table to stdout. */
function printLatencyTable(rows) {
  const nameW = 40;
  const iterW = 7;
  const durW = 11;

  const hdr =
    'Benchmark'.padEnd(nameW) +
    'Iter'.padStart(iterW) +
    '  ' + 'Min'.padStart(durW) +
    '  ' + 'Avg'.padStart(durW) +
    '  ' + 'P50'.padStart(durW) +
    '  ' + 'P95'.padStart(durW) +
    '  ' + 'P99'.padStart(durW) +
    '  ' + 'Max'.padStart(durW);

  const sep =
    '\u2500'.repeat(nameW) + ' ' +
    '\u2500'.repeat(iterW) + '  ' +
    '\u2500'.repeat(durW) + '  ' +
    '\u2500'.repeat(durW) + '  ' +
    '\u2500'.repeat(durW) + '  ' +
    '\u2500'.repeat(durW) + '  ' +
    '\u2500'.repeat(durW) + '  ' +
    '\u2500'.repeat(durW);

  console.log();
  console.log('  ' + hdr);
  console.log('  ' + sep);

  for (const r of rows) {
    const line =
      r.name.padEnd(nameW) +
      String(r.iterations).padStart(iterW) +
      '  ' + fmtDur(r.min).padStart(durW) +
      '  ' + fmtDur(r.avg).padStart(durW) +
      '  ' + fmtDur(r.p50).padStart(durW) +
      '  ' + fmtDur(r.p95).padStart(durW) +
      '  ' + fmtDur(r.p99).padStart(durW) +
      '  ' + fmtDur(r.max).padStart(durW);
    console.log('  ' + line);
  }

  console.log('  ' + sep);
}

/** Print the PASS/FAIL summary table. */
function printSummary(items) {
  console.log();
  console.log('  ' + '\u2500'.repeat(66));
  const labelW = 30;
  const targetW = 12;
  const actualW = 24;

  console.log('  ' + 'Target'.padEnd(labelW) + 'Limit'.padStart(targetW) + '  Actual'.padStart(actualW) + '  Status');
  console.log('  ' + '\u2500'.repeat(66));

  let allPass = true;
  for (const item of items) {
    if (!item.pass) allPass = false;
    const status = item.pass ? ' PASS' : ' FAIL';
    const line =
      item.name.padEnd(labelW) +
      item.target.padStart(targetW) + '  ' +
      item.actual.padStart(actualW) + '  ' +
      status;
    console.log('  ' + line);
  }

  console.log('  ' + '\u2500'.repeat(66));
  console.log();
  if (allPass) {
    console.log('  \u2705  All targets met.');
  } else {
    console.log('  \u274C  Some targets NOT met.');
  }
  console.log();

  return allPass;
}

// ═══════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  console.log('\u2502         DynAlloc v2.1 \u2014 Performance Benchmark               \u2502');
  console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  console.log(`  Node.js ${process.version}  |  ${os.type()} ${os.release()}  |  ${os.arch()}  |  ${NUM_CORES} cores`);

  const summaryItems = [];
  const latencyRows = [];

  // ──────────────────────────────────────────────────────────────────
  //  1. CPU idle usage (5 seconds, with spike detection)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n  [ 1/10] CPU idle usage (5 s measurement) ...');

  const SAMPLE_MS = 200;
  const IDLE_MS = 5000;
  const sampleCount = Math.floor(IDLE_MS / SAMPLE_MS);
  const cpuSamples = [];

  let prevCpu = process.cpuUsage();
  for (let i = 0; i < sampleCount; i++) {
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const curCpu = process.cpuUsage();
    const deltaUs = (curCpu.user - prevCpu.user) + (curCpu.system - prevCpu.system);
    const intervalSec = SAMPLE_MS / 1000;
    // CPU% = cpu_time_seconds / wall_seconds * 100
    const pct = (deltaUs / 1_000_000) / intervalSec * 100;
    cpuSamples.push(pct);
    prevCpu = curCpu;
  }

  const cpuAvg = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;
  const cpuMax = Math.max(...cpuSamples);

  summaryItems.push({
    name: 'CPU idle < 0.5%',
    target: '< 0.5%',
    actual: cpuAvg.toFixed(3) + '%',
    pass: cpuAvg < 0.5,
  });
  summaryItems.push({
    name: 'No CPU spike during idle',
    target: 'max < 2%',
    actual: 'max ' + cpuMax.toFixed(3) + '%',
    pass: cpuMax < 2.0,
  });

  console.log('          avg = ' + cpuAvg.toFixed(3) + '%   max = ' + cpuMax.toFixed(3) + '%');

  // ──────────────────────────────────────────────────────────────────
  //  2. RAM usage
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 2/10] RAM usage ...');

  if (global.gc) global.gc();
  const mem = process.memoryUsage();
  const rssMB = mem.rss / (1024 * 1024);
  const heapMB = mem.heapUsed / (1024 * 1024);

  summaryItems.push({
    name: 'RAM < 30 MB',
    target: '< 30 MB',
    actual: rssMB.toFixed(1) + ' MB  (heap ' + heapMB.toFixed(1) + ' MB)',
    pass: rssMB < 30,
  });

  console.log('          RSS = ' + rssMB.toFixed(1) + ' MB   Heap = ' + heapMB.toFixed(1) + ' MB');

  // ──────────────────────────────────────────────────────────────────
  //  3. Scheduler tick latency
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 3/10] Scheduler tick latency ...');

  const cpuHistory = new CpuHistory(CONFIG.CPU_HISTORY_SIZE);
  const scheduler = new Scheduler(CONFIG, MOCK_TOPOLOGY, cpuHistory);

  // Warm up the history so tick() operates on a full buffer
  for (let i = 0; i < CONFIG.CPU_HISTORY_SIZE; i++) {
    cpuHistory.push({ cpuAvg10: 2.0, memAvg10: 1.0 });
  }

  const TICK_N = 1000;
  let tickI = 0;
  const tickStats = bench(TICK_N, () => {
    // Cycle through normal / warn / critical PSI data
    const phase = tickI % 3;
    const cpuPSI = phase === 0 ? { some: { avg10: 2.0 } }
                : phase === 1 ? { some: { avg10: 10.0 } }
                :             { some: { avg10: 25.0 } };
    const memPSI = phase === 0 ? { some: { avg10: 1.0 } }
                : phase === 1 ? { some: { avg10: 5.0 } }
                :             { some: { avg10: 15.0 } };
    scheduler.tick({ cpuPSI, memPSI }, {
      foregroundPid: 1234,
      mediaPids: new Set([5678]),
      onBattery: false,
      thermalTemp: 55,
    });
    tickI++;
  });
  latencyRows.push({ name: 'scheduler.tick()', iterations: TICK_N, ...tickStats });
  console.log('          avg = ' + fmtDur(tickStats.avg));

  // ──────────────────────────────────────────────────────────────────
  //  4. Scanning (parse) latency — simulated ps output
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 4/10] Process list parsing latency ...');

  const MOCK_PS = generateMockPsOutput(300);
  const SCAN_N = 100;
  const scanStats = bench(SCAN_N, () => parsePsOutput(MOCK_PS));
  latencyRows.push({ name: 'parsePsOutput (300 procs)', iterations: SCAN_N, ...scanStats });
  console.log('          avg = ' + fmtDur(scanStats.avg) + '  (' + MOCK_PS.split('\n').length + ' lines)');

  // ──────────────────────────────────────────────────────────────────
  //  5. Process classification time
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 5/10] Process classification (classifyByComm) ...');

  classifier.clearCache();
  let clsI = 0;
  const CLS_N = 1000;
  const clsStats = bench(CLS_N, () => {
    classifier.classifyByComm(PROCESS_NAMES[clsI % PROCESS_NAMES.length]);
    clsI++;
  });
  latencyRows.push({ name: 'classifyByComm', iterations: CLS_N, ...clsStats });
  console.log('          avg = ' + fmtDur(clsStats.avg) + '  (' + PROCESS_NAMES.length + ' unique names)');

  // ──────────────────────────────────────────────────────────────────
  //  6. Cgroup switching latency (dry-run, mocked fs write)
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 6/10] Cgroup switching latency (dry-run) ...');

  const actuator = new Actuator(CONFIG);
  let cgI = 0;
  const CG_N = 1000;
  const cgStats = bench(CG_N, () => {
    actuator.assignToCgroup(
      1000 + (cgI % 500),
      '/sys/fs/cgroup/dynalloc.slice/background.slice'
    );
    cgI++;
  });
  latencyRows.push({ name: 'assignToCgroup (dry-run)', iterations: CG_N, ...cgStats });
  console.log('          avg = ' + fmtDur(cgStats.avg));

  // ──────────────────────────────────────────────────────────────────
  //  7. Governor switching latency (dry-run, mocked execFileSync)
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 7/10] Governor switching latency (dry-run) ...');

  const govMgr = new GovernorManager();
  const cores = Array.from({ length: NUM_CORES }, (_, i) => i);
  const GOV_N = 100;
  const govList = ['performance', 'powersave', 'ondemand', 'schedutil'];
  let govI = 0;
  const govStats = bench(GOV_N, () => {
    govMgr.setGovernor(cores, govList[govI % govList.length], CONFIG);
    govI++;
  });
  latencyRows.push({ name: 'setGovernor (dry-run)', iterations: GOV_N, ...govStats });
  console.log('          avg = ' + fmtDur(govStats.avg) + '  (' + NUM_CORES + ' cores)');

  // ──────────────────────────────────────────────────────────────────
  //  8. CpuHistory push + average
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 8/10] CpuHistory push + average ...');

  const hist = new CpuHistory(CONFIG.CPU_HISTORY_SIZE);
  let hI = 0;
  const HIST_N = 10000;
  const histStats = bench(HIST_N, () => {
    hist.push({ cpuAvg10: 1.0 + (hI % 20), memAvg10: 0.5 + (hI % 10) });
    // Read averages to ensure they are computed
    const _c = hist.cpuAvg;   // eslint-disable-line no-unused-vars
    const _m = hist.memAvg;   // eslint-disable-line no-unused-vars
    hI++;
  });
  latencyRows.push({ name: 'CpuHistory.push+avg', iterations: HIST_N, ...histStats });
  console.log('          avg = ' + fmtDur(histStats.avg));

  // ──────────────────────────────────────────────────────────────────
  //  9. Adaptive score calculation
  // ──────────────────────────────────────────────────────────────────
  console.log('  [ 9/10] Adaptive score calculation ...');

  const factorSets = [
    { cpuPressure: 5,   memPressure: 2,  hasForeground: true,  mediaPlaying: false, onBattery: false, thermalTemp: 50  },
    { cpuPressure: 15,  memPressure: 8,  hasForeground: false, mediaPlaying: true,  onBattery: true,  thermalTemp: 70  },
    { cpuPressure: 25,  memPressure: 12, hasForeground: true,  mediaPlaying: false, onBattery: false, thermalTemp: 85  },
    { cpuPressure: 0,   memPressure: 0,  hasForeground: false, mediaPlaying: false, onBattery: false, thermalTemp: null },
  ];
  let sI = 0;
  const SCORE_N = 10000;
  const scoreStats = bench(SCORE_N, () => {
    calculateAdaptiveScore(factorSets[sI % factorSets.length], CONFIG);
    sI++;
  });
  latencyRows.push({ name: 'calculateAdaptiveScore', iterations: SCORE_N, ...scoreStats });
  console.log('          avg = ' + fmtDur(scoreStats.avg));

  // ──────────────────────────────────────────────────────────────────
  //  10. Plugin detection (mock processes)
  // ──────────────────────────────────────────────────────────────────
  console.log('  [10/10] Plugin detection ...');

  const pluginMgr = new PluginManager();

  // Register mock plugins that mirror the real ones (avoids filesystem deps)
  pluginMgr.register({
    name: 'browser',
    version: '1.0.0',
    description: 'Browser detector',
    detect(procs, ctx) {
      const results = [];
      const RE = /^(chrome|chromium|firefox|brave|vivaldi|opera|edge|msedge)$/i;
      for (const p of procs) {
        if (RE.test(p.comm) && ctx.mediaPids && ctx.mediaPids.has(p.pid)) {
          results.push({ pid: p.pid, action: 'PROTECT', reason: 'Browser "' + p.comm + '" media' });
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'game',
    version: '1.0.0',
    description: 'Game detector',
    detect(procs) {
      const results = [];
      const patterns = [/^SteamApp/i, /^UnityPlayer/i, /^godot/i, /^wine(64)?$/i, /^proton/i];
      for (const p of procs) {
        for (const re of patterns) {
          if (re.test(p.comm)) {
            results.push({ pid: p.pid, action: 'BOOST', reason: 'Game "' + p.comm + '"' });
            break;
          }
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'spotify',
    version: '1.0.0',
    description: 'Spotify detector',
    detect(procs, ctx) {
      const results = [];
      for (const p of procs) {
        if (/^spotify(d)?$/i.test(p.comm) && ctx.mediaPids && ctx.mediaPids.has(p.pid)) {
          results.push({ pid: p.pid, action: 'PROTECT', reason: 'Spotify playback' });
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'obs',
    version: '1.0.0',
    description: 'OBS detector',
    detect(procs, ctx) {
      const results = [];
      for (const p of procs) {
        if (/^obs(-studio|64)?$/i.test(p.comm) && ctx.mediaPids && ctx.mediaPids.has(p.pid)) {
          results.push({ pid: p.pid, action: 'PROTECT', reason: 'OBS recording' });
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'discord',
    version: '1.0.0',
    description: 'Discord detector',
    detect(procs, ctx) {
      const results = [];
      for (const p of procs) {
        if (/^discord$/i.test(p.comm) && ctx.mediaPids && ctx.mediaPids.has(p.pid)) {
          results.push({ pid: p.pid, action: 'PROTECT', reason: 'Discord voice' });
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'steam',
    version: '1.0.0',
    description: 'Steam detector',
    detect(procs) {
      const results = [];
      for (const p of procs) {
        if (/^steam$/i.test(p.comm)) {
          results.push({ pid: p.pid, action: 'MONITOR', reason: 'Steam client' });
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'wallpaper',
    version: '1.0.0',
    description: 'Wallpaper detector',
    detect(procs) {
      const results = [];
      const patterns = [
        /^mpvpaper$/i, /^xwinwrap$/i, /^swww$/i, /^hyprpaper$/i,
        /^swaybg$/i, /^wpaperd$/i, /^glpaper$/i,
      ];
      for (const p of procs) {
        for (const re of patterns) {
          if (re.test(p.comm)) {
            results.push({ pid: p.pid, action: 'PROTECT', reason: 'Wallpaper "' + p.comm + '"' });
            break;
          }
        }
      }
      return results;
    },
  });

  pluginMgr.register({
    name: 'system',
    version: '1.0.0',
    description: 'System health',
    detect() { return []; },
  });

  const mockProcs = generateMockProcesses(50);
  const mediaPids = new Set([1004, 1006, 1007, 1008, 1009, 1012, 1017, 1018]);
  const pluginCtx = { mediaPids, foregroundPid: 1002, gameModeActive: false };

  const PLUG_N = 1000;
  const plugStats = bench(PLUG_N, () => {
    pluginMgr.runDetection(mockProcs, pluginCtx);
  });
  latencyRows.push({
    name: 'plugin.runDetection (' + pluginMgr.size + ' plugins)',
    iterations: PLUG_N,
    ...plugStats,
  });
  console.log('          avg = ' + fmtDur(plugStats.avg) + '  (' + pluginMgr.size + ' plugins, ' + mockProcs.length + ' procs)');

  // ══════════════════════════════════════════════════════════════════
  //  Output
  // ══════════════════════════════════════════════════════════════════

  console.log();
  console.log('  ── Latency Results ──────────────────────────────────────────────────────────────────────────────────────────────────────');
  printLatencyTable(latencyRows);

  const allPass = printSummary(summaryItems);

  process.exit(allPass ? 0 : 1);
}

// ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(2);
});