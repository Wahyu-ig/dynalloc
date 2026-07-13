'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const systemPlugin = require(path.join(__dirname, '..', '..', 'plugins', 'system.js'));

test('system plugin manifest properties', () => {
  assert.strictEqual(systemPlugin.name, 'system');
  assert.strictEqual(systemPlugin.version, '1.0.0');
  assert.strictEqual(typeof systemPlugin.detect, 'function');
});

test('system plugin returns empty array when load and RAM are low (healthy system)', (t) => {
  t.mock.method(os, 'cpus', () => [{}, {}, {}, {}]); // 4 CPUs
  t.mock.method(os, 'loadavg', () => [2.0, 2.0, 2.0]); // Load avg = 2.0 -> Normalized = 2.0/4 = 0.5 (< 1.5)
  t.mock.method(os, 'totalmem', () => 16000000000);
  t.mock.method(os, 'freemem', () => 8000000000); // 50% usage (< 90%)

  const procs = [
    { pid: 123, ppid: 1, pcpu: 15, comm: 'active-proc' },
    { pid: 456, ppid: 1, pcpu: 2, comm: 'idle-proc' }
  ];

  const results = systemPlugin.detect(procs, {});
  assert.deepStrictEqual(results, []);
});

test('system plugin detects heavy processes when normalized load average is high (>1.5)', (t) => {
  t.mock.method(os, 'cpus', () => [{}, {}]); // 2 CPUs
  t.mock.method(os, 'loadavg', () => [4.0, 4.0, 4.0]); // Load avg = 4.0 -> Normalized = 4.0/2 = 2.0 (> 1.5)
  t.mock.method(os, 'totalmem', () => 16000000000);
  t.mock.method(os, 'freemem', () => 8000000000); // 50% usage

  const procs = [
    { pid: 123, ppid: 1, pcpu: 15, comm: 'cpu-hog' },
    { pid: 456, ppid: 1, pcpu: 5, comm: 'light-proc' }
  ];

  const results = systemPlugin.detect(procs, {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].pid, 123);
  assert.strictEqual(results[0].action, 'MONITOR');
  assert.ok(results[0].reason.includes('System load high'));
  assert.ok(results[0].reason.includes('2.00/core'));
});

test('system plugin detects heavy processes when RAM usage is critical (>90%)', (t) => {
  t.mock.method(os, 'cpus', () => [{}, {}, {}, {}]); // 4 CPUs
  t.mock.method(os, 'loadavg', () => [1.0, 1.0, 1.0]); // Normalized = 0.25
  t.mock.method(os, 'totalmem', () => 1000);
  t.mock.method(os, 'freemem', () => 50); // 95% usage (> 90%)

  const procs = [
    { pid: 789, ppid: 1, pcpu: 20, comm: 'ram-intensive-heavy-cpu' },
    { pid: 101, ppid: 1, pcpu: 1, comm: 'light-proc' }
  ];

  const results = systemPlugin.detect(procs, {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].pid, 789);
  assert.strictEqual(results[0].action, 'MONITOR');
  assert.ok(results[0].reason.includes('System RAM critical'));
  assert.ok(results[0].reason.includes('95.0%'));
});
