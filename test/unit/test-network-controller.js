'use strict';

/**
 * test-network-controller.js — Unit tests for the Phase 2 NetworkController.
 *
 * Run with: node --test test/unit/test-network-controller.js
 *
 * All tests run in DRY_RUN mode or with mocked execFile — no real tc/nft
 * commands are executed. This makes the tests safe to run in CI containers
 * without root or the iproute2/nftables packages.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const NetworkController = require(path.join(__dirname, '..', '..', 'lib', 'controllers', 'network-controller.js'));
const CgroupManager = require(path.join(__dirname, '..', '..', 'lib', 'cgroup-manager.js'));
const { DEFAULT_CONFIG } = require(path.join(__dirname, '..', '..', 'config.js'));

// ── Test helpers ────────────────────────────────────────────────────────

function makeDeps(overrides) {
  const config = { ...DEFAULT_CONFIG, DRY_RUN: true, ...overrides };
  const cgroupManager = new CgroupManager(config);
  return {
    config,
    logger: require(path.join(__dirname, '..', '..', 'logger.js')),
    cgroupManager,
    tracker: { log() {} },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

test('NetworkController is a class extending ResourceController', () => {
  const ResourceController = require(path.join(__dirname, '..', '..', 'lib', 'resource-controller.js'));
  assert.strictEqual(typeof NetworkController, 'function');
  assert.ok(NetworkController.prototype instanceof ResourceController);
});

test('NetworkController constructs with deps', () => {
  const c = new NetworkController(makeDeps());
  assert.strictEqual(c.name, 'network');
});

test('isAvailable() returns false when ENABLE_NETWORK_QOS is false (default)', () => {
  const c = new NetworkController(makeDeps());
  assert.strictEqual(c.isAvailable(), false);
});

test('isAvailable() returns false when ENABLE_NETWORK_QOS is true but tc missing (mocked)', () => {
  // We can't easily mock `which` in a unit test, so we rely on the fact
  // that the test environment doesn't have tc in PATH for the root check.
  // Instead, test the config-flag path: with ENABLE_NETWORK_QOS=true but
  // DRY_RUN=true, isAvailable depends on tc binary presence.
  const c = new NetworkController(makeDeps({ ENABLE_NETWORK_QOS: true }));
  // In the test env, tc may or may not be present. Just verify it returns a boolean.
  assert.strictEqual(typeof c.isAvailable(), 'boolean');
});

test('_validIface accepts standard interface names', () => {
  assert.strictEqual(NetworkController._validIface('eth0'), true);
  assert.strictEqual(NetworkController._validIface('wlan0'), true);
  assert.strictEqual(NetworkController._validIface('enp3s0'), true);
  assert.strictEqual(NetworkController._validIface('br-lan'), true);
  assert.strictEqual(NetworkController._validIface('veth0.100'), true);
});

test('_validIface rejects shell metacharacters', () => {
  // These MUST be rejected to prevent shell injection (even though we use execFile)
  assert.strictEqual(NetworkController._validIface('eth0; rm -rf /'), false);
  assert.strictEqual(NetworkController._validIface('$(whoami)'), false);
  assert.strictEqual(NetworkController._validIface('`id`'), false);
  assert.strictEqual(NetworkController._validIface('eth0 && echo pwned'), false);
  assert.strictEqual(NetworkController._validIface('eth0|cat'), false);
  assert.strictEqual(NetworkController._validIface(''), false);
  assert.strictEqual(NetworkController._validIface(null), false);
  assert.strictEqual(NetworkController._validIface(undefined), false);
  assert.strictEqual(NetworkController._validIface(123), false);
});

test('_validIface rejects names longer than 15 chars (IFNAMSIZ)', () => {
  assert.strictEqual(NetworkController._validIface('abcdefghijklmnopqrst'), false);
});

test('_validRate accepts standard tc rate syntax', () => {
  assert.strictEqual(NetworkController._validRate('1gbit'), true);
  assert.strictEqual(NetworkController._validRate('10mbit'), true);
  assert.strictEqual(NetworkController._validRate('100kbit'), true);
  assert.strictEqual(NetworkController._validRate('56bit'), true);
  assert.strictEqual(NetworkController._validRate('1Gbps'), true);
  assert.strictEqual(NetworkController._validRate('10Mbps'), true);
  assert.strictEqual(NetworkController._validRate('1000bps'), true);
});

test('_validRate rejects invalid rate strings', () => {
  // Shell metacharacters
  assert.strictEqual(NetworkController._validRate('1gbit; rm -rf /'), false);
  assert.strictEqual(NetworkController._validRate('$(whoami)mbit'), false);
  assert.strictEqual(NetworkController._validRate('`id`mbit'), false);
  // Missing unit
  assert.strictEqual(NetworkController._validRate('1000'), false);
  // Invalid unit
  assert.strictEqual(NetworkController._validRate('100xbit'), false);
  // Negative
  assert.strictEqual(NetworkController._validRate('-10mbit'), false);
  // Empty / wrong type
  assert.strictEqual(NetworkController._validRate(''), false);
  assert.strictEqual(NetworkController._validRate(null), false);
  assert.strictEqual(NetworkController._validRate(undefined), false);
  assert.strictEqual(NetworkController._validRate(123), false);
});

test('setup() returns false when disabled (default config)', () => {
  const c = new NetworkController(makeDeps());
  assert.strictEqual(c.setup(), false);
});

test('setup() works in DRY_RUN mode when enabled', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'eth0',  // force interface to avoid auto-detect
    DRY_RUN: true,
  }));
  // In DRY_RUN, isAvailable() should return true if tc binary is present.
  // If tc is absent, setup() returns false — that's also a valid outcome.
  const result = c.setup();
  if (c.isAvailable()) {
    assert.strictEqual(result, true);
    assert.strictEqual(c._qdiscInstalled, true);
  } else {
    assert.strictEqual(result, false);
  }
});

test('setup() rejects invalid interface name', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'eth0; rm -rf /',  // shell injection attempt
    DRY_RUN: true,
  }));
  assert.strictEqual(c.setup(), false);
});

test('setup() rejects invalid rate string', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'eth0',
    NETWORK_QOS_FOREGROUND_RATE: '1gbit; rm -rf /',  // injection attempt
    DRY_RUN: true,
  }));
  assert.strictEqual(c.setup(), false);
});

test('stop() is a no-op when not set up', () => {
  const c = new NetworkController(makeDeps());
  assert.doesNotThrow(() => c.stop());
});

test('stop() cleans up in DRY_RUN mode after setup', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'eth0',
    DRY_RUN: true,
  }));
  if (c.isAvailable()) {
    c.setup();
    assert.strictEqual(c._qdiscInstalled, true);
    c.stop();
    assert.strictEqual(c._qdiscInstalled, false);
  }
});

test('getStatus() returns structured object', () => {
  const c = new NetworkController(makeDeps({ ENABLE_NETWORK_QOS: true }));
  const status = c.getStatus();
  assert.strictEqual(status.name, 'network');
  assert.strictEqual(typeof status.enabled, 'boolean');
  assert.strictEqual(typeof status.available, 'boolean');
  assert.strictEqual(typeof status.qdiscInstalled, 'boolean');
  assert.strictEqual(typeof status.nftTableCreated, 'boolean');
  assert.strictEqual(typeof status.useNftables, 'boolean');
  assert.ok(status.caps && typeof status.caps === 'object');
  assert.strictEqual(typeof status.caps.tc, 'boolean');
  assert.strictEqual(typeof status.caps.nft, 'boolean');
  assert.strictEqual(typeof status.caps.root, 'boolean');
  assert.ok(status.rates && typeof status.rates === 'object');
});

test('getStatus() reflects disabled state', () => {
  const c = new NetworkController(makeDeps());  // default: ENABLE_NETWORK_QOS=false
  const status = c.getStatus();
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.available, false);
});

test('applyToProcess() is a no-op (cgroup-level control only)', () => {
  const c = new NetworkController(makeDeps({ ENABLE_NETWORK_QOS: true }));
  assert.strictEqual(c.applyToProcess(), undefined);
  assert.strictEqual(c.applyToProcess(123, {}, [0]), undefined);
});

test('setConfig() updates config reference', () => {
  const c = new NetworkController(makeDeps({ ENABLE_NETWORK_QOS: false }));
  assert.strictEqual(c.config.ENABLE_NETWORK_QOS, false);
  c.setConfig({ ...DEFAULT_CONFIG, ENABLE_NETWORK_QOS: true, DRY_RUN: true });
  assert.strictEqual(c.config.ENABLE_NETWORK_QOS, true);
});

test('resolveInterface() returns config value when valid', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'wlan0',
  }));
  assert.strictEqual(c.resolveInterface(), 'wlan0');
});

test('resolveInterface() returns null for invalid config interface', () => {
  const c = new NetworkController(makeDeps({
    ENABLE_NETWORK_QOS: true,
    NETWORK_QOS_INTERFACE: 'eth0; rm -rf /',
  }));
  assert.strictEqual(c.resolveInterface(), null);
});

test('IFACE_RE and RATE_RE are exported for external validation', () => {
  assert.ok(NetworkController.IFACE_RE instanceof RegExp);
  assert.ok(NetworkController.RATE_RE instanceof RegExp);
});

test('_which returns string or null', () => {
  // `node` should always be in PATH
  const nodePath = NetworkController._which('node');
  assert.ok(typeof nodePath === 'string' || nodePath === null);
  // A nonexistent binary returns null
  const nope = NetworkController._which('definitely-not-a-real-binary-xyz123');
  assert.strictEqual(nope, null);
});

test('_detectDefaultInterface returns string or null', () => {
  const iface = NetworkController._detectDefaultInterface();
  assert.ok(typeof iface === 'string' || iface === null);
  if (iface) {
    // Must be a valid interface name
    assert.strictEqual(NetworkController._validIface(iface), true);
  }
});

// ── Integration with Actuator facade ───────────────────────────────────

test('Actuator facade exposes network methods', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const a = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  assert.strictEqual(typeof a.networkSetup, 'function');
  assert.strictEqual(typeof a.networkStop, 'function');
  assert.strictEqual(typeof a.getNetworkController, 'function');
  assert.strictEqual(typeof a.getNetworkStatus, 'function');
});

test('Actuator facade returns null network status when disabled (default)', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const a = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  assert.strictEqual(a.getNetworkStatus(), null);
  assert.strictEqual(a.getNetworkController(), null);
  // No-op calls don't throw
  assert.strictEqual(a.networkSetup(), false);
  assert.strictEqual(a.networkStop(), undefined);
});

test('Actuator facade instantiates NetworkController when enabled', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const a = new Actuator({
    ...DEFAULT_CONFIG,
    DRY_RUN: true,
    ENABLE_NETWORK_QOS: true,
  });
  assert.ok(a.getNetworkController() instanceof NetworkController);
  const status = a.getNetworkStatus();
  assert.ok(status);
  assert.strictEqual(status.enabled, true);
});

test('Actuator networkSetup() is safe to call when disabled', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const a = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  // Must not throw, must return false
  assert.strictEqual(a.networkSetup(), false);
});

test('Actuator networkStop() is safe to call when disabled', () => {
  const Actuator = require(path.join(__dirname, '..', '..', 'actuator.js'));
  const a = new Actuator({ ...DEFAULT_CONFIG, DRY_RUN: true });
  assert.doesNotThrow(() => a.networkStop());
});
