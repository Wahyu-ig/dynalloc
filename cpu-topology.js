'use strict';

/**
 * DynAlloc — CPU Topology Module
 *
 * Detects CPU layout: logical/physical cores, SMT/HT, NUMA nodes,
 * Intel Hybrid (P-Core/E-Core), and AMD CCD.
 *
 * v2.1: Added proper input validation, no side effects on require.
 */

const fs = require('fs');
const path = require('path');

const SYS_CPU = '/sys/devices/system/cpu';
const SYS_NODE = '/sys/devices/system/node';

let _cache = null;

function readSysfs(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function getLogicalCoreCount() {
  return require('os').cpus().length;
}

function readIntSysfs(filePath, fallback = 0) {
  const raw = readSysfs(filePath);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseCpuList(listStr) {
  if (!listStr) return [];
  const result = new Set();
  for (const part of listStr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.split('-');
    if (range.length === 2) {
      const start = parseInt(range[0], 10);
      const end = parseInt(range[1], 10);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        for (let i = start; i <= end; i++) result.add(i);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n) && n >= 0) result.add(n);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

function detectSMT(logicalCount) {
  let smtEnabled = false;
  let threadsPerCore = 1;
  const coreIdMap = new Map();
  for (let cpu = 0; cpu < logicalCount; cpu++) {
    const coreId = readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'topology', 'core_id'));
    if (!coreIdMap.has(coreId)) coreIdMap.set(coreId, 0);
    coreIdMap.set(coreId, coreIdMap.get(coreId) + 1);
  }
  for (const count of coreIdMap.values()) {
    if (count > 1) {
      smtEnabled = true;
      if (count > threadsPerCore) threadsPerCore = count;
    }
  }
  return { smtEnabled, threadsPerCore, physicalCoreCount: coreIdMap.size };
}

function buildLogicalToPhysicalMap(logicalCount) {
  const map = new Map();
  for (let cpu = 0; cpu < logicalCount; cpu++) {
    const coreId = readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'topology', 'core_id'));
    map.set(cpu, coreId);
  }
  return map;
}

function buildThreadSiblingMap(logicalCount) {
  const map = new Map();
  for (let cpu = 0; cpu < logicalCount; cpu++) {
    const siblingsStr = readSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'topology', 'thread_siblings_list'));
    map.set(cpu, parseCpuList(siblingsStr));
  }
  return map;
}

function detectNUMA() {
  const nodes = [];
  try {
    const entries = fs.readdirSync(SYS_NODE);
    for (const entry of entries) {
      const match = entry.match(/^node(\d+)$/);
      if (!match) continue;
      const nodeIndex = parseInt(match[1], 10);
      const cpulistPath = path.join(SYS_NODE, entry, 'cpulist');
      const cpus = parseCpuList(readSysfs(cpulistPath));
      if (cpus.length > 0) {
        nodes.push({ index: nodeIndex, cpus });
      }
    }
  } catch (_) { /* NUMA sysfs not available */ }
  return nodes;
}

function detectIntelHybrid(logicalCount) {
  let isHybrid = false;
  const pCores = [];
  const eCores = [];

  // Method 1: Check cpu_capacity
  const capacities = new Map();
  for (let cpu = 0; cpu < logicalCount; cpu++) {
    const cap = readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'cpu_capacity'), -1);
    if (cap > 0) {
      if (!capacities.has(cap)) capacities.set(cap, []);
      capacities.get(cap).push(cpu);
    }
  }

  if (capacities.size >= 2) {
    isHybrid = true;
    const sortedCaps = Array.from(capacities.keys()).sort((a, b) => b - a);
    pCores.push(...(capacities.get(sortedCaps[0]) || []));
    for (let i = 1; i < sortedCaps.length; i++) {
      eCores.push(...(capacities.get(sortedCaps[i]) || []));
    }
    return { isHybrid, pCores, eCores };
  }

  // Method 2: Check CPU model name
  const cpuModel = (require('os').cpus()[0] || {}).model || '';
  const hybridPatterns = [
    /Intel.*\b(?:12|13|14)th Gen/i,
    /Intel.*Core.*Ultra/i,
    /Intel.*Meteor/i,
    /Intel.*Raptor/i,
    /Intel.*Alder.*Lake/i,
  ];

  if (hybridPatterns.some((re) => re.test(cpuModel))) {
    const coreIdMap = buildLogicalToPhysicalMap(logicalCount);
    const uniqueCoreIds = Array.from(new Set(coreIdMap.values())).sort((a, b) => a - b);
    const midPoint = Math.ceil(uniqueCoreIds.length / 2);

    for (let cpu = 0; cpu < logicalCount; cpu++) {
      const coreId = coreIdMap.get(cpu);
      if (coreId < midPoint) {
        pCores.push(cpu);
      } else {
        eCores.push(cpu);
      }
    }

    isHybrid = pCores.length > 0 && eCores.length > 0;
  }

  return { isHybrid, pCores, eCores };
}

function detectAMDCCD(logicalCount) {
  const ccds = [];
  for (let cpu = 0; cpu < logicalCount; cpu++) {
    const cacheId = readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'cache', 'index3', 'id'), -1);
    const cacheLevel = readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'cache', 'index3', 'level'), -1);

    if (cacheId >= 0 && cacheLevel === 3) {
      let ccd = ccds.find((c) => c.cacheId === cacheId);
      if (!ccd) {
        ccd = { cacheId, cpus: [] };
        ccds.push(ccd);
      }
      ccd.cpus.push(cpu);
    }
  }

  const cpuModel = (require('os').cpus()[0] || {}).model || '';
  const isAMD = /AMD/i.test(cpuModel);

  return { isAMD, ccds, ccdCount: ccds.length };
}

function getCoreFrequency(cpu) {
  if (typeof cpu !== 'number' || cpu < 0) return 0;
  return readIntSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'cpufreq', 'scaling_cur_freq'), 0);
}

function getCoreGovernor(cpu) {
  if (typeof cpu !== 'number' || cpu < 0) return null;
  return readSysfs(path.join(SYS_CPU, `cpu${cpu}`, 'cpufreq', 'scaling_governor'));
}

function detect() {
  if (_cache) return _cache;

  const logicalCount = getLogicalCoreCount();
  const smt = detectSMT(logicalCount);
  const logicalToPhysical = buildLogicalToPhysicalMap(logicalCount);
  const threadSiblings = buildThreadSiblingMap(logicalCount);
  const numaNodes = detectNUMA();
  const hybrid = detectIntelHybrid(logicalCount);
  const amd = detectAMDCCD(logicalCount);

  _cache = {
    logicalCount,
    physicalCount: smt.physicalCoreCount,
    smtEnabled: smt.smtEnabled,
    threadsPerCore: smt.threadsPerCore,
    numaNodes,
    isHybrid: hybrid.isHybrid,
    pCores: hybrid.pCores,
    eCores: hybrid.eCores,
    isAMD: amd.isAMD,
    ccds: amd.ccds,
    ccdCount: amd.ccdCount,
    logicalToPhysical,
    threadSiblings,
  };

  return _cache;
}

function resetCache() {
  _cache = null;
}

module.exports = {
  detect,
  resetCache,
  readSysfs,
  readIntSysfs,
  parseCpuList,
  getLogicalCoreCount,
  getCoreFrequency,
  getCoreGovernor,
};