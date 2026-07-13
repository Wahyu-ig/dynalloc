'use strict';

/**
 * DynAlloc — Explainability Engine
 *
 * Every automatic decision must be explainable. This engine attaches
 * structured explanations to:
 *   - Scheduler decisions (boost / throttle / restore)
 *   - Policy engine rule matches and action executions
 *   - Governor changes
 *   - Profile switches
 *   - Plugin-triggered actions
 *
 * The explanation includes:
 *   - WHAT was decided
 *   - WHY each factor contributed
 *   - The confidence/weight of each factor
 *
 * Explanations are stored in a bounded ring buffer and exposed
 * via IPC for the CLI and HTML report.
 *
 * v2.0: Initial release.
 */

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum explanation entries in the ring buffer. */
const MAX_EXPLANATIONS = 500;

/** Maximum factors per explanation. */
const MAX_FACTORS = 20;

// ── Explainability Engine ──────────────────────────────────────────────

class ExplainabilityEngine {
  constructor(opts = {}) {
    this._config = opts.config || {};

    /**
     * Ring buffer of explanations, newest at the end.
     * @type {Array<object>}
     */
    this._buffer = [];

    /** Total explanations recorded (for stats). */
    this._totalRecorded = 0;

    /**
     * Optional: function to get current context for enrichment.
     * Set by the daemon during wiring.
     * @type {function|null}
     */
    this._contextProvider = null;
  }

  /**
   * Set a context provider function that returns current daemon state.
   * This enriches explanations with live context at recording time.
   * @param {function(): object} fn
   */
  setContextProvider(fn) {
    this._contextProvider = fn;
  }

  /**
   * Record an explanation for a scheduler decision.
   *
   * @param {object} opts
   * @param {string} opts.decision - "boost" | "throttle" | "restore" | "governor_change" | "profile_switch" | "plugin_action" | "policy_rule"
   * @param {string} opts.target - Human-readable target (e.g. "Steam (PID 1234)")
   * @param {Array<{ check: string, result: boolean, value?: string|number, weight?: number }>} opts.factors
   *   Each factor is a check that contributed to the decision.
   *   - check: human-readable description (e.g. "CPU pressure acceptable")
   *   - result: whether this check passed (✓ or ✗)
   *   - value: optional numeric or string value
   *   - weight: optional importance weight (0-1, default 1)
   * @param {string} [opts.outcome] - Final result description
   * @param {string} [opts.source] - "scheduler" | "policy_engine" | "plugin" | "governor" | "adaptive"
   * @param {object} [opts.metadata] - Additional structured data
   * @returns {object} The recorded explanation.
   */
  record(opts) {
    if (!opts || !opts.decision) return null;

    const context = this._contextProvider ? this._contextProvider() : {};
    const ts = Date.now();

    const explanation = {
      id: this._totalRecorded,
      ts,
      decision: opts.decision,
      target: opts.target || '',
      source: opts.source || 'unknown',
      outcome: opts.outcome || '',
      factors: (opts.factors || []).slice(0, MAX_FACTORS),
      metadata: opts.metadata || null,
      context: {
        stressLevel: context.stressLevel || null,
        cpuPressure: context.cpuPressure || null,
        memPressure: context.memPressure || null,
        battery: context.battery != null ? context.battery : null,
        foregroundPid: context.foregroundPid || null,
        thermal: context.thermal || null,
      },
    };

    this._buffer.push(explanation);
    if (this._buffer.length > MAX_EXPLANATIONS) {
      this._buffer.shift();
    }
    this._totalRecorded++;

    return explanation;
  }

  /**
   * Record a scheduler boost explanation.
   * @param {object} opts
   * @param {string} opts.comm
   * @param {number} opts.pid
   * @param {string} opts.schedClass
   * @param {number[]} opts.cores
   * @param {number} opts.nice
   * @param {{ cpu: number, ioClass: number, ioLevel: number }} opts.io
   * @param {boolean} opts.governorChanged
   * @param {string} [opts.governor]
   * @param {object} [opts.context]
   * @returns {object}
   */
  recordBoost(opts) {
    const factors = [];
    const ctx = opts.context || {};

    // Build check factors
    factors.push({
      check: `Application classified as ${opts.schedClass || 'INTERACTIVE'}`,
      result: true,
      weight: 1.0,
    });

    if (ctx.cpuPressure != null) {
      const acceptable = ctx.cpuPressure < 80;
      factors.push({
        check: `CPU pressure ${ctx.cpuPressure.toFixed(1)}% ${acceptable ? 'acceptable' : 'high'}`,
        result: acceptable,
        value: ctx.cpuPressure,
        weight: 0.8,
      });
    }

    if (ctx.memPressure != null) {
      const acceptable = ctx.memPressure < 60;
      factors.push({
        check: `Memory pressure ${ctx.memPressure.toFixed(1)}% ${acceptable ? 'acceptable' : 'high'}`,
        result: acceptable,
        value: ctx.memPressure,
        weight: 0.6,
      });
    }

    if (ctx.battery != null) {
      const sufficient = ctx.battery > 20;
      factors.push({
        check: `Battery ${ctx.battery.toFixed(0)}% ${sufficient ? 'sufficient' : 'low'}`,
        result: sufficient,
        value: ctx.battery,
        weight: 0.5,
      });
    }

    if (ctx.thermal != null) {
      const safe = ctx.thermal < 85;
      factors.push({
        check: `CPU temperature ${ctx.thermal.toFixed(1)}°C ${safe ? 'safe' : 'elevated'}`,
        result: safe,
        value: ctx.thermal,
        weight: 0.7,
      });
    }

    factors.push({
      check: `Pinned to cores [${opts.cores.join(', ')}]`,
      result: true,
    });

    factors.push({
      check: `Nice set to ${opts.nice}`,
      result: true,
      value: opts.nice,
    });

    factors.push({
      check: `IO priority class ${opts.io.ioClass}, level ${opts.io.ioLevel}`,
      result: true,
    });

    if (opts.governorChanged) {
      factors.push({
        check: `Governor changed to ${opts.governor || 'performance'}`,
        result: true,
        weight: 0.9,
      });
    } else {
      factors.push({
        check: 'Governor unchanged (disabled or thermal pause)',
        result: false,
        weight: 0.3,
      });
    }

    const allPassed = factors.filter(f => f.weight > 0.5).every(f => f.result);

    return this.record({
      decision: 'boost',
      target: `${opts.comm || 'unknown'} (PID ${opts.pid})`,
      source: 'scheduler',
      outcome: allPassed ? 'Full boost applied' : 'Boost applied with caveats',
      factors,
      metadata: {
        pid: opts.pid,
        comm: opts.comm,
        schedClass: opts.schedClass,
        cores: opts.cores,
        nice: opts.nice,
        governor: opts.governorChanged ? opts.governor : null,
      },
    });
  }

  /**
   * Record a scheduler throttle explanation.
   * @param {object} opts
   * @param {string} opts.comm
   * @param {number} opts.pid
   * @param {string} opts.reason
   * @param {number} opts.nice
   * @param {number[]} opts.cores
   * @param {object} [opts.context]
   * @returns {object}
   */
  recordThrottle(opts) {
    const factors = [];

    factors.push({
      check: `Process "${opts.comm || 'unknown'}" (PID ${opts.pid}) selected for throttling`,
      result: true,
      weight: 1.0,
    });

    factors.push({
      check: `Reason: ${opts.reason || 'high background CPU usage'}`,
      result: true,
      weight: 0.9,
    });

    factors.push({
      check: `Nice set to ${opts.nice} (background priority)`,
      result: true,
      value: opts.nice,
    });

    factors.push({
      check: `Restricted to background cores [${opts.cores.join(', ')}]`,
      result: true,
    });

    return this.record({
      decision: 'throttle',
      target: `${opts.comm || 'unknown'} (PID ${opts.pid})`,
      source: 'scheduler',
      outcome: `Throttled: ${opts.reason || 'background resource usage'}`,
      factors,
      metadata: { pid: opts.pid, comm: opts.comm, reason: opts.reason },
    });
  }

  /**
   * Record a governor change explanation.
   * @param {object} opts
   * @param {string} opts.governor
   * @param {number[]} opts.cores
   * @param {string} opts.reason
   * @param {object} [opts.context]
   * @returns {object}
   */
  recordGovernorChange(opts) {
    const factors = [];
    const ctx = opts.context || {};

    factors.push({
      check: `Governor set to "${opts.governor}" on cores [${opts.cores.join(', ')}]`,
      result: true,
      weight: 1.0,
    });

    factors.push({
      check: `Trigger: ${opts.reason}`,
      result: true,
      weight: 0.9,
    });

    if (ctx.thermal != null && ctx.thermal > 80) {
      factors.push({
        check: `Thermal caution: ${ctx.thermal.toFixed(1)}°C`,
        result: true,
        value: ctx.thermal,
        weight: 0.7,
      });
    }

    return this.record({
      decision: 'governor_change',
      target: `Governor → ${opts.governor}`,
      source: 'governor',
      outcome: `Governor changed: ${opts.reason}`,
      factors,
      metadata: { governor: opts.governor, cores: opts.cores, reason: opts.reason },
    });
  }

  /**
   * Record a policy engine action explanation.
   * @param {object} opts
   * @param {string} opts.ruleId
   * @param {string} opts.actionType
   * @param {string} opts.eventName
   * @param {boolean} opts.success
   * @param {string} [opts.error]
   * @param {object} [opts.matchDetails]
   * @param {number} [opts.elapsedMs]
   * @returns {object}
   */
  recordPolicyAction(opts) {
    const factors = [];

    factors.push({
      check: `Rule "${opts.ruleId}" matched event "${opts.eventName}"`,
      result: true,
      weight: 1.0,
    });

    factors.push({
      check: `Action: ${opts.actionType}`,
      result: opts.success,
      weight: 0.9,
    });

    if (opts.success) {
      factors.push({
        check: 'Action executed successfully',
        result: true,
        weight: 0.8,
      });
    } else {
      factors.push({
        check: `Action failed: ${opts.error || 'unknown error'}`,
        result: false,
        weight: 1.0,
      });
    }

    if (opts.elapsedMs != null) {
      factors.push({
        check: `Execution time: ${opts.elapsedMs.toFixed(1)}ms`,
        result: opts.elapsedMs < 100,
        value: opts.elapsedMs,
        weight: 0.3,
      });
    }

    // Include match details as additional factors
    if (opts.matchDetails && Array.isArray(opts.matchDetails.matchedConditions)) {
      for (const cond of opts.matchDetails.matchedConditions) {
        factors.push({
          check: `Condition: ${cond}`,
          result: true,
          weight: 0.7,
        });
      }
    }

    return this.record({
      decision: 'policy_rule',
      target: `Rule: ${opts.ruleId} → ${opts.actionType}`,
      source: 'policy_engine',
      outcome: opts.success
        ? `Policy action "${opts.actionType}" executed`
        : `Policy action failed: ${opts.error || 'unknown'}`,
      factors,
      metadata: {
        ruleId: opts.ruleId,
        actionType: opts.actionType,
        eventName: opts.eventName,
        success: opts.success,
        error: opts.error || null,
        elapsedMs: opts.elapsedMs || null,
      },
    });
  }

  /**
   * Record a profile switch explanation.
   * @param {object} opts
   * @param {string} opts.from
   * @param {string} opts.to
   * @param {string} opts.reason
   * @param {string} [opts.source]
   * @param {object} [opts.triggerInfo]
   * @returns {object}
   */
  recordProfileSwitch(opts) {
    const factors = [];

    factors.push({
      check: `Profile switched from "${opts.from || '(none)'}" to "${opts.to}"`,
      result: true,
      weight: 1.0,
    });

    factors.push({
      check: `Trigger: ${opts.reason}`,
      result: true,
      weight: 0.9,
    });

    if (opts.triggerInfo) {
      if (opts.triggerInfo.app) {
        factors.push({
          check: `Application: ${opts.triggerInfo.app}`,
          result: true,
          weight: 0.7,
        });
      }
      if (opts.triggerInfo.detector) {
        factors.push({
          check: `Detector: ${opts.triggerInfo.detector}`,
          result: true,
          weight: 0.6,
        });
      }
    }

    return this.record({
      decision: 'profile_switch',
      target: `${opts.from || '(none)'} → ${opts.to}`,
      source: opts.source || 'profile_manager',
      outcome: `Profile activated: ${opts.reason}`,
      factors,
      metadata: {
        from: opts.from,
        to: opts.to,
        reason: opts.reason,
        triggerInfo: opts.triggerInfo || null,
      },
    });
  }

  // ── Query Methods ────────────────────────────────────────────────

  /**
   * Get recent explanations (newest first).
   * @param {{ limit?: number, type?: string, source?: string }} [opts]
   * @returns {object[]}
   */
  getRecent(opts = {}) {
    let entries = this._buffer;

    if (opts.type) {
      entries = entries.filter(e => e.decision === opts.type);
    }
    if (opts.source) {
      entries = entries.filter(e => e.source === opts.source);
    }

    const limit = opts.limit || 50;
    const start = Math.max(0, entries.length - limit);
    return entries.slice(start).reverse();
  }

  /**
   * Get a single explanation by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getById(id) {
    return this._buffer.find(e => e.id === id) || null;
  }

  /**
   * Get the most recent explanation.
   * @returns {object|null}
   */
  getLatest() {
    return this._buffer.length > 0 ? this._buffer[this._buffer.length - 1] : null;
  }

  /**
   * Format an explanation as a human-readable string.
   * @param {object} explanation
   * @returns {string}
   */
  static format(explanation) {
    if (!explanation) return '(no explanation)';

    const lines = [];
    lines.push(`Decision: ${explanation.decision}`);
    lines.push(`Target: ${explanation.target}`);
    lines.push(`Source: ${explanation.source}`);
    lines.push(`Time: ${new Date(explanation.ts).toISOString()}`);
    lines.push('');
    lines.push('Reason:');

    for (const factor of explanation.factors) {
      const icon = factor.result ? '✓' : '✗';
      const value = factor.value != null ? ` (${factor.value})` : '';
      const weight = factor.weight != null && factor.weight !== 1
        ? ` [weight: ${(factor.weight * 100).toFixed(0)}%]`
        : '';
      lines.push(`  ${icon} ${factor.check}${value}${weight}`);
    }

    lines.push('');
    lines.push(`Outcome: ${explanation.outcome}`);

    return lines.join('\n');
  }

  /**
   * Get engine status.
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: true,
      bufferSize: this._buffer.length,
      maxBufferSize: MAX_EXPLANATIONS,
      totalRecorded: this._totalRecorded,
    };
  }

  /**
   * Clear all explanations.
   */
  clear() {
    this._buffer.length = 0;
    this._totalRecorded = 0;
  }
}

module.exports = {
  ExplainabilityEngine,
  MAX_EXPLANATIONS,
  MAX_FACTORS,
};