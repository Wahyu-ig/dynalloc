'use strict';

/**
 * DynAlloc — Recognition Layer :: Optimization Strategies
 * ========================================================
 *
 * Defines optimization strategy templates for each workload category.
 * These are PURE DATA — they describe WHAT settings to apply, not HOW.
 * The Resource Controller Layer (Phase 2) is responsible for applying
 * the actual settings.
 *
 * Each strategy maps a workload category to:
 *   - A profile ID (for the Profile Manager)
 *   - A description of the optimization approach
 *   - Key resource priorities (CPU/GPU/IO/Memory/Thermal/Power)
 *
 * The 14 workload categories (per Phase 5 spec):
 *
 *   1.  gaming              → gaming profile (low latency, high perf)
 *   2.  development         → development profile (balanced, fast FS)
 *   3.  web-browsing        → balanced profile (lightweight)
 *   4.  office-productivity → balanced profile (stable, low overhead)
 *   5.  video-editing       → rendering profile (max sustained perf)
 *   6.  audio-production    → streaming profile (low latency audio)
 *   7.  3d-rendering        → rendering profile (GPU-heavy, thermal-aware)
 *   8.  streaming           → streaming profile (multimedia protection)
 *   9.  virtual-machines    → balanced profile (memory-heavy)
 *  10.  containers          → balanced profile (IO-aware)
 *  11.  ai-ml               → performance profile (GPU-heavy)
 *  12.  file-compression    → balanced profile (CPU-burst)
 *  13.  idle                → idle profile (minimal resources)
 *  14.  background-tasks    → balanced profile (low priority)
 *
 * Backward compatibility: only used when ENABLE_WORKLOAD_RECOGNITION
 * is true.
 */

const OPTIMIZATION_STRATEGIES = Object.freeze({
  gaming: {
    workload: 'gaming',
    profile: 'gaming',
    description: 'Low latency, high performance, aggressive CPU policy, optimized I/O',
    priorities: {
      cpu: 'high',
      gpu: 'high',
      io: 'high',
      memory: 'medium',
      thermal: 'aggressive',  // cool thermal to prevent throttle
      power: 'performance',
    },
  },

  development: {
    workload: 'development',
    profile: 'development',
    description: 'Balanced CPU, fast filesystem response, stable memory behavior',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'high',           // fast FS for compile/link
      memory: 'stable',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  'web-browsing': {
    workload: 'web-browsing',
    profile: 'balanced',
    description: 'Lightweight, responsive, minimal overhead',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'medium',
      memory: 'medium',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  'office-productivity': {
    workload: 'office-productivity',
    profile: 'balanced',
    description: 'Stable, low overhead, responsive UI',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'medium',
      memory: 'medium',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  'video-editing': {
    workload: 'video-editing',
    profile: 'rendering',
    description: 'Maximum sustained performance, GPU-accelerated encoding',
    priorities: {
      cpu: 'high',
      gpu: 'high',
      io: 'high',          // reading/writing large video files
      memory: 'high',
      thermal: 'aggressive',
      power: 'performance',
    },
  },

  'audio-production': {
    workload: 'audio-production',
    profile: 'streaming',
    description: 'Low-latency audio, stable CPU scheduling',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'medium',
      memory: 'stable',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  '3d-rendering': {
    workload: '3d-rendering',
    profile: 'rendering',
    description: 'Maximum sustained performance, thermal-aware scheduling',
    priorities: {
      cpu: 'high',
      gpu: 'high',
      io: 'medium',
      memory: 'high',
      thermal: 'aggressive',  // rendering is sustained — prevent throttle
      power: 'performance',
    },
  },

  streaming: {
    workload: 'streaming',
    profile: 'streaming',
    description: 'Multimedia protection, stable playback',
    priorities: {
      cpu: 'balanced',
      gpu: 'medium',
      io: 'medium',
      memory: 'medium',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  'virtual-machines': {
    workload: 'virtual-machines',
    profile: 'balanced',
    description: 'Memory-heavy, balanced CPU',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'medium',
      memory: 'high',      // VMs need lots of RAM
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  containers: {
    workload: 'containers',
    profile: 'balanced',
    description: 'IO-aware, balanced resource sharing',
    priorities: {
      cpu: 'balanced',
      gpu: 'low',
      io: 'high',          // container image pulls, volume I/O
      memory: 'medium',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  'ai-ml': {
    workload: 'ai-ml',
    profile: 'performance',
    description: 'GPU-heavy compute, high power',
    priorities: {
      cpu: 'high',
      gpu: 'high',
      io: 'medium',
      memory: 'high',
      thermal: 'aggressive',
      power: 'performance',
    },
  },

  'file-compression': {
    workload: 'file-compression',
    profile: 'balanced',
    description: 'CPU-burst workload, short duration',
    priorities: {
      cpu: 'high',
      gpu: 'low',
      io: 'high',          // reading/writing compressed files
      memory: 'low',
      thermal: 'balanced',
      power: 'balanced',
    },
  },

  idle: {
    workload: 'idle',
    profile: 'idle',
    description: 'Minimal resource usage, power-efficient',
    priorities: {
      cpu: 'low',
      gpu: 'low',
      io: 'low',
      memory: 'low',
      thermal: 'balanced',
      power: 'power-saver',
    },
  },

  'background-tasks': {
    workload: 'background-tasks',
    profile: 'balanced',
    description: 'Low priority, does not override foreground workloads',
    priorities: {
      cpu: 'low',
      gpu: 'low',
      io: 'medium',
      memory: 'medium',
      thermal: 'balanced',
      power: 'balanced',
    },
  },
});

/**
 * Get the optimization strategy for a workload category.
 * @param {string} workload - workload category ID
 * @returns {object|null} strategy or null if unknown
 */
function getStrategy(workload) {
  return OPTIMIZATION_STRATEGIES[workload] || null;
}

/**
 * Get all workload category IDs.
 * @returns {string[]}
 */
function getWorkloadCategories() {
  return Object.keys(OPTIMIZATION_STRATEGIES);
}

module.exports = {
  OPTIMIZATION_STRATEGIES,
  getStrategy,
  getWorkloadCategories,
};
