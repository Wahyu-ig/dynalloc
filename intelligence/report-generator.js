'use strict';

/**
 * DynAlloc — HTML Report Generator
 *
 * Generates a standalone HTML diagnostic report containing:
 *   - System Information
 *   - CPU History
 *   - Memory History
 *   - Scheduler Timeline
 *   - Policy Timeline
 *   - Plugin Activity
 *   - Event Timeline
 *   - Governor Changes
 *   - Recommendations
 *   - Health Check (Doctor)
 *   - Current Configuration
 *   - Performance Summary
 *   - Explanations
 *
 * Pure HTML/CSS/JS — no external dependencies.
 * Readable offline (no CDN, no fonts loaded externally).
 *
 * v2.0: Initial release.
 */

const os = require('os');

// ── Report Generator ──────────────────────────────────────────────────

class ReportGenerator {
  /**
   * Generate a standalone HTML report.
   *
   * @param {object} data — All report data collected from the daemon.
   * @param {object} data.system    — System information (hostname, kernel, arch, etc.)
   * @param {object} data.status    — Current daemon status (stressLevel, foregroundPid, etc.)
   * @param {object} [data.metrics] — Metrics snapshot
   * @param {object} [data.config]  — Current configuration (sanitized)
   * @param {object} [data.selfCheck] — Self-check report
   * @param {object} [data.doctor]  — Doctor report (if available)
   * @param {object} [data.policyEngine] — Policy engine status
   * @param {object} [data.plugins] — Plugin status
   * @param {object} [data.explanations] — Recent explanations
   * @param {object} [data.timeline] — Timeline entries
   * @param {object} [data.recommendations] — Pending recommendations
   * @param {object} [data.intelligence] — Intelligence subsystem status
   * @param {object} [data.monitoring] — Monitoring status
   * @param {object} [data.adaptive] — Adaptive engine status
   * @param {object} [data.recognition] — Recognition engine status
   * @param {string} [data.version] — Daemon version
   * @returns {string} Complete HTML string.
   */
  generate(data) {
    const now = new Date().toISOString();
    const title = `DynAlloc Diagnostic Report — ${now.split('T')[0]}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._esc(title)}</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #c9d1d9; --text-dim: #8b949e; --text-bright: #f0f6fc;
  --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
  --purple: #bc8cff; --cyan: #39d2c0; --orange: #f0883e;
  --radius: 8px; --font-mono: 'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace;
  --font-sans: -apple-system, 'Segoe UI', 'Noto Sans', 'Liberation Sans', sans-serif;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: 14px; line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.6rem; color: var(--text-bright); margin-bottom: 0.25rem; }
h2 { font-size: 1.2rem; color: var(--text-bright); border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; margin: 2rem 0 0.8rem; }
h3 { font-size: 1rem; color: var(--blue); margin: 1rem 0 0.4rem; }
.subtitle { color: var(--text-dim); margin-bottom: 1.5rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem; margin-bottom: 1rem; }
.card-header { font-weight: 600; color: var(--text-bright); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.stat-label { color: var(--text-dim); font-size: 0.85rem; }
.stat-value { font-size: 1.4rem; font-weight: 700; font-family: var(--font-mono); }
.stat-value.green { color: var(--green); }
.stat-value.red { color: var(--red); }
.stat-value.yellow { color: var(--yellow); }
.stat-value.blue { color: var(--blue); }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
.badge-pass { background: #1a3a1a; color: var(--green); border: 1px solid #2ea043; }
.badge-warn { background: #3a2a0a; color: var(--yellow); border: 1px solid #9e6a03; }
.badge-error { background: #3a1a1a; color: var(--red); border: 1px solid #da3633; }
.badge-info { background: #1a2a3a; color: var(--blue); border: 1px solid #388bfd; }
.badge-high { background: #3a1a1a; color: var(--red); border: 1px solid #da3633; }
.badge-medium { background: #3a2a0a; color: var(--yellow); border: 1px solid #9e6a03; }
.badge-low { background: #1a3a1a; color: var(--green); border: 1px solid #2ea043; }
table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
th { text-align: left; color: var(--text-dim); font-weight: 600; border-bottom: 1px solid var(--border); padding: 0.4rem 0.6rem; font-size: 0.85rem; }
td { padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: rgba(255,255,255,0.02); }
.mono { font-family: var(--font-mono); font-size: 0.85rem; }
.timeline { max-height: 500px; overflow-y: auto; }
.timeline-entry { padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; gap: 0.8rem; align-items: flex-start; }
.timeline-time { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.8rem; min-width: 70px; }
.timeline-cat { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 4px; min-width: 60px; text-align: center; }
.timeline-summary { flex: 1; }
.cat-daemon { background: #1a2a3a; color: var(--blue); }
.cat-scheduler { background: #1a3a2a; color: var(--cyan); }
.cat-governor { background: #2a2a1a; color: var(--yellow); }
.cat-policy { background: #2a1a2a; color: var(--purple); }
.cat-plugin { background: #1a3a3a; color: var(--cyan); }
.cat-system { background: #3a2a1a; color: var(--orange); }
.cat-learning { background: #1a3a1a; color: var(--green); }
.cat-focus { background: #2a1a3a; color: var(--purple); }
.cat-adaptive { background: #1a2a2a; color: var(--cyan); }
.cat-profile { background: #2a2a2a; color: var(--text); }
.factor-pass { color: var(--green); }
.factor-fail { color: var(--red); }
.score-ring { width: 120px; height: 120px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2rem; font-weight: 700; font-family: var(--font-mono); }
.score-excellent { background: radial-gradient(circle, #1a3a1a 60%, #0d1117 60%); color: var(--green); border: 4px solid var(--green); }
.score-good { background: radial-gradient(circle, #1a3a2a 60%, #0d1117 60%); color: var(--cyan); border: 4px solid var(--cyan); }
.score-fair { background: radial-gradient(circle, #3a2a0a 60%, #0d1117 60%); color: var(--yellow); border: 4px solid var(--yellow); }
.score-poor { background: radial-gradient(circle, #3a1a1a 60%, #0d1117 60%); color: var(--red); border: 4px solid var(--red); }
.config-key { color: var(--blue); }
.config-val { color: var(--text); }
.rec-card { border-left: 3px solid var(--yellow); padding-left: 0.8rem; margin-bottom: 0.8rem; }
.explanation-card { border-left: 3px solid var(--purple); padding-left: 0.8rem; margin-bottom: 0.8rem; }
.filter-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.3rem 0.7rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
.filter-btn:hover { background: var(--border); }
.filter-btn.active { background: var(--blue); color: var(--bg); border-color: var(--blue); }
.empty { color: var(--text-dim); font-style: italic; padding: 1rem; text-align: center; }
@media (max-width: 768px) { body { padding: 1rem; } .grid { grid-template-columns: 1fr; } .grid-3 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>DynAlloc Diagnostic Report</h1>
<p class="subtitle">Generated: ${this._esc(now)} | Version: ${this._esc(data.version || '2.0.0')}</p>

<!-- Health Score -->
${this._renderHealthScore(data)}

<!-- System Information -->
${this._renderSystemInfo(data)}

<!-- Performance Summary -->
${this._renderPerformanceSummary(data)}

<!-- Recommendations -->
${this._renderRecommendations(data)}

<!-- Explanations -->
${this._renderExplanations(data)}

<!-- Health Check -->
${this._renderHealthCheck(data)}

<!-- Timeline -->
${this._renderTimeline(data)}

<!-- Configuration -->
${this._renderConfiguration(data)}

<script>
// Timeline filter functionality
document.addEventListener('DOMContentLoaded', function() {
  const buttons = document.querySelectorAll('[data-filter]');
  const entries = document.querySelectorAll('[data-category]');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const cat = this.getAttribute('data-filter');
      buttons.forEach(function(b) { b.classList.remove('active'); });
      this.classList.add('active');
      entries.forEach(function(e) {
        if (cat === 'all' || e.getAttribute('data-category') === cat) {
          e.style.display = '';
        } else {
          e.style.display = 'none';
        }
      });
    });
  });
});
</script>
</body>
</html>`;
  }

  // ── Section Renderers ───────────────────────────────────────────────

  _renderHealthScore(data) {
    const doctor = data.doctor;
    if (!doctor) return '<h2>Health Score</h2><div class="card"><p class="empty">Doctor check not available. Run <code>dynalloc doctor</code> first.</p></div>';

    const pct = doctor.percentage;
    let cls = 'score-poor';
    let label = 'Poor';
    if (pct >= 90) { cls = 'score-excellent'; label = 'Excellent'; }
    else if (pct >= 70) { cls = 'score-good'; label = 'Good'; }
    else if (pct >= 50) { cls = 'score-fair'; label = 'Fair'; }

    const passCount = doctor.checks.filter(c => c.status === 'PASS').length;
    const warnCount = doctor.checks.filter(c => c.status === 'WARNING').length;
    const errCount = doctor.checks.filter(c => c.status === 'ERROR').length;

    return `<h2>Health Score</h2>
<div class="card">
  <div style="display:flex; align-items:center; gap:2rem; flex-wrap:wrap;">
    <div class="score-ring ${cls}">${pct}%</div>
    <div>
      <div style="font-size:1.2rem; font-weight:600; color:var(--text-bright);">${this._esc(label)} — ${this._esc(doctor.summary)}</div>
      <div style="margin-top:0.5rem; color:var(--text-dim);">
        <span class="badge badge-pass">${passCount} PASS</span>
        <span class="badge badge-warn">${warnCount} WARNING</span>
        <span class="badge badge-error">${errCount} ERROR</span>
        <span style="margin-left:0.5rem;">${doctor.checks.length} total checks</span>
      </div>
    </div>
  </div>
</div>`;
  }

  _renderSystemInfo(data) {
    const s = data.status || {};
    const sys = data.system || {};
    const hostname = sys.hostname || os.hostname();
    const kernel = sys.kernel || os.release();
    const arch = sys.arch || os.arch();
    const cpus = sys.cpuCount || os.cpus().length;
    const memGb = sys.totalMemory ? (sys.totalMemory / (1024 * 1024 * 1024)).toFixed(1) : 'N/A';
    const uptime = s.uptime ? this._formatDuration(s.uptime) : 'N/A';

    return `<h2>System Information</h2>
<div class="grid grid-3">
  <div class="card"><div class="card-header">Host</div><div class="stat-value blue mono">${this._esc(hostname)}</div></div>
  <div class="card"><div class="card-header">Kernel</div><div class="stat-value mono">${this._esc(kernel)}</div></div>
  <div class="card"><div class="card-header">Architecture</div><div class="stat-value mono">${this._esc(arch)}</div></div>
  <div class="card"><div class="card-header">CPU Cores</div><div class="stat-value blue mono">${cpus}</div></div>
  <div class="card"><div class="card-header">Total Memory</div><div class="stat-value mono">${memGb} GB</div></div>
  <div class="card"><div class="card-header">Daemon Uptime</div><div class="stat-value green mono">${uptime}</div></div>
</div>
<div class="grid grid-3">
  <div class="card"><div class="card-header">Stress Level</div><div class="stat-value ${this._stressColor(s.stressLevel)} mono">${this._esc(s.stressLevel || 'N/A')}</div></div>
  <div class="card"><div class="card-header">Foreground PID</div><div class="stat-value mono">${s.foregroundPid || '(none)'}</div></div>
  <div class="card"><div class="card-header">Throttled</div><div class="stat-value ${s.throttledCount > 0 ? 'yellow' : 'green'} mono">${s.throttledCount || 0}</div></div>
</div>
${this._renderThermal(s)}`;
  }

  _renderThermal(s) {
    if (!s.thermal || !s.thermal.enabled) return '';
    const t = s.thermal;
    const tempStr = t.lastTemp != null ? `${t.lastTemp.toFixed(1)}°C` : 'N/A';
    const paused = t.paused ? 'YES' : 'no';
    const pausedColor = t.paused ? 'red' : 'green';
    return `<div class="card">
  <div class="card-header">Thermal Protection</div>
  <table>
    <tr><th>Temperature</th><th>Paused</th><th>Pause Count</th><th>Pause Threshold</th><th>Resume Threshold</th></tr>
    <tr>
      <td class="mono">${tempStr}</td>
      <td class="mono ${pausedColor}">${paused}</td>
      <td class="mono">${t.pauseCount || 0}</td>
      <td class="mono">${t.pauseThreshold || 'N/A'}°C</td>
      <td class="mono">${t.resumeThreshold || 'N/A'}°C</td>
    </tr>
  </table>
</div>`;
  }

  _renderPerformanceSummary(data) {
    const m = data.metrics || {};
    const counters = [];
    const gauges = [];

    if (m.scheduler_ticks) counters.push({ name: 'Scheduler Ticks', value: m.scheduler_ticks });
    if (m.boost_count) counters.push({ name: 'Boosts', value: m.boost_count });
    if (m.restore_count) counters.push({ name: 'Restores', value: m.restore_count });
    if (m.throttle_count) counters.push({ name: 'Throttles', value: m.throttle_count });
    if (m.foreground_changes) counters.push({ name: 'Foreground Changes', value: m.foreground_changes });
    if (m.policy_executions) counters.push({ name: 'Policy Executions', value: m.policy_executions });

    if (m.current_stress) gauges.push({ name: 'Stress Level', value: m.current_stress });
    if (m.daemon_uptime_seconds) gauges.push({ name: 'Uptime (s)', value: m.daemon_uptime_seconds });
    if (m.daemon_rss_kb) gauges.push({ name: 'RSS Memory (KB)', value: m.daemon_rss_kb });

    let html = '<h2>Performance Summary</h2>';
    if (counters.length > 0 || gauges.length > 0) {
      html += '<div class="grid">';
      for (const c of counters) {
        html += `<div class="card"><div class="card-header">${this._esc(c.name)}</div><div class="stat-value blue mono">${c.value}</div></div>`;
      }
      for (const g of gauges) {
        html += `<div class="card"><div class="card-header">${this._esc(g.name)}</div><div class="stat-value mono">${g.value}</div></div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="card"><p class="empty">No metrics available.</p></div>';
    }
    return html;
  }

  _renderRecommendations(data) {
    const recs = data.recommendations || [];
    const pending = Array.isArray(recs) ? recs.filter(r => r.status === 'pending') : [];

    let html = '<h2>Recommendations</h2>';
    if (pending.length === 0) {
      html += '<div class="card"><p class="empty">No pending recommendations.</p></div>';
      return html;
    }

    html += `<div class="card">
      <div class="card-header">${pending.length} Pending Recommendation(s)</div>`;
    for (const r of pending) {
      const priorityClass = `badge-${r.priority || 'medium'}`;
      html += `<div class="rec-card">
        <div><span class="badge ${priorityClass}">${this._esc(r.priority || 'medium').toUpperCase()}</span>
        <span style="color:var(--text-dim); font-size:0.8rem; margin-left:0.5rem;">${new Date(r.createdAt).toLocaleString()}</span>
        <span style="color:var(--text-dim); font-size:0.8rem; margin-left:0.5rem;">confidence: ${(r.confidence * 100).toFixed(0)}%</span></div>
        <p style="margin:0.3rem 0;"><strong>${this._esc(r.summary)}</strong></p>
        <p style="margin:0.3rem 0; color:var(--text-dim);">${this._esc(r.suggestion || '')}</p>
        <p style="margin:0.3rem 0; font-size:0.8rem; color:var(--text-dim);">Type: ${this._esc(r.type)} | ID: ${this._esc(r.id)}</p>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  _renderExplanations(data) {
    const exps = data.explanations || [];

    let html = '<h2>Recent Explanations</h2>';
    if (exps.length === 0) {
      html += '<div class="card"><p class="empty">No explanations recorded yet.</p></div>';
      return html;
    }

    html += '<div class="card" style="max-height:600px; overflow-y:auto;">';
    for (const e of exps.slice(0, 20)) {
      html += `<div class="explanation-card">
        <div style="display:flex; gap:1rem; align-items:baseline;">
          <strong>${this._esc(e.decision)}</strong>
          <span class="mono" style="color:var(--text-dim); font-size:0.8rem;">${this._esc(e.target)}</span>
          <span class="mono" style="color:var(--text-dim); font-size:0.8rem;">${new Date(e.ts).toLocaleTimeString()}</span>
        </div>
        <div style="margin:0.3rem 0; font-size:0.9rem;">${this._esc(e.outcome)}</div>
        <div style="margin:0.3rem 0;">`;
      for (const f of (e.factors || [])) {
        const icon = f.result ? '✓' : '✗';
        const cls = f.result ? 'factor-pass' : 'factor-fail';
        html += `<div class="${cls}" style="font-size:0.85rem;">  ${icon} ${this._esc(f.check)}${f.value != null ? ` (${f.value})` : ''}</div>`;
      }
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  _renderHealthCheck(data) {
    const doctor = data.doctor;
    if (!doctor || !doctor.checks || doctor.checks.length === 0) {
      return '<h2>Health Check</h2><div class="card"><p class="empty">No health check data available.</p></div>';
    }

    let html = '<h2>Health Check</h2><div class="card"><table>';
    html += '<tr><th>Check</th><th>Status</th><th>Message</th></tr>';
    for (const c of doctor.checks) {
      const badge = `badge-${c.status.toLowerCase()}`;
      html += `<tr><td>${this._esc(c.name)}</td><td><span class="badge ${badge}">${c.status}</span></td><td>${this._esc(c.message)}</td></tr>`;
    }
    html += '</table></div>';
    return html;
  }

  _renderTimeline(data) {
    const entries = data.timeline || [];
    const intel = data.intelligence || {};

    let html = '<h2>Event Timeline</h2>';

    if (entries.length === 0) {
      html += '<div class="card"><p class="empty">No timeline events recorded.</p></div>';
      return html;
    }

    // Get unique categories for filter
    const cats = [...new Set(entries.map(e => e.category))];

    html += '<div class="filter-bar">';
    html += '<button class="filter-btn active" data-filter="all">All</button>';
    for (const c of cats) {
      html += `<button class="filter-btn" data-filter="${this._esc(c)}">${this._esc(c)}</button>`;
    }
    html += '</div>';

    html += '<div class="card timeline">';
    for (const e of entries) {
      const catClass = `cat-${e.category}`;
      const sevColor = e.severity === 'error' ? 'color:var(--red)' : e.severity === 'warn' ? 'color:var(--yellow)' : '';
      html += `<div class="timeline-entry" data-category="${this._esc(e.category)}">
        <span class="timeline-time">${new Date(e.ts).toLocaleTimeString()}</span>
        <span class="timeline-cat ${catClass}">${this._esc(e.category)}</span>
        <span class="timeline-summary" style="${sevColor}">${this._esc(e.summary)}</span>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  _renderConfiguration(data) {
    const config = data.config || {};
    const keys = Object.keys(config).filter(k =>
      !k.startsWith('__') && typeof config[k] !== 'function' && typeof config[k] !== 'object'
    ).sort();

    if (keys.length === 0) {
      return '<h2>Current Configuration</h2><div class="card"><p class="empty">No configuration data available.</p></div>';
    }

    let html = '<h2>Current Configuration</h2><div class="card" style="max-height:600px; overflow-y:auto;"><table>';
    html += '<tr><th>Key</th><th>Value</th></tr>';
    for (const k of keys) {
      html += `<tr><td class="config-key mono">${this._esc(k)}</td><td class="config-val mono">${this._esc(String(config[k]))}</td></tr>`;
    }
    html += '</table></div>';
    return html;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * HTML-escape a string.
   * @param {string} s
   * @returns {string}
   * @private
   */
  _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Format seconds as human-readable duration.
   * @param {number} s
   * @returns {string}
   * @private
   */
  _formatDuration(s) {
    if (typeof s !== 'number' || s < 0) return 'N/A';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /**
   * Get a CSS class color for stress level.
   * @param {string} level
   * @returns {string}
   * @private
   */
  _stressColor(level) {
    if (!level) return '';
    switch (level) {
      case 'NORMAL': return 'green';
      case 'WARN': return 'yellow';
      case 'CRITICAL': return 'red';
      default: return '';
    }
  }
}

module.exports = { ReportGenerator };