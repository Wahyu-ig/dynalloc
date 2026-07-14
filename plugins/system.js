'use strict';

const os = require('os');

/**
 * Plugin: System Detector
 *
 * Monitors system health indicators (load average, RAM usage)
 * and flags resource-heavy processes under high stress.
 */

module.exports = {
  name: 'system',
  version: '1.0.0',
  description: 'System health monitoring plugin',

  detect(procs, context) {
    const results = [];
    const LOAD_THRESHOLD = 1.5;
    const RAM_THRESHOLD = 90.0;

    const cpus = os.cpus();
    const cpuCount = cpus && cpus.length ? cpus.length : 1;
    
    const loadavg = os.loadavg();
    const loadAvg1m = loadavg && loadavg.length ? loadavg[0] : 0;
    const normalizedLoad = loadAvg1m / cpuCount;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramUsagePct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

    const isHighLoad = normalizedLoad > LOAD_THRESHOLD;
    const isHighRam = ramUsagePct > RAM_THRESHOLD;

    if (isHighLoad || isHighRam) {
      for (const proc of procs) {
        // Only target active processes (CPU usage > 10%)
        if (proc.pid && proc.pcpu > 10) {
          let reason = '';
          if (isHighLoad && isHighRam) {
            reason = `System load high (${normalizedLoad.toFixed(2)}/core) & RAM critical (${ramUsagePct.toFixed(1)}%). Active process CPU: ${proc.pcpu}%`;
          } else if (isHighLoad) {
            reason = `System load high (${normalizedLoad.toFixed(2)}/core). Active process CPU: ${proc.pcpu}%`;
          } else {
            reason = `System RAM critical (${ramUsagePct.toFixed(1)}%). Active process CPU: ${proc.pcpu}%`;
          }

          results.push({
            pid: proc.pid,
            action: 'MONITOR',
            reason: reason,
          });
        }
      }
    }

    return results;
  },
};