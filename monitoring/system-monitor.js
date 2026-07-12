'use strict';

/**
 * DynAlloc — Monitoring Layer :: System Monitor
 * ==============================================
 *
 * Provides a unified snapshot of system state by reading from the
 * existing sensor modules + daemon state references. The monitor
 * is READ-ONLY — it never modifies system state.
 *
 * Snapshot shape:
 *
 *   {
 *     timestamp: ISO8601,
 *     cpu: { pressure, avg10, avg60, avg300 },
 *     memory: { pressure, avg10, avg60, avg300 },
 *     thermal: { temp, zoneIndex },
 *     battery: { onBattery, capacity, status },
 *     network: { rxKbps },
 *     gpu: { type, utilization },
 *     workload: { classification, comm, pid },
 *     profile: { active, demandSet },
 *     controllers: [ { name, available } ],
 *     process: { count, topCpu },
 *   }
 *
 * The monitor accepts "providers" — functions that return subsystem
 * state. The daemon wires these at construction time. This avoids
 * circular imports (monitoring → daemon → monitoring).
 *
 * Backward compatibility: only constructed when
 * ENABLE_MONITORING_FRAMEWORK is true.
 */

const fs = require('fs');
const logger = require('../logger');
const { debug, warn } = logger;

class SystemMonitor {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {object} [opts.providers] - { getState, getMetrics, getRcmStatus, ... }
   */
  constructor(opts) {
    if (!opts || !opts.config) {
      throw new TypeError('SystemMonitor: opts.config is required');
    }
    this._config = opts.config;
    this._providers = opts.providers || {};
    this._snapshotCount = 0;
  }

  /**
   * Take a system state snapshot.
   * @returns {object} snapshot
   */
  snapshot() {
    this._snapshotCount++;
    const now = new Date().toISOString();

    const snap = {
      timestamp: now,
      cpu: this._readCpu(),
      memory: this._readMemory(),
      thermal: this._readThermal(),
      battery: this._readBattery(),
      network: this._readNetwork(),
      gpu: this._readGpu(),
      workload: this._readWorkload(),
      profile: this._readProfile(),
      controllers: this._readControllers(),
      process: this._readProcessInfo(),
    };

    return snap;
  }

  get snapshotCount() {
    return this._snapshotCount;
  }

  getStatus() {
    return {
      snapshotCount: this._snapshotCount,
      hasProviders: Object.keys(this._providers).length > 0,
    };
  }

  // ── Internal readers ─────────────────────────────────────────────

  _readCpu() {
    try {
      if (this._providers.readCpuPSI) {
        const psi = this._providers.readCpuPSI();
        if (psi && psi.some) {
          return {
            pressure: psi.some.avg10 || 0,
            avg10: psi.some.avg10 || 0,
            avg60: psi.some.avg60 || 0,
            avg300: psi.some.avg300 || 0,
          };
        }
      }
    } catch (_) { /* sensor unavailable */ }
    return { pressure: 0, avg10: 0, avg60: 0, avg300: 0 };
  }

  _readMemory() {
    try {
      if (this._providers.readMemPSI) {
        const psi = this._providers.readMemPSI();
        if (psi && psi.some) {
          return {
            pressure: psi.some.avg10 || 0,
            avg10: psi.some.avg10 || 0,
            avg60: psi.some.avg60 || 0,
            avg300: psi.some.avg300 || 0,
          };
        }
      }
    } catch (_) { /* sensor unavailable */ }
    return { pressure: 0, avg10: 0, avg60: 0, avg300: 0 };
  }

  _readThermal() {
    try {
      if (this._providers.readThermalTemp) {
        const temp = this._providers.readThermalTemp(this._config.THERMAL_ZONE_INDEX || 0);
        if (typeof temp === 'number') {
          return { temp, zoneIndex: this._config.THERMAL_ZONE_INDEX || 0 };
        }
      }
    } catch (_) { /* sensor unavailable */ }
    return { temp: null, zoneIndex: this._config.THERMAL_ZONE_INDEX || 0 };
  }

  _readBattery() {
    try {
      if (this._providers.readBatteryStatus) {
        const bat = this._providers.readBatteryStatus(this._config.BATTERY_CHECK_PATH);
        if (bat) return bat;
      }
    } catch (_) { /* sensor unavailable */ }
    return null;
  }

  _readNetwork() {
    try {
      if (this._providers.getNetworkRxBytes) {
        const net = this._providers.getNetworkRxBytes();
        if (net) return { rxBytes: net.rxBytes };
      }
    } catch (_) { /* sensor unavailable */ }
    return { rxBytes: 0 };
  }

  _readGpu() {
    try {
      if (this._providers.getGpuUtilization) {
        const gpu = this._providers.getGpuUtilization();
        if (gpu) return gpu;
      }
    } catch (_) { /* sensor unavailable */ }
    return { type: 'none', utilization: null };
  }

  _readWorkload() {
    try {
      if (this._providers.getState) {
        const state = this._providers.getState();
        if (state) {
          return {
            classification: state.stressLevel || 'NORMAL',
            foregroundPid: state.foregroundPid || null,
            throttledCount: state.throttledCount || 0,
            mediaProtectedCount: state.mediaProtectedCount || 0,
          };
        }
      }
    } catch (_) { /* daemon state unavailable */ }
    return { classification: 'UNKNOWN', foregroundPid: null, throttledCount: 0 };
  }

  _readProfile() {
    try {
      if (this._providers.getProfileManagerStatus) {
        const pm = this._providers.getProfileManagerStatus();
        if (pm && pm.enabled) {
          return {
            active: pm.activeProfileId,
            demandSetSize: pm.demandSet ? pm.demandSet.length : 0,
            switchCount: pm.switchCount || 0,
          };
        }
      }
    } catch (_) { /* PM unavailable */ }
    return { active: null, demandSetSize: 0, switchCount: 0 };
  }

  _readControllers() {
    try {
      if (this._providers.getRcmStatus) {
        const rcm = this._providers.getRcmStatus();
        if (rcm && rcm.controllers) {
          return rcm.controllers.map((c) => ({
            name: c.name,
            available: c.available !== false,
          }));
        }
      }
    } catch (_) { /* RCM unavailable */ }
    return [];
  }

  _readProcessInfo() {
    try {
      // Read /proc/self/status for RSS
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/i);
      const rss = rssMatch ? parseInt(rssMatch[1], 10) : 0;

      // Read /proc/self/stat for CPU
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const parts = stat.split(' ');
      const utime = parseInt(parts[13], 10) || 0;
      const stime = parseInt(parts[14], 10) || 0;

      return {
        daemonRssKb: rss,
        daemonCpuTicks: utime + stime,
      };
    } catch (_) {
      return { daemonRssKb: 0, daemonCpuTicks: 0 };
    }
  }
}

module.exports = SystemMonitor;
