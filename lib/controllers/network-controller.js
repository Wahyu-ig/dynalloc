'use strict';

/**
 * NetworkController — per-cgroup network QoS via Linux traffic control (tc)
 * and nftables cgroup marking.
 *
 * Phase 2 (ADR-0001). First new resource domain beyond the original
 * CPU/Memory/IO trio. Owns:
 *
 *   - `tc qdisc`  — install HTB root qdisc on a network interface
 *   - `tc class`  — foreground (high-priority) and background (shaped) classes
 *   - `tc filter` — fw-classifier filters that route packets by mark
 *   - `nftables`  — rules that set packet marks based on cgroupsv2 path
 *
 * Mechanism:
 *
 *   1. `tc qdisc add dev <iface> root handle 1: htb default 1`
 *      — install HTB root qdisc. Class 1:1 is the default (foreground).
 *
 *   2. `tc class add dev <iface> parent 1: classid 1:1 htb rate <fg_rate> ceil <fg_ceil>`
 *      — foreground class: high rate, high ceiling.
 *
 *   3. `tc class add dev <iface> parent 1: classid 1:2 htb rate <bg_rate> ceil <bg_ceil>`
 *      — background class: limited rate, lower ceiling.
 *
 *   4. `nft add table inet dynalloc_net_qos`
 *      `nft add chain inet dynalloc_net_qos mark { type filter hook output priority mangle \; }`
 *      `nft add rule inet dynalloc_net_qos mark cgroupsv2 <bg_path> mark set 0x2`
 *      `nft add rule inet dynalloc_net_qos mark cgroupsv2 <fg_path> mark set 0x1`
 *      — mark packets from foreground cgroup as 0x1, background as 0x2.
 *
 *   5. `tc filter add dev <iface> parent 1: protocol ip prio 1 handle 1 fw flowid 1:1`
 *      `tc filter add dev <iface> parent 1: protocol ip prio 1 handle 2 fw flowid 1:2`
 *      — route packets by mark: 0x1 → class 1:1 (foreground), 0x2 → class 1:2 (background).
 *
 * Security model:
 *
 *   - ALL command execution uses `child_process.execFile` with argument
 *     arrays. NEVER `exec` or `spawn` with shell strings. This eliminates
 *     shell-injection risk entirely.
 *   - Interface names are validated against `^[a-zA-Z0-9_.-]{1,15}$`
 *     before being passed to `tc`/`nft`.
 *   - Rate strings are validated against a strict regex (e.g.
 *     `^[0-9]+(kbit|mbit|gbit|tbit|Kbps|Mbps|Gbps|Tbps|bps)$`).
 *   - The `tc` and `nft` binaries are resolved via PATH lookup, never
 *     user-configurable. This prevents path-traversal / binary-substitution.
 *   - All operations respect DRY_RUN: in dry-run mode, the controller
 *     logs what it would execute but performs no syscalls.
 *   - Operations are idempotent where possible: `setup()` deletes
 *     existing qdisc/table before creating new ones, so re-running
 *     setup() (e.g. after hot-reload) doesn't accumulate state.
 *
 * Capability model:
 *
 *   - `isAvailable()` returns true only when ALL of:
 *       (a) `ENABLE_NETWORK_QOS` config flag is true
 *       (b) `tc` binary is found in PATH
 *       (c) running as root (euid === 0) OR DRY_RUN mode
 *       (d) when `NETWORK_QOS_USE_NFTABLES` is true, `nft` binary is found
 *   - When unavailable, the controller is a no-op. The Actuator silently
 *     skips calls to it.
 *
 * Rollback:
 *
 *   - `stop()` removes the qdisc (which cascades to classes and filters)
 *     and flushes the nftables table. The original interface state is
 *     NOT explicitly captured — removing the qdisc returns the interface
 *     to its default (no qdisc / pfifo_fast) state, which is the standard
 *     Linux default.
 */

const ResourceController = require('../resource-controller');
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const logger = require('../../logger');
const { debug, info, warn, trace } = logger;

// ── Constants ──────────────────────────────────────────────────────────

// Interface name validation: Linux allows alphanumerics, underscore, dash,
// and dot, max 15 chars (IFNAMSIZ). No shell metachars can appear.
const IFACE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

// Rate string validation: must be a number followed by a unit.
// Accepted units: bit/s suffixes used by `tc`.
const RATE_RE = /^[0-9]+(bit|kbit|mbit|gbit|tbit|Kbps|Mbps|Gbps|Tbps|bps)$/;

// HTB class IDs: 1:1 (foreground), 1:2 (background). Root qdisc handle is 1:.
const ROOT_QDISC_HANDLE = '1:';
const FG_CLASS_ID = '1:1';
const BG_CLASS_ID = '1:2';
const FG_MARK = '0x1';
const BG_MARK = '0x2';

// nftables table/chain names — prefixed with dynalloc_ to avoid collisions.
const NFT_TABLE = 'dynalloc_net_qos';
const NFT_CHAIN = 'mark';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a binary is available in PATH. Returns the resolved path or null.
 * Uses `execFileSync('which', [name])` — safe because `which` doesn't
 * invoke a shell and the binary name is a hardcoded constant.
 */
function _which(name) {
  try {
    const out = execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return out.toString().trim();
  } catch (_) {
    return null;
  }
}

/**
 * Validate an interface name against the safe-character regex.
 * Returns true if safe, false otherwise.
 */
function _validIface(iface) {
  return typeof iface === 'string' && IFACE_RE.test(iface);
}

/**
 * Validate a rate string against the tc rate syntax.
 * Returns true if safe, false otherwise.
 */
function _validRate(rate) {
  return typeof rate === 'string' && RATE_RE.test(rate);
}

/**
 * Detect the default network interface (the one with a default route).
 * Returns the interface name or null.
 * Uses `ip route show default` — safe because args are an array.
 */
function _detectDefaultInterface() {
  try {
    const out = execFileSync('ip', ['route', 'show', 'default'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    const match = out.toString().match(/^default via [^\s]+ dev ([^\s]+)/);
    if (match && _validIface(match[1])) return match[1];
  } catch (_) { /* ip unavailable or no default route */ }
  return null;
}

// ── NetworkController class ────────────────────────────────────────────

class NetworkController extends ResourceController {
  constructor(deps) {
    super('network', deps);

    // Capability cache — populated by _probeCapabilities()
    this._caps = null;

    // State flags
    this._qdiscInstalled = false;
    this._nftTableCreated = false;

    // Resolved interface (may differ from config if config was null/auto)
    this._resolvedIface = null;
  }

  // ── Capability probe ───────────────────────────────────────────────

  /**
   * Probe the system for the capabilities this controller needs.
   * Result is cached.
   *
   * @returns {object} { tc: bool, nft: bool, root: bool, iface: string|null }
   */
  _probeCapabilities() {
    if (this._caps) return this._caps;
    this._caps = {
      tc: !!_which('tc'),
      nft: !!_which('nft'),
      root: process.geteuid ? process.geteuid() === 0 : false,
      iface: null, // resolved lazily by setup()
    };
    debug(`NetworkController caps: tc=${this._caps.tc} nft=${this._caps.nft} root=${this._caps.root}`);
    return this._caps;
  }

  isAvailable() {
    if (!this.config.ENABLE_NETWORK_QOS) return false;
    const caps = this._probeCapabilities();
    if (!caps.tc) return false;
    if (this.config.NETWORK_QOS_USE_NFTABLES && !caps.nft) return false;
    // Root is required for tc/nft in real mode, but DRY_RUN can proceed without it.
    if (!caps.root && !this.isDryRun) return false;
    return true;
  }

  /**
   * Resolve the interface to manage: config override, else auto-detect.
   * @returns {string|null}
   */
  resolveInterface() {
    if (this._resolvedIface) return this._resolvedIface;
    const cfgIface = this.config.NETWORK_QOS_INTERFACE;
    if (cfgIface) {
      if (!_validIface(cfgIface)) {
        warn(`NETWORK_QOS_INTERFACE "${cfgIface}" gagal validasi nama interface, mengabaikan.`);
        return null;
      }
      this._resolvedIface = cfgIface;
    } else {
      this._resolvedIface = _detectDefaultInterface();
      if (this._resolvedIface) {
        info(`NetworkController: interface default terdeteksi: ${this._resolvedIface}`);
      } else {
        warn('NetworkController: tidak ada interface default (tidak ada default route).');
      }
    }
    return this._resolvedIface;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Set up the network QoS ruleset. Idempotent — deletes any existing
   * dynalloc qdisc/nft table before creating new ones.
   *
   * @returns {boolean} true on success (or in DRY_RUN), false on unavailable
   */
  setup() {
    if (!this.isAvailable()) {
      if (this.config.ENABLE_NETWORK_QOS) {
        warn('Network QoS diaktifkan di config tapi controller tidak available (tc/nft hilang atau bukan root).');
      }
      return false;
    }

    const iface = this.resolveInterface();
    if (!iface) {
      warn('Network QoS: tidak ada interface untuk dikelola, membatalkan setup.');
      return false;
    }

    // Validate rate strings from config
    const fgRate = this.config.NETWORK_QOS_FOREGROUND_RATE;
    const bgRate = this.config.NETWORK_QOS_BACKGROUND_RATE;
    const fgCeil = this.config.NETWORK_QOS_FOREGROUND_CEIL;
    const bgCeil = this.config.NETWORK_QOS_BACKGROUND_CEIL;
    if (!_validRate(fgRate) || !_validRate(bgRate) || !_validRate(fgCeil) || !_validRate(bgCeil)) {
      warn('Network QoS: rate/ceil string tidak valid, membatalkan setup.');
      return false;
    }

    if (this.isDryRun) {
      trace(`[DRY_RUN] would install HTB qdisc on ${iface}: fg=${fgRate}/${fgCeil} bg=${bgRate}/${bgCeil}`);
      if (this.config.NETWORK_QOS_USE_NFTABLES) {
        trace(`[DRY_RUN] would install nftables cgroup marking rules in table inet ${NFT_TABLE}`);
      }
      this._qdiscInstalled = true;
      this._nftTableCreated = this.config.NETWORK_QOS_USE_NFTABLES;
      info(`Network QoS (DRY_RUN): qdisc HTB pada ${iface} siap (simulasi).`);
      return true;
    }

    // ── Real mode: install qdisc + classes + filters ──────────────────
    try {
      // Idempotent: delete existing qdisc first (ignore errors if absent)
      this._execTc(['qdisc', 'del', 'dev', iface, 'root'], { allowFail: true });

      // Install HTB root qdisc. default 1:1 means unmarked traffic goes to fg class.
      this._execTc(['qdisc', 'add', 'dev', iface, 'root', 'handle', ROOT_QDISC_HANDLE, 'htb', 'default', '1']);

      // Foreground class (1:1)
      this._execTc(['class', 'add', 'dev', iface, 'parent', ROOT_QDISC_HANDLE, 'classid', FG_CLASS_ID,
        'htb', 'rate', fgRate, 'ceil', fgCeil]);

      // Background class (1:2)
      this._execTc(['class', 'add', 'dev', iface, 'parent', ROOT_QDISC_HANDLE, 'classid', BG_CLASS_ID,
        'htb', 'rate', bgRate, 'ceil', bgCeil]);

      // Filters: route packets by fw mark to the appropriate class
      this._execTc(['filter', 'add', 'dev', iface, 'parent', ROOT_QDISC_HANDLE, 'protocol', 'ip',
        'prio', '1', 'handle', '1', 'fw', 'flowid', FG_CLASS_ID]);
      this._execTc(['filter', 'add', 'dev', iface, 'parent', ROOT_QDISC_HANDLE, 'protocol', 'ip',
        'prio', '1', 'handle', '2', 'fw', 'flowid', BG_CLASS_ID]);

      this._qdiscInstalled = true;
      info(`Network QoS: qdisc HTB terpasang pada ${iface} (fg=${fgRate}/${fgCeil}, bg=${bgRate}/${bgCeil}).`);
    } catch (err) {
      warn(`Network QoS: gagal memasang qdisc pada ${iface}: ${err.message}`);
      return false;
    }

    // ── Install nftables cgroup marking rules ─────────────────────────
    if (this.config.NETWORK_QOS_USE_NFTABLES) {
      try {
        const fgPath = this.cgroupManager.foregroundCgroupPath;
        const bgPath = this.cgroupManager.backgroundCgroupPath;
        if (!fgPath || !bgPath) {
          warn('Network QoS: cgroup paths tidak tersedia, melewatkan nftables marking.');
        } else {
          // Idempotent: delete existing table first
          this._execNft(['delete', 'table', 'inet', NFT_TABLE], { allowFail: true });

          // Create table + chain
          this._execNft(['add', 'table', 'inet', NFT_TABLE]);
          // Chain at output hook with mangle priority (so marks are set before tc classification)
          this._execNft(['add', 'chain', 'inet', NFT_TABLE, NFT_CHAIN,
            '{', 'type', 'filter', 'hook', 'output', 'priority', 'mangle', ';', '}']);

          // Mark packets from background cgroup as 0x2
          this._execNft(['add', 'rule', 'inet', NFT_TABLE, NFT_CHAIN,
            'cgroupsv2', bgPath, 'mark', 'set', BG_MARK]);

          // Mark packets from foreground cgroup as 0x1
          this._execNft(['add', 'rule', 'inet', NFT_TABLE, NFT_CHAIN,
            'cgroupsv2', fgPath, 'mark', 'set', FG_MARK]);

          this._nftTableCreated = true;
          info(`Network QoS: nftables cgroup marking terpasang (table inet ${NFT_TABLE}).`);
        }
      } catch (err) {
        warn(`Network QoS: gagal memasang nftables rules: ${err.message}`);
        // Not fatal — HTB qdisc still works, just without cgroup-based marking.
        // Unmarked traffic defaults to class 1:1 (foreground) per the qdisc default.
      }
    }

    return true;
  }

  /**
   * Tear down the network QoS ruleset. Idempotent.
   */
  stop() {
    if (!this._qdiscInstalled && !this._nftTableCreated) return;

    const iface = this._resolvedIface;
    if (this.isDryRun) {
      trace(`[DRY_RUN] would tear down Network QoS on ${iface || '(unknown)'}`);
      this._qdiscInstalled = false;
      this._nftTableCreated = false;
      return;
    }

    // Remove nftables table (cascades to all chains/rules)
    if (this._nftTableCreated) {
      this._execNft(['delete', 'table', 'inet', NFT_TABLE], { allowFail: true });
      this._nftTableCreated = false;
      info(`Network QoS: nftables table inet ${NFT_TABLE} dihapus.`);
    }

    // Remove qdisc (cascades to classes and filters)
    if (this._qdiscInstalled && iface) {
      this._execTc(['qdisc', 'del', 'dev', iface, 'root'], { allowFail: true });
      this._qdiscInstalled = false;
      info(`Network QoS: qdisc HTB pada ${iface} dihapus.`);
    }
  }

  // ── Per-process actions (none — cgroup-level control only) ─────────

  /**
   * Network QoS is applied at the cgroup level (via nftables cgroupsv2
   * match), not per-process. Per-process network control would require
   * `tc filter` per PID, which is not scalable.
   *
   * The scheduler still calls applySchedulerClass() which routes the PID
   * to the foreground/background cgroup via the CgroupManager — that's
   * sufficient for network QoS to take effect.
   */
  applyToProcess() { /* no-op — cgroup-level control */ }

  // ── Introspection ──────────────────────────────────────────────────

  getStatus() {
    const caps = this._caps || this._probeCapabilities();
    return {
      name: this.name,
      available: this.isAvailable(),
      enabled: !!this.config.ENABLE_NETWORK_QOS,
      interface: this._resolvedIface,
      qdiscInstalled: this._qdiscInstalled,
      nftTableCreated: this._nftTableCreated,
      useNftables: !!this.config.NETWORK_QOS_USE_NFTABLES,
      caps: {
        tc: caps.tc,
        nft: caps.nft,
        root: caps.root,
      },
      rates: {
        foreground: this.config.NETWORK_QOS_FOREGROUND_RATE,
        background: this.config.NETWORK_QOS_BACKGROUND_RATE,
      },
    };
  }

  // ── Internal exec helpers ──────────────────────────────────────────

  /**
   * Execute `tc` with the given argument array. NEVER uses shell.
   *
   * @param {string[]} args  — argument array (no shell interpolation)
   * @param {object} opts    — { allowFail: bool } — if true, log warnings instead of throwing
   * @returns {boolean} true on success
   */
  _execTc(args, opts) {
    opts = opts || {};
    debug('EXEC: tc', args.join(' '));
    try {
      execFileSync('tc', args, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch (err) {
      if (opts.allowFail) {
        debug(`tc ${args.join(' ')} failed (allowed): ${err.message}`);
        return false;
      }
      warn(`tc ${args.join(' ')} gagal: ${err.message}`);
      throw err;
    }
  }

  /**
   * Execute `nft` with the given argument array. NEVER uses shell.
   *
   * @param {string[]} args  — argument array (no shell interpolation)
   * @param {object} opts    — { allowFail: bool }
   * @returns {boolean} true on success
   */
  _execNft(args, opts) {
    opts = opts || {};
    debug('EXEC: nft', args.join(' '));
    try {
      execFileSync('nft', args, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch (err) {
      if (opts.allowFail) {
        debug(`nft ${args.join(' ')} failed (allowed): ${err.message}`);
        return false;
      }
      warn(`nft ${args.join(' ')} gagal: ${err.message}`);
      throw err;
    }
  }
}

// Export the class + helpers (for testing)
module.exports = NetworkController;
module.exports._validIface = _validIface;
module.exports._validRate = _validRate;
module.exports._detectDefaultInterface = _detectDefaultInterface;
module.exports._which = _which;
module.exports.IFACE_RE = IFACE_RE;
module.exports.RATE_RE = RATE_RE;
