'use strict';

/**
 * DynAlloc — Watch Renderer (v1.1.0)
 * ====================================
 *
 * Self-contained renderer for the `dynalloc watch` command. Renders an
 * ANSI-color, flicker-free dashboard to a TTY. Designed for unit testing:
 * every rendering function returns a string, no I/O is performed inside
 * the renderer itself.
 *
 * Layout (top to bottom):
 *
 *   ┌─ DynAlloc Watch ─────────────────────────────── updated ───────┐
 *   │ Daemon:  v1.1.0   pid 12345   uptime 1h 23m 45s                 │
 *   │ CPU:     12.4%   load 0.85   pressure 5.2%                      │
 *   │ Memory:  4.2 / 16.0 GB   pressure 1.1%                          │
 *   │                                                                  │
 *   │ Scheduler State:   WARN                                          │
 *   │ Active Policy:     gaming (profile, priority 90)                 │
 *   │ Current Profile:   gaming                                        │
 *   │ Governor:          performance                                    │
 *   │ Foreground:        PID 1234  firefox                              │
 *   │                                                                  │
 *   │ Boosted (2):   1234 firefox, 5678 chrome                         │
 *   │ Throttled (1): 9012 rustc                                        │
 *   │ Plugins (3):   system, browser, game                             │
 *   │                                                                  │
 *   │ Recent Events:                                                   │
 *   │   12:34:56  boost    firefox  (pid 1234)                         │
 *   │   12:34:32  throttle rustc    (pid 9012)                         │
 *   │   12:33:11  profile  gaming                                       │
 *   │                                                                  │
 *   │ Press Ctrl+C to exit                                             │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The CLI is responsible for:
 *   - polling daemon state (via IPC `status` + `metrics` commands)
 *   - polling /proc for CPU/memory stats
 *   - maintaining the recent-events ring buffer (subscribed to the bus)
 *   - scheduling the 1-second refresh timer
 *   - capturing Ctrl+C and exiting cleanly
 *
 * The renderer is responsible for:
 *   - turning a snapshot into a single ANSI string
 *   - using cursor repositioning (no full-screen clear) to avoid flicker
 *
 * Anti-flicker technique:
 *   On the first frame, emit `\x1b[2J\x1b[H` (clear screen + home).
 *   On subsequent frames, emit `\x1b[H` (home only) and overwrite in
 *   place. Lines that are shorter than the previous frame are padded
 *   with spaces to clear leftover characters. This avoids the visual
 *   flash of a full clear/redraw cycle.
 */

// ── ANSI escape sequences ─────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Colors (foreground)
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  // Cursor
  clearScreen: '\x1b[2J',
  cursorHome: '\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
};

// ── Color helpers ─────────────────────────────────────────────────────

function colorize(str, color) {
  if (!color) return str;
  return `${color}${str}${ANSI.reset}`;
}

function stressColor(level) {
  switch (level) {
    case 'NORMAL': return ANSI.green;
    case 'WARN': return ANSI.yellow;
    case 'CRITICAL': return ANSI.red;
    default: return ANSI.gray;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function padRight(str, width) {
  str = String(str);
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

function truncate(str, maxLen) {
  str = String(str);
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || seconds < 0 || !Number.isFinite(seconds)) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPercent(pct, opts = {}) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'N/A';
  const decimals = opts.decimals !== undefined ? opts.decimals : 1;
  return `${pct.toFixed(decimals)}%`;
}

function formatTime(ts) {
  if (!ts) return '--:--:--';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString();
}

// ── Snapshot shape ────────────────────────────────────────────────────
//
// The renderer accepts a single `snapshot` object:
//
//   {
//     daemon: { version, pid, uptime },
//     cpu: { usagePercent, load1m, pressurePercent, coreCount },
//     memory: { usedBytes, totalBytes, pressurePercent },
//     scheduler: { stressLevel, adaptiveScore, fastTickMs },
//     policy: { name, priority } | null,
//     profile: { name } | null,
//     governor: { name } | null,
//     foreground: { pid, comm } | null,
//     boosted: [{ pid, comm }, ...],
//     throttled: [{ pid, comm, since }, ...],
//     plugins: ['system', 'browser', ...],
//     events: [{ ts, type, comm, pid }, ...],
//     thermal: { enabled, paused, lastTemp, threshold } | null,
//   }
//
// Any field may be null/undefined — the renderer degrades gracefully.

/**
 * Render a single line, padded to the terminal width to clear leftover
 * characters from the previous frame.
 */
function renderLine(content, width) {
  if (width && content.length < width) {
    return content + ' '.repeat(width - content.length);
  }
  return content;
}

/**
 * Render the header row.
 */
function renderHeader(snapshot, width) {
  const title = colorize(' DynAlloc Watch ', ANSI.brightCyan + ANSI.bold);
  const updated = colorize(` ${new Date().toLocaleTimeString()} `, ANSI.dim);
  const titleLen = ' DynAlloc Watch '.length + ' ... '.length + updated.length;
  // Render: title + filler + updated
  let fillerLen = (width || 60) - titleLen;
  if (fillerLen < 0) fillerLen = 0;
  const filler = '─'.repeat(fillerLen);
  return `${title}${colorize(filler, ANSI.dim)}${updated}`;
}

/**
 * Render the daemon info row.
 */
function renderDaemonRow(snapshot) {
  const d = snapshot.daemon || {};
  const parts = [];
  parts.push(colorize('Daemon:', ANSI.bold));
  if (d.version) parts.push(`v${d.version}`);
  if (d.pid) parts.push(`pid ${d.pid}`);
  if (typeof d.uptime === 'number') parts.push(`uptime ${formatDuration(d.uptime)}`);
  if (parts.length === 1) parts.push(colorize('(unavailable)', ANSI.dim));
  return '  ' + parts.join('   ');
}

/**
 * Render the CPU row.
 */
function renderCpuRow(snapshot) {
  const c = snapshot.cpu || {};
  const parts = [];
  parts.push(colorize('CPU:', ANSI.bold));
  if (typeof c.usagePercent === 'number') {
    const cpuStr = formatPercent(c.usagePercent);
    const cpuColor = c.usagePercent > 80 ? ANSI.red
      : c.usagePercent > 50 ? ANSI.yellow : ANSI.green;
    parts.push(colorize(cpuStr, cpuColor));
  }
  if (typeof c.load1m === 'number') {
    parts.push(`load ${c.load1m.toFixed(2)}`);
  }
  if (typeof c.coreCount === 'number') {
    parts.push(`${c.coreCount} cores`);
  }
  if (typeof c.pressurePercent === 'number') {
    const pStr = `pressure ${formatPercent(c.pressurePercent)}`;
    const pColor = c.pressurePercent > 30 ? ANSI.red
      : c.pressurePercent > 10 ? ANSI.yellow : ANSI.gray;
    parts.push(colorize(pStr, pColor));
  }
  if (parts.length === 1) parts.push(colorize('(unavailable)', ANSI.dim));
  return '  ' + parts.join('   ');
}

/**
 * Render the memory row.
 */
function renderMemoryRow(snapshot) {
  const m = snapshot.memory || {};
  const parts = [];
  parts.push(colorize('Memory:', ANSI.bold));
  if (typeof m.usedBytes === 'number' && typeof m.totalBytes === 'number') {
    const usagePercent = m.totalBytes > 0 ? (m.usedBytes / m.totalBytes) * 100 : 0;
    const memStr = `${formatBytes(m.usedBytes)} / ${formatBytes(m.totalBytes)}`;
    const memColor = usagePercent > 90 ? ANSI.red
      : usagePercent > 75 ? ANSI.yellow : ANSI.green;
    parts.push(colorize(memStr, memColor));
    parts.push(colorize(`(${formatPercent(usagePercent)})`, memColor));
  }
  if (typeof m.pressurePercent === 'number') {
    const pStr = `pressure ${formatPercent(m.pressurePercent)}`;
    const pColor = m.pressurePercent > 30 ? ANSI.red
      : m.pressurePercent > 10 ? ANSI.yellow : ANSI.gray;
    parts.push(colorize(pStr, pColor));
  }
  if (parts.length === 1) parts.push(colorize('(unavailable)', ANSI.dim));
  return '  ' + parts.join('   ');
}

/**
 * Render the scheduler state row.
 */
function renderSchedulerRow(snapshot) {
  const s = snapshot.scheduler || {};
  const parts = [];
  parts.push(colorize('Scheduler State:', ANSI.bold));
  if (s.stressLevel) {
    parts.push(colorize(s.stressLevel, stressColor(s.stressLevel)));
  } else {
    parts.push(colorize('N/A', ANSI.dim));
  }
  if (typeof s.adaptiveScore === 'number') {
    parts.push(`score ${s.adaptiveScore.toFixed(2)}`);
  }
  if (typeof s.fastTickMs === 'number') {
    parts.push(`tick ${s.fastTickMs}ms`);
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the active policy row.
 */
function renderPolicyRow(snapshot) {
  const parts = [];
  parts.push(colorize('Active Policy:', ANSI.bold));
  const p = snapshot.policy;
  if (p && p.name) {
    parts.push(colorize(p.name, ANSI.brightMagenta));
    if (typeof p.priority === 'number') parts.push(`(priority ${p.priority})`);
  } else {
    parts.push(colorize('(none)', ANSI.dim));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the current profile row.
 */
function renderProfileRow(snapshot) {
  const parts = [];
  parts.push(colorize('Current Profile:', ANSI.bold));
  const p = snapshot.profile;
  if (p && p.name) {
    parts.push(colorize(p.name, ANSI.brightBlue));
  } else {
    parts.push(colorize('(none)', ANSI.dim));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the governor row.
 */
function renderGovernorRow(snapshot) {
  const parts = [];
  parts.push(colorize('Governor:', ANSI.bold));
  const g = snapshot.governor;
  if (g && g.name) {
    const govColor = g.name === 'performance' ? ANSI.brightGreen
      : g.name === 'powersave' ? ANSI.brightBlue
      : g.name === 'schedutil' ? ANSI.brightYellow
      : ANSI.white;
    parts.push(colorize(g.name, govColor));
  } else {
    parts.push(colorize('N/A', ANSI.dim));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the foreground process row.
 */
function renderForegroundRow(snapshot) {
  const parts = [];
  parts.push(colorize('Foreground:', ANSI.bold));
  const fg = snapshot.foreground;
  if (fg && fg.pid) {
    parts.push(`PID ${fg.pid}`);
    if (fg.comm) parts.push(colorize(fg.comm, ANSI.brightGreen));
  } else {
    parts.push(colorize('(none)', ANSI.dim));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the boosted processes row.
 */
function renderBoostedRow(snapshot) {
  const parts = [];
  const list = snapshot.boosted || [];
  parts.push(colorize(`Boosted (${list.length}):`, ANSI.bold));
  if (list.length === 0) {
    parts.push(colorize('(none)', ANSI.dim));
  } else {
    const items = list.slice(0, 8).map((p) =>
      `${p.pid} ${colorize(p.comm || '?', ANSI.green)}`
    );
    parts.push(items.join(', '));
    if (list.length > 8) {
      parts.push(colorize(`+${list.length - 8} more`, ANSI.dim));
    }
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the throttled processes row.
 */
function renderThrottledRow(snapshot) {
  const parts = [];
  const list = snapshot.throttled || [];
  parts.push(colorize(`Throttled (${list.length}):`, ANSI.bold));
  if (list.length === 0) {
    parts.push(colorize('(none)', ANSI.dim));
  } else {
    const items = list.slice(0, 8).map((p) =>
      `${p.pid} ${colorize(p.comm || '?', ANSI.red)}`
    );
    parts.push(items.join(', '));
    if (list.length > 8) {
      parts.push(colorize(`+${list.length - 8} more`, ANSI.dim));
    }
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the loaded plugins row.
 */
function renderPluginsRow(snapshot) {
  const parts = [];
  const list = snapshot.plugins || [];
  parts.push(colorize(`Plugins (${list.length}):`, ANSI.bold));
  if (list.length === 0) {
    parts.push(colorize('(none)', ANSI.dim));
  } else {
    parts.push(list.join(', '));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the thermal row.
 */
function renderThermalRow(snapshot) {
  const t = snapshot.thermal;
  if (!t || !t.enabled) return null;
  const parts = [];
  parts.push(colorize('Thermal:', ANSI.bold));
  if (typeof t.lastTemp === 'number') {
    const tempColor = t.paused ? ANSI.red
      : t.lastTemp >= (t.threshold || 80) ? ANSI.yellow : ANSI.gray;
    parts.push(colorize(`${t.lastTemp.toFixed(1)}°C`, tempColor));
  }
  if (t.paused) {
    parts.push(colorize('PAUSED', ANSI.red + ANSI.bold));
  }
  if (typeof t.threshold === 'number') {
    parts.push(colorize(`(pause at ${t.threshold}°C)`, ANSI.dim));
  }
  return '  ' + parts.join('   ');
}

/**
 * Render the recent events section.
 */
function renderEventsSection(snapshot, maxLines = 5) {
  const events = snapshot.events || [];
  const lines = [];
  lines.push('  ' + colorize('Recent Events:', ANSI.bold));
  if (events.length === 0) {
    lines.push('  ' + colorize('  (no events)', ANSI.dim));
    return lines.join('\n');
  }
  const recent = events.slice(-maxLines).reverse();
  for (const e of recent) {
    const ts = formatTime(e.ts);
    const typeStr = pad(e.type || 'event', 10);
    const typeColor = e.type === 'boost' ? ANSI.green
      : e.type === 'throttle' ? ANSI.red
      : e.type === 'profile' ? ANSI.brightBlue
      : e.type === 'restore' ? ANSI.cyan
      : ANSI.gray;
    const comm = e.comm ? colorize(e.comm, ANSI.white) : '';
    const pid = e.pid ? colorize(`(pid ${e.pid})`, ANSI.dim) : '';
    lines.push(`  ${colorize(ts, ANSI.dim)}  ${colorize(typeStr, typeColor)} ${comm} ${pid}`);
  }
  return lines.join('\n');
}

/**
 * Render the footer (Ctrl+C hint).
 */
function renderFooter() {
  return colorize('  Press Ctrl+C to exit', ANSI.dim);
}

/**
 * Render a complete frame as a single string.
 *
 * @param {object} snapshot - see snapshot shape above
 * @param {object} opts
 * @param {number} [opts.width=80] - terminal width (for padding)
 * @param {boolean} [opts.firstFrame=false] - if true, emit a full-screen clear
 * @returns {string} ANSI-formatted frame, with trailing newline
 */
function renderFrame(snapshot, opts = {}) {
  const width = opts.width || 80;
  const lines = [];

  // First frame: clear screen + hide cursor. Subsequent frames: just
  // move cursor home. This avoids the flicker of repeated full clears.
  if (opts.firstFrame) {
    lines.push(ANSI.hideCursor + ANSI.clearScreen + ANSI.cursorHome);
  } else {
    lines.push(ANSI.cursorHome);
  }

  // Header
  lines.push(renderHeader(snapshot, width));
  lines.push(colorize('─'.repeat(width), ANSI.dim));

  // System rows
  lines.push(renderDaemonRow(snapshot));
  lines.push(renderCpuRow(snapshot));
  lines.push(renderMemoryRow(snapshot));

  // Thermal row (only if enabled)
  const thermalLine = renderThermalRow(snapshot);
  if (thermalLine) lines.push(thermalLine);

  // Separator
  lines.push(colorize('─'.repeat(width), ANSI.dim));

  // State rows
  lines.push(renderSchedulerRow(snapshot));
  lines.push(renderPolicyRow(snapshot));
  lines.push(renderProfileRow(snapshot));
  lines.push(renderGovernorRow(snapshot));
  lines.push(renderForegroundRow(snapshot));

  // Separator
  lines.push(colorize('─'.repeat(width), ANSI.dim));

  // Action rows
  lines.push(renderBoostedRow(snapshot));
  lines.push(renderThrottledRow(snapshot));
  lines.push(renderPluginsRow(snapshot));

  // Separator
  lines.push(colorize('─'.repeat(width), ANSI.dim));

  // Events
  lines.push(renderEventsSection(snapshot));

  // Footer
  lines.push('');
  lines.push(renderFooter());

  // Pad each line to terminal width to clear leftover characters from
  // the previous frame. This is the key anti-flicker technique — we
  // overwrite in place rather than clearing the screen.
  const padded = lines.map((l) => {
    // Strip ANSI codes for length calculation
    const visibleLen = l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
    if (visibleLen < width) {
      return l + ' '.repeat(width - visibleLen);
    }
    return l;
  });

  return padded.join('\n') + '\n';
}

/**
 * Render the exit sequence — show cursor again.
 */
function renderExit() {
  return ANSI.showCursor;
}

module.exports = {
  ANSI,
  // Formatting helpers (exported for testing)
  colorize,
  stressColor,
  pad,
  padRight,
  truncate,
  formatDuration,
  formatBytes,
  formatPercent,
  formatTime,
  // Render functions (exported for testing)
  renderHeader,
  renderDaemonRow,
  renderCpuRow,
  renderMemoryRow,
  renderSchedulerRow,
  renderPolicyRow,
  renderProfileRow,
  renderGovernorRow,
  renderForegroundRow,
  renderBoostedRow,
  renderThrottledRow,
  renderPluginsRow,
  renderThermalRow,
  renderEventsSection,
  renderFooter,
  renderFrame,
  renderExit,
};
