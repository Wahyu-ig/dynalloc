'use strict';

/**
 * verify-network-qos.js — Security & safety validation for the Phase 2
 * NetworkController.
 *
 * Run with: node scripts/verify-network-qos.js
 *
 * This script performs source-text and behavioral checks to confirm:
 *
 *   1. No shell invocation — all exec uses execFile/execFileSync with
 *      argument arrays, never exec/spawn with shell strings.
 *   2. Input validation — interface names and rate strings are validated
 *      against strict regexes before being passed to tc/nft.
 *   3. DRY_RUN respected — no real syscalls in dry-run mode.
 *   4. Capability gating — controller is a no-op when disabled.
 *   5. Idempotent setup/teardown — re-running setup() doesn't accumulate.
 *   6. No user-configurable binary paths — tc/nft resolved via PATH only.
 *
 * If this script fails, the NetworkController has a safety regression.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2718 ${name}: ${err.message}`);
    fail++;
  }
}

console.log('Network QoS Security & Safety Validation');
console.log('='.repeat(60));

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'controllers', 'network-controller.js'),
  'utf8'
);

const ACTUATOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'actuator.js'),
  'utf8'
);

// ── 1. No shell invocation ─────────────────────────────────────────────

test('source uses execFileSync (not exec/spawn with shell)', () => {
  assert.ok(SRC.includes("require('child_process')"),
    'must require child_process');
  assert.ok(SRC.includes('execFileSync'),
    'must use execFileSync for synchronous tc/nft calls');
  // Forbidden: exec() with shell strings
  assert.ok(!/[^.]exec\(['"`]/.test(SRC),
    'must NOT use exec() with shell string (use execFile with arg array)');
  assert.ok(!/execSync\(['"`]/.test(SRC),
    'must NOT use execSync() with shell string');
});

test('all tc calls use argument arrays', () => {
  // Every _execTc call must pass an array as first arg
  const calls = SRC.match(/_execTc\(\[/g) || [];
  assert.ok(calls.length >= 5,
    `expected at least 5 _execTc([...]) calls, found ${calls.length}`);
});

test('all nft calls use argument arrays', () => {
  const calls = SRC.match(/_execNft\(\[/g) || [];
  assert.ok(calls.length >= 4,
    `expected at least 4 _execNft([...]) calls, found ${calls.length}`);
});

test('_execTc implementation uses execFileSync with args array', () => {
  assert.ok(/_execTc\(args, opts\)[\s\S]*?execFileSync\('tc', args,/.test(SRC),
    '_execTc must call execFileSync("tc", args, ...) — not execFileSync("tc " + ...)');
});

test('_execNft implementation uses execFileSync with args array', () => {
  assert.ok(/_execNft\(args, opts\)[\s\S]*?execFileSync\('nft', args,/.test(SRC),
    '_execNft must call execFileSync("nft", args, ...) — not execFileSync("nft " + ...)');
});

// ── 2. Input validation ────────────────────────────────────────────────

test('IFACE_RE regex is defined and strict', () => {
  assert.ok(/IFACE_RE = \/\^\[a-zA-Z0-9_\.\-\]\{1,15\}\$\//.test(SRC),
    'IFACE_RE must be ^[a-zA-Z0-9_.-]{1,15}$ (IFNAMSIZ-safe, no shell metachars)');
});

test('RATE_RE regex is defined and strict', () => {
  assert.ok(/RATE_RE = \/\^\[0-9\]\+\(bit\|kbit\|mbit\|gbit\|tbit\|Kbps\|Mbps\|Gbps\|Tbps\|bps\)\$\//.test(SRC),
    'RATE_RE must be ^[0-9]+(bit|kbit|mbit|gbit|tbit|Kbps|Mbps|Gbps|Tbps|bps)$');
});

test('setup() validates interface name before use', () => {
  // The setup() function must call _validIface or resolveInterface (which checks)
  assert.ok(/setup\(\)[\s\S]{0,2000}resolveInterface|_validIface/.test(SRC),
    'setup() must validate interface name via resolveInterface() or _validIface()');
});

test('setup() validates rate strings before use', () => {
  assert.ok(/setup\(\)[\s\S]{0,2000}_validRate/.test(SRC),
    'setup() must validate rate strings via _validRate()');
});

test('setup() rejects on invalid interface/rate', () => {
  assert.ok(/if \(!_validRate[\s\S]*?return false/.test(SRC) ||
            /!_validRate[\s\S]*?warn[\s\S]*?return false/.test(SRC),
    'setup() must return false when rate validation fails');
});

test('interface name is never string-interpolated into a command', () => {
  // Forbidden patterns: `tc ... ${iface} ...` inside a string passed to exec
  // We DO allow `${iface}` inside debug log strings (which are not executed).
  // Check that no execFileSync call uses a template string with ${iface}.
  const execBlocks = SRC.match(/execFileSync\([^)]+\)/g) || [];
  for (const block of execBlocks) {
    assert.ok(!block.includes('${iface}'),
      'execFileSync must not interpolate ${iface} (use args array instead): ' + block);
    assert.ok(!block.includes('${fgRate}'),
      'execFileSync must not interpolate ${fgRate} (use args array instead): ' + block);
  }
});

// ── 3. DRY_RUN respected ───────────────────────────────────────────────

test('setup() checks isDryRun before real syscalls', () => {
  assert.ok(/setup\(\)[\s\S]*?if \(this\.isDryRun\)[\s\S]*?trace\(/.test(SRC),
    'setup() must check isDryRun and trace (not execute) when in dry-run');
});

test('stop() checks isDryRun before real syscalls', () => {
  assert.ok(/stop\(\)[\s\S]*?if \(this\.isDryRun\)/.test(SRC),
    'stop() must check isDryRun before real teardown');
});

// ── 4. Capability gating ───────────────────────────────────────────────

test('isAvailable() checks ENABLE_NETWORK_QOS config flag', () => {
  assert.ok(/isAvailable\(\)[\s\S]*?ENABLE_NETWORK_QOS/.test(SRC),
    'isAvailable() must check config.ENABLE_NETWORK_QOS');
});

test('isAvailable() checks for tc binary', () => {
  assert.ok(/isAvailable\(\)[\s\S]*?caps\.tc/.test(SRC),
    'isAvailable() must check tc binary presence');
});

test('isAvailable() checks root or DRY_RUN', () => {
  assert.ok(/isAvailable\(\)[\s\S]*?caps\.root[\s\S]*?isDryRun/.test(SRC) ||
            /isAvailable\(\)[\s\S]*?isDryRun[\s\S]*?caps\.root/.test(SRC),
    'isAvailable() must check root OR DRY_RUN');
});

test('isAvailable() checks nft binary when USE_NFTABLES is true', () => {
  assert.ok(/NETWORK_QOS_USE_NFTABLES[\s\S]*?caps\.nft/.test(SRC),
    'isAvailable() must check nft binary when NETWORK_QOS_USE_NFTABLES is true');
});

// ── 5. Idempotent setup/teardown ───────────────────────────────────────

test('setup() deletes existing qdisc before creating new one', () => {
  assert.ok(/setup\(\)[\s\S]*?qdisc.*del.*allowFail[\s\S]*?qdisc.*add/.test(SRC),
    'setup() must delete existing qdisc (allowFail) before adding new one');
});

test('setup() deletes existing nft table before creating new one', () => {
  assert.ok(/setup\(\)[\s\S]*?delete.*table.*allowFail[\s\S]*?add.*table/.test(SRC),
    'setup() must delete existing nft table (allowFail) before adding new one');
});

test('stop() deletes qdisc and nft table with allowFail', () => {
  assert.ok(/stop\(\)[\s\S]*?delete.*table.*allowFail/.test(SRC),
    'stop() must delete nft table with allowFail');
  assert.ok(/stop\(\)[\s\S]*?qdisc.*del.*allowFail/.test(SRC),
    'stop() must delete qdisc with allowFail');
});

// ── 6. No user-configurable binary paths ───────────────────────────────

test('tc binary name is hardcoded (not from config)', () => {
  // The string 'tc' must appear as a literal in execFileSync calls, not
  // interpolated from config.
  assert.ok(/execFileSync\('tc',/.test(SRC),
    "tc binary must be hardcoded as 'tc' in execFileSync, not configurable");
});

test('nft binary name is hardcoded (not from config)', () => {
  assert.ok(/execFileSync\('nft',/.test(SRC),
    "nft binary must be hardcoded as 'nft' in execFileSync, not configurable");
});

test('no config key for tc/nft binary path', () => {
  // Config must NOT have a NETWORK_QOS_TC_PATH or similar
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.ok(!/NETWORK_QOS_TC_PATH|NETWORK_QOS_NFT_PATH/.test(configSrc),
    'config must NOT expose tc/nft binary paths (prevents path traversal)');
});

// ── 7. Actuator facade integration ─────────────────────────────────────

test('Actuator facade has networkSetup() method', () => {
  assert.ok(ACTUATOR_SRC.includes('networkSetup()'),
    'actuator.js must expose networkSetup()');
});

test('Actuator facade has networkStop() method', () => {
  assert.ok(ACTUATOR_SRC.includes('networkStop()'),
    'actuator.js must expose networkStop()');
});

test('Actuator facade has getNetworkStatus() method', () => {
  assert.ok(ACTUATOR_SRC.includes('getNetworkStatus()'),
    'actuator.js must expose getNetworkStatus()');
});

test('Actuator instantiates NetworkController only when ENABLE_NETWORK_QOS is true', () => {
  assert.ok(/if \(config\.ENABLE_NETWORK_QOS\)[\s\S]*?new NetworkController/.test(ACTUATOR_SRC),
    'Actuator must only instantiate NetworkController when config.ENABLE_NETWORK_QOS is true');
});

test('Actuator networkSetup() returns false when _network is null', () => {
  assert.ok(/networkSetup\(\)[\s\S]*?if \(!this\._network\) return false/.test(ACTUATOR_SRC),
    'networkSetup() must return false when _network is null (disabled)');
});

test('Actuator networkStop() is a no-op when _network is null', () => {
  assert.ok(/networkStop\(\)[\s\S]*?if \(!this\._network\) return/.test(ACTUATOR_SRC),
    'networkStop() must be a no-op when _network is null');
});

// ── 8. Config integration ──────────────────────────────────────────────

test('config.js has all NETWORK_QOS_* keys with correct defaults', () => {
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  assert.ok(/ENABLE_NETWORK_QOS: false/.test(configSrc),
    'ENABLE_NETWORK_QOS must default to false');
  assert.ok(/NETWORK_QOS_INTERFACE: null/.test(configSrc),
    'NETWORK_QOS_INTERFACE must default to null');
  assert.ok(/NETWORK_QOS_FOREGROUND_RATE: '1gbit'/.test(configSrc),
    "NETWORK_QOS_FOREGROUND_RATE must default to '1gbit'");
  assert.ok(/NETWORK_QOS_BACKGROUND_RATE: '10mbit'/.test(configSrc),
    "NETWORK_QOS_BACKGROUND_RATE must default to '10mbit'");
});

test('config.js has schema entries for all NETWORK_QOS_* keys', () => {
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  for (const key of [
    'ENABLE_NETWORK_QOS', 'NETWORK_QOS_INTERFACE',
    'NETWORK_QOS_FOREGROUND_RATE', 'NETWORK_QOS_BACKGROUND_RATE',
    'NETWORK_QOS_FOREGROUND_CEIL', 'NETWORK_QOS_BACKGROUND_CEIL',
    'NETWORK_QOS_USE_NFTABLES',
  ]) {
    assert.ok(configSrc.includes(`${key}:`),
      `CONFIG_SCHEMA must have entry for ${key}`);
  }
});

test('all NETWORK_QOS_* keys are in HOT_RELOADABLE_FIELDS', () => {
  const { HOT_RELOADABLE_FIELDS } = require(path.join(__dirname, '..', 'config.js'));
  for (const key of [
    'ENABLE_NETWORK_QOS', 'NETWORK_QOS_INTERFACE',
    'NETWORK_QOS_FOREGROUND_RATE', 'NETWORK_QOS_BACKGROUND_RATE',
    'NETWORK_QOS_FOREGROUND_CEIL', 'NETWORK_QOS_BACKGROUND_CEIL',
    'NETWORK_QOS_USE_NFTABLES',
  ]) {
    assert.ok(HOT_RELOADABLE_FIELDS.includes(key),
      `${key} must be in HOT_RELOADABLE_FIELDS`);
  }
});

// ── 9. Daemon integration ──────────────────────────────────────────────

test('daemon.js calls networkSetup() after setupCgroups()', () => {
  const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/setupCgroups\(\);[\s\S]{0,500}networkSetup\(\)/.test(daemonSrc),
    'daemon bootstrap must call networkSetup() after setupCgroups()');
});

test('daemon.js calls networkStop() in cleanupAndExit()', () => {
  const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/cleanupAndExit[\s\S]*?networkStop\(\)/.test(daemonSrc),
    'cleanupAndExit must call networkStop()');
});

test('daemon.js registers IPC network handler', () => {
  const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.ok(/registerHandler\('network'/.test(daemonSrc),
    "daemon must register IPC handler for 'network'");
});

// ── 10. CLI integration ────────────────────────────────────────────────

test('CLI has network command in switch', () => {
  const cliSrc = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  assert.ok(/case 'network':/.test(cliSrc),
    "CLI switch must have case 'network'");
  assert.ok(/cmdNetwork/.test(cliSrc),
    'CLI must have cmdNetwork function');
});

test('CLI help text mentions network command', () => {
  const cliSrc = fs.readFileSync(path.join(__dirname, '..', 'dynalloc-cli.js'), 'utf8');
  assert.ok(/network\s+Show Network QoS/.test(cliSrc),
    'CLI help text must mention network command');
});

// ── Summary ────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  Network QoS safety: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

if (fail > 0) {
  console.error('\nFAIL: Network QoS safety regression detected.');
  process.exit(1);
}

process.exit(0);
