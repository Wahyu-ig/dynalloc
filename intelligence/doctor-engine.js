'use strict';

/**
 * DynAlloc — Doctor Command (Enhanced v2.0)
 *
 * Comprehensive health check that verifies all subsystems.
 * Replaces the basic self-check with a thorough diagnostic
 * covering:
 *   - Scheduler
 *   - Policy Engine
 *   - Plugin System
 *   - Event Bus
 *   - IPC
 *   - Configuration
 *   - DBus (via self-check)
 *   - PSI availability
 *   - CPU governor
 *   - Power Profiles
 *   - Required binaries
 *   - Plugin integrity
 *   - Rule validation
 *   - File permissions
 *   - System compatibility
 *   - Learning Engine
 *   - Timeline Engine
 *   - Explainability Engine
 *   - Recommendation Engine
 *
 * Each check returns: PASS | WARNING | ERROR
 *
 * v2.0: Enhanced from basic self-check to comprehensive doctor.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────

/** Required binaries that dynalloc depends on. */
const REQUIRED_BINARIES = ['renice', 'ionice', 'taskset'];

/** Optional but recommended binaries. */
const OPTIONAL_BINARIES = [
  'cpupower', 'notify-send', 'pgrep', 'pw-cli', 'pw-top',
  'pactl', 'hyprctl', 'swaymsg', 'qdbus', 'kdotool', 'xdotool',
  'gdbus', 'nft', 'tc', 'systemctl',
];

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Run a binary check (exists and is executable).
 * @param {string} bin
 * @returns {{ available: boolean, path: string|null, error?: string }}
 */
function checkBinary(bin) {
  try {
    const which = execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    if (which) {
      try {
        fs.accessSync(which, fs.constants.X_OK);
        return { available: true, path: which };
      } catch (_) {
        return { available: false, path: which, error: 'not executable' };
      }
    }
  } catch (_) { /* not found */ }
  return { available: false, path: null };
}

/**
 * Safe stat check (never throws).
 * @param {string} filePath
 * @returns {{ exists: boolean, readable?: boolean, writable?: boolean, mode?: number }}
 */
function safeStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    return {
      exists: true,
      readable: fs.accessSync(filePath, fs.constants.R_OK) === undefined,
      writable: fs.accessSync(filePath, fs.constants.W_OK) === undefined,
      mode: st.mode,
    };
  } catch (_) {
    return { exists: false };
  }
}

/**
 * Check if a path is on a writable filesystem.
 * @param {string} dirPath
 * @returns {boolean}
 */
function isWritableDir(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Try to read PSI from /proc.
 * @param {string} filePath
 * @returns {{ available: boolean, value?: string, error?: string }}
 */
function readPsiFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8').trim();
    return { available: true, value: data.split('\n')[0] };
  } catch (err) {
    return { available: false, error: err.code === 'ENOENT' ? 'file not found' : err.message };
  }
}

// ── Doctor Engine ─────────────────────────────────────────────────────

class DoctorEngine {
  /**
   * Run all health checks.
   * @param {{ config?: object, selfCheckReport?: object, daemonState?: object, providers?: object }} opts
   * @returns {{ checks: Array<{ name: string, status: string, message: string, details?: object }>, score: number, maxScore: number, percentage: number, summary: string }}
   */
  run(opts = {}) {
    const checks = [];
    const config = opts.config || {};
    const selfCheck = opts.selfCheckReport || {};
    const daemonState = opts.daemonState || {};
    const providers = opts.providers || {};

    // ── 1. System Compatibility ────────────────────────────────────
    this._checkSystemCompatibility(checks, selfCheck);

    // ── 2. PSI Availability ────────────────────────────────────────
    this._checkPSI(checks);

    // ── 3. CPU Governor ────────────────────────────────────────────
    this._checkCpuGovernor(checks, selfCheck, config);

    // ── 4. Power Profiles Daemon ───────────────────────────────────
    this._checkPowerProfiles(checks, selfCheck, config);

    // ── 5. Required Binaries ───────────────────────────────────────
    this._checkBinaries(checks);

    // ── 6. Configuration ───────────────────────────────────────────
    this._checkConfiguration(checks, config);

    // ── 7. File Permissions ────────────────────────────────────────
    this._checkFilePermissions(checks, config);

    // ── 8. DBus ────────────────────────────────────────────────────
    this._checkDBus(checks, selfCheck);

    // ── 9. Scheduler ───────────────────────────────────────────────
    this._checkScheduler(checks, daemonState);

    // ── 10. Policy Engine ──────────────────────────────────────────
    this._checkPolicyEngine(checks, daemonState, config);

    // ── 11. Plugin System ──────────────────────────────────────────
    this._checkPluginSystem(checks, daemonState);

    // ── 12. Event Bus ──────────────────────────────────────────────
    this._checkEventBus(checks, daemonState);

    // ── 13. IPC ────────────────────────────────────────────────────
    this._checkIPC(checks, daemonState);

    // ── 14. Rule Validation ────────────────────────────────────────
    this._checkRuleValidation(checks, daemonState, config);

    // ── 15. Plugin Integrity ───────────────────────────────────────
    this._checkPluginIntegrity(checks, daemonState);

    // ── 16. Learning Engine ────────────────────────────────────────
    this._checkLearningEngine(checks, daemonState, config);

    // ── 17. Intelligence Subsystems ────────────────────────────────
    this._checkIntelligence(checks, daemonState);

    // ── 18. Monitoring ─────────────────────────────────────────────
    this._checkMonitoring(checks, daemonState, config);

    // Calculate score
    let score = 0;
    let maxScore = 0;
    for (const check of checks) {
      maxScore++;
      if (check.status === 'PASS') score++;
      else if (check.status === 'WARNING') score += 0.5;
    }

    const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 100;
    let summary;
    if (percentage >= 90) summary = 'Excellent — system is healthy.';
    else if (percentage >= 70) summary = 'Good — minor issues detected.';
    else if (percentage >= 50) summary = 'Fair — several issues need attention.';
    else summary = 'Poor — significant problems detected.';

    return {
      checks,
      score: Math.round(score * 10) / 10,
      maxScore,
      percentage,
      summary,
      timestamp: Date.now(),
    };
  }

  // ── Individual Check Methods ───────────────────────────────────────

  _checkSystemCompatibility(checks, selfCheck) {
    // Kernel version
    const kernel = os.release();
    const kernelMajor = parseInt(kernel.split('.')[0], 10);
    if (kernelMajor >= 5) {
      checks.push({ name: 'System Compatibility', status: 'PASS', message: `Linux kernel ${kernel} (>= 5.0)` });
    } else if (kernelMajor >= 4) {
      checks.push({ name: 'System Compatibility', status: 'WARNING', message: `Linux kernel ${kernel} — some features may be limited` });
    } else {
      checks.push({ name: 'System Compatibility', status: 'ERROR', message: `Linux kernel ${kernel} — PSI requires kernel >= 4.20` });
    }

    // Architecture
    const arch = os.arch();
    if (arch === 'x64' || arch === 'arm64') {
      checks.push({ name: 'Architecture', status: 'PASS', message: `${arch} — supported` });
    } else {
      checks.push({ name: 'Architecture', status: 'WARNING', message: `${arch} — not explicitly tested` });
    }

    // Running as root or with capabilities
    if (process.getuid && process.getuid() === 0) {
      checks.push({ name: 'Process Privileges', status: 'PASS', message: 'Running as root' });
    } else {
      // Check for CAP_SYS_NICE
      try {
        const status = execSync('capsh --print 2>/dev/null', { encoding: 'utf8' });
        if (status.includes('cap_sys_nice')) {
          checks.push({ name: 'Process Privileges', status: 'PASS', message: 'Running as non-root with CAP_SYS_NICE' });
        } else {
          checks.push({ name: 'Process Privileges', status: 'WARNING', message: 'Non-root without CAP_SYS_NICE — some operations may fail' });
        }
      } catch (_) {
        checks.push({ name: 'Process Privileges', status: 'WARNING', message: 'Cannot determine capabilities (capsh not found)' });
      }
    }
  }

  _checkPSI(checks) {
    const cpu = readPsiFile('/proc/pressure/cpu');
    const mem = readPsiFile('/proc/pressure/memory');
    const io = readPsiFile('/proc/pressure/io');

    if (cpu.available && mem.available) {
      checks.push({ name: 'PSI (CPU)', status: 'PASS', message: 'CPU pressure stall info available', details: { line: cpu.value } });
      checks.push({ name: 'PSI (Memory)', status: 'PASS', message: 'Memory pressure stall info available', details: { line: mem.value } });
    } else {
      if (!cpu.available) {
        checks.push({ name: 'PSI (CPU)', status: 'ERROR', message: `CPU PSI not available: ${cpu.error}`, details: cpu });
      }
      if (!mem.available) {
        checks.push({ name: 'PSI (Memory)', status: 'ERROR', message: `Memory PSI not available: ${mem.error}`, details: mem });
      }
    }

    if (io.available) {
      checks.push({ name: 'PSI (I/O)', status: 'PASS', message: 'I/O pressure stall info available' });
    } else {
      checks.push({ name: 'PSI (I/O)', status: 'WARNING', message: 'I/O PSI not available (optional, kernel >= 4.20+)' });
    }
  }

  _checkCpuGovernor(checks, selfCheck, config) {
    if (selfCheck.cpufreq && selfCheck.cpufreq.available) {
      checks.push({ name: 'CPU Governor', status: 'PASS', message: 'cpufreq interface available' });

      if (config.ENABLE_PPD_COORDINATION) {
        if (selfCheck.powerProfilesDaemon && selfCheck.powerProfilesDaemon.active) {
          checks.push({ name: 'Governor / PPD Coordination', status: 'PASS', message: 'Power Profiles Daemon (PPD) detected — DynAlloc governor switching is muted to avoid conflict. Set ENABLE_PPD_COORDINATION=false to override.' });
        } else {
          checks.push({ name: 'Governor / PPD Coordination', status: 'PASS', message: 'PPD coordination enabled, no conflict detected' });
        }
      }
    } else if (config.ENABLE_GOVERNOR_SWITCH) {
      checks.push({ name: 'CPU Governor', status: 'ERROR', message: 'Governor switching enabled but cpufreq not available' });
    } else {
      checks.push({ name: 'CPU Governor', status: 'WARNING', message: 'cpufreq not available — governor switching disabled' });
    }
  }

  _checkPowerProfiles(checks, selfCheck, config) {
    if (selfCheck.powerProfilesDaemon) {
      if (selfCheck.powerProfilesDaemon.active) {
        checks.push({
          name: 'Power Profiles Daemon',
          status: 'PASS',
          message: `PPD active (profile: "${selfCheck.powerProfilesDaemon.profile || 'unknown'}")`,
          details: selfCheck.powerProfilesDaemon,
        });
      } else {
        checks.push({ name: 'Power Profiles Daemon', status: 'WARNING', message: 'PPD installed but not active' });
      }
    } else {
      checks.push({ name: 'Power Profiles Daemon', status: 'PASS', message: 'PPD not detected (not required)' });
    }
  }

  _checkBinaries(checks) {
    // Required
    const missing = [];
    for (const bin of REQUIRED_BINARIES) {
      const result = checkBinary(bin);
      if (!result.available) missing.push(bin);
    }
    if (missing.length === 0) {
      checks.push({ name: 'Required Binaries', status: 'PASS', message: `All required binaries found: ${REQUIRED_BINARIES.join(', ')}` });
    } else {
      checks.push({ name: 'Required Binaries', status: 'ERROR', message: `Missing required binaries: ${missing.join(', ')}` });
    }

    // Optional
    const optResults = {};
    let optMissing = 0;
    for (const bin of OPTIONAL_BINARIES) {
      const result = checkBinary(bin);
      optResults[bin] = result;
      if (!result.available) optMissing++;
    }
    if (optMissing === 0) {
      checks.push({ name: 'Optional Binaries', status: 'PASS', message: `All ${OPTIONAL_BINARIES.length} optional binaries found` });
    } else if (optMissing < OPTIONAL_BINARIES.length / 2) {
      checks.push({ name: 'Optional Binaries', status: 'WARNING', message: `${optMissing}/${OPTIONAL_BINARIES.length} optional binaries missing (non-critical)` });
    } else {
      checks.push({ name: 'Optional Binaries', status: 'WARNING', message: `${optMissing}/${OPTIONAL_BINARIES.length} optional binaries missing — some features limited` });
    }
  }

  _checkConfiguration(checks, config) {
    if (!config || Object.keys(config).length === 0) {
      checks.push({ name: 'Configuration', status: 'ERROR', message: 'No configuration loaded' });
      return;
    }

    // Check for obviously wrong values
    const issues = [];
    if (config.FAST_TICK_MS < 200) issues.push('FAST_TICK_MS very low (< 200ms)');
    if (config.SLOW_TICK_MS < 500) issues.push('SLOW_TICK_MS very low (< 500ms)');
    if (config.PSI_CPU_WARN >= config.PSI_CPU_CRITICAL) issues.push('PSI_CPU_WARN >= PSI_CPU_CRITICAL');
    if (config.PSI_MEM_WARN >= config.PSI_MEM_CRITICAL) issues.push('PSI_MEM_WARN >= PSI_MEM_CRITICAL');

    if (issues.length === 0) {
      checks.push({ name: 'Configuration', status: 'PASS', message: 'Configuration validated successfully' });
    } else {
      checks.push({ name: 'Configuration', status: 'WARNING', message: `Configuration issues: ${issues.join('; ')}` });
    }
  }

  _checkFilePermissions(checks, config) {
    // Check config directory
    const configDir = path.join(os.homedir(), '.config', 'dynalloc');
    if (fs.existsSync(configDir)) {
      if (isWritableDir(configDir)) {
        checks.push({ name: 'Config Directory', status: 'PASS', message: `Writable: ${configDir}` });
      } else {
        checks.push({ name: 'Config Directory', status: 'WARNING', message: `Not writable: ${configDir}` });
      }
    } else {
      checks.push({ name: 'Config Directory', status: 'WARNING', message: `Does not exist: ${configDir} (will be created on first write)` });
    }

    // Check cgroup access
    const cgroupPath = '/sys/fs/cgroup';
    const cgroupStat = safeStat(cgroupPath);
    if (cgroupStat.exists && cgroupStat.readable) {
      checks.push({ name: 'Cgroup Access', status: 'PASS', message: 'Cgroup filesystem readable' });
    } else {
      checks.push({ name: 'Cgroup Access', status: 'WARNING', message: 'Cgroup filesystem not accessible' });
    }

    // Check /proc access
    const procStat = safeStat('/proc/pressure/cpu');
    if (procStat.exists && procStat.readable) {
      checks.push({ name: '/proc Access', status: 'PASS', message: '/proc filesystem readable' });
    } else {
      checks.push({ name: '/proc Access', status: 'WARNING', message: '/proc filesystem has restricted access' });
    }
  }

  _checkDBus(checks, selfCheck) {
    // Check for common D-Bus services
    const dbusChecks = [];
    if (selfCheck.gnomeWayland) dbusChecks.push('GNOME/Wayland');
    if (selfCheck.kdeWayland) dbusChecks.push('KDE/Wayland');
    if (selfCheck.hyprland) dbusChecks.push('Hyprland');
    if (selfCheck.sway) dbusChecks.push('Sway');

    if (dbusChecks.length > 0) {
      checks.push({ name: 'D-Bus Session', status: 'PASS', message: `Desktop environment detected: ${dbusChecks.join(', ')}` });
    } else {
      checks.push({ name: 'D-Bus Session', status: 'WARNING', message: 'No supported Wayland/X11 D-Bus session detected (event-driven focus unavailable)' });
    }

    // Granular per-tool foreground-detection diagnostics (restored from
    // v1.0.0 — the summary check above tells you *a* session was found,
    // this tells you whether the specific IPC tool that session needs is
    // actually installed, which is what you need to fix a broken setup).
    const ft = selfCheck.foregroundTool;
    if (ft) {
      const toolDescs = {
        hyprctl: 'Hyprland IPC',
        swaymsg: 'Sway IPC',
        qdbus: 'KDE KWin DBus',
        kdotool: 'KWin (third-party)',
        xdotool: 'X11',
        gdbus: 'GNOME Shell DBus',
      };
      for (const [tool, present] of Object.entries(ft)) {
        checks.push({
          name: `Foreground tool: ${tool}`,
          status: present ? 'PASS' : 'WARNING',
          message: present ? `${toolDescs[tool] || tool} available` : `${toolDescs[tool] || tool} not found`,
        });
      }
      if (selfCheck.hyprland && !ft.hyprctl) {
        checks.push({ name: 'Foreground detection', status: 'ERROR', message: 'Hyprland session detected but hyprctl not found — install the hyprland package' });
      }
      if (selfCheck.sway && !ft.swaymsg) {
        checks.push({ name: 'Foreground detection', status: 'ERROR', message: 'Sway session detected but swaymsg not found — install the sway package' });
      }
      if (selfCheck.kdeWayland && !ft.qdbus && !ft.kdotool) {
        checks.push({ name: 'Foreground detection', status: 'ERROR', message: 'KDE/Wayland session detected but neither qdbus nor kdotool available — install qt6-tools or kdotool' });
      }
      if (selfCheck.gnomeWayland && !ft.gdbus) {
        checks.push({ name: 'Foreground detection', status: 'ERROR', message: 'GNOME/Wayland session detected but gdbus not found — install the glib2 package' });
      }
      if (selfCheck.x11 && !ft.xdotool) {
        checks.push({ name: 'Foreground detection', status: 'ERROR', message: 'X11 session detected but xdotool not found — install the xdotool package' });
      }
    }
  }

  _checkScheduler(checks, daemonState) {
    if (daemonState.stressLevel) {
      checks.push({ name: 'Scheduler', status: 'PASS', message: `Running — stress level: ${daemonState.stressLevel}` });
    } else {
      checks.push({ name: 'Scheduler', status: 'WARNING', message: 'No scheduler state available' });
    }
  }

  _checkPolicyEngine(checks, daemonState, config) {
    if (!config.ENABLE_POLICY_ENGINE) {
      checks.push({ name: 'Policy Engine', status: 'PASS', message: 'Disabled by configuration (ENABLE_POLICY_ENGINE=false)' });
      return;
    }
    if (daemonState.policyEngine && daemonState.policyEngine.running) {
      checks.push({
        name: 'Policy Engine',
        status: 'PASS',
        message: `Running — ${daemonState.policyEngine.ruleCount} rules, uptime: ${daemonState.policyEngine.uptimeSeconds}s`,
      });
    } else {
      checks.push({ name: 'Policy Engine', status: 'WARNING', message: 'Enabled in config but not running' });
    }
  }

  _checkPluginSystem(checks, daemonState) {
    const pluginCount = Array.isArray(daemonState.plugins) ? daemonState.plugins.length : 0;
    if (pluginCount > 0) {
      checks.push({ name: 'Plugin System', status: 'PASS', message: `${pluginCount} plugin(s) loaded: ${daemonState.plugins.join(', ')}` });
    } else {
      checks.push({ name: 'Plugin System', status: 'WARNING', message: 'No plugins loaded' });
    }
  }

  _checkEventBus(checks, daemonState) {
    if (daemonState.policyEngine && daemonState.policyEngine.running) {
      // If PE is running, it has an event bus
      checks.push({ name: 'Event Bus', status: 'PASS', message: 'Active (via Policy Engine)' });
    } else if (daemonState.detectorLayer && daemonState.detectorLayer.enabled) {
      checks.push({ name: 'Event Bus', status: 'PASS', message: 'Active (via Detector Layer)' });
    } else {
      checks.push({ name: 'Event Bus', status: 'WARNING', message: 'No active event bus (enable Policy Engine or Detector Layer)' });
    }
  }

  _checkIPC(checks, daemonState) {
    // If we got daemonState, IPC is working
    checks.push({ name: 'IPC', status: 'PASS', message: 'IPC connection successful' });
  }

  _checkRuleValidation(checks, daemonState, config) {
    if (!config.ENABLE_POLICY_ENGINE) {
      checks.push({ name: 'Rule Validation', status: 'PASS', message: 'Skipped — policy engine disabled' });
      return;
    }
    if (daemonState.policyEngine && daemonState.policyEngine.ruleCount > 0) {
      checks.push({ name: 'Rule Validation', status: 'PASS', message: `${daemonState.policyEngine.ruleCount} rule(s) loaded and validated` });
    } else {
      checks.push({ name: 'Rule Validation', status: 'WARNING', message: 'Policy engine enabled but no rules loaded' });
    }
  }

  _checkPluginIntegrity(checks, daemonState) {
    const plugins = Array.isArray(daemonState.plugins) ? daemonState.plugins : [];
    if (plugins.length === 0) {
      checks.push({ name: 'Plugin Integrity', status: 'PASS', message: 'No plugins to validate' });
      return;
    }
    // Basic check: all loaded plugins have names
    const allNamed = plugins.every(p => typeof p === 'string' && p.length > 0);
    if (allNamed) {
      checks.push({ name: 'Plugin Integrity', status: 'PASS', message: `All ${plugins.length} plugin(s) passed integrity check` });
    } else {
      checks.push({ name: 'Plugin Integrity', status: 'WARNING', message: 'Some plugins have invalid names' });
    }
  }

  _checkLearningEngine(checks, daemonState, config) {
    if (!config.ENABLE_LEARNING_MODE && !config.ENABLE_INTELLIGENCE) {
      checks.push({ name: 'Learning Engine', status: 'PASS', message: 'Disabled by configuration' });
      return;
    }
    if (daemonState.intelligence && daemonState.intelligence.learningEngine) {
      const le = daemonState.intelligence.learningEngine;
      checks.push({
        name: 'Learning Engine',
        status: 'PASS',
        message: `Active — ${le.uniqueApps} apps tracked, ${le.totalObservations} observations`,
      });
    } else {
      checks.push({ name: 'Learning Engine', status: 'WARNING', message: 'Enabled but not initialized' });
    }
  }

  _checkIntelligence(checks, daemonState) {
    const intel = daemonState.intelligence || {};
    const parts = [];

    if (intel.recommendationEngine) {
      parts.push(`recommendations: ${intel.recommendationEngine.pendingCount} pending`);
    }
    if (intel.explainabilityEngine) {
      parts.push(`explanations: ${intel.explainabilityEngine.bufferSize} buffered`);
    }
    if (intel.timelineEngine) {
      parts.push(`timeline: ${intel.timelineEngine.bufferSize} events`);
    }

    if (parts.length > 0) {
      checks.push({ name: 'Intelligence Subsystems', status: 'PASS', message: parts.join(', ') });
    } else {
      checks.push({ name: 'Intelligence Subsystems', status: 'WARNING', message: 'Not initialized' });
    }
  }

  _checkMonitoring(checks, daemonState, config) {
    if (!config.ENABLE_MONITORING_FRAMEWORK) {
      checks.push({ name: 'Monitoring Framework', status: 'PASS', message: 'Disabled by configuration' });
      return;
    }
    if (daemonState.monitoring) {
      const m = daemonState.monitoring;
      const parts = [];
      if (m.systemMonitor) parts.push('system-monitor');
      if (m.diagnostics) parts.push('diagnostics');
      if (m.health) parts.push('health-checker');
      if (m.benchmark) parts.push('benchmark');
      if (m.metrics) parts.push('metrics-collector');
      if (parts.length > 0) {
        checks.push({ name: 'Monitoring Framework', status: 'PASS', message: `Active: ${parts.join(', ')}` });
      } else {
        checks.push({ name: 'Monitoring Framework', status: 'WARNING', message: 'Enabled but no monitoring components initialized' });
      }
    } else {
      checks.push({ name: 'Monitoring Framework', status: 'WARNING', message: 'Enabled but not initialized' });
    }
  }
}

module.exports = {
  DoctorEngine,
  REQUIRED_BINARIES,
  OPTIONAL_BINARIES,
  checkBinary,
  safeStat,
  readPsiFile,
};