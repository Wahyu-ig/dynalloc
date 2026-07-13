'use strict';

/**
 * End-to-end test for the IPC server + CLI tool.
 *
 * Strategy:
 * 1. Start the daemon in dry-run mode as a child process.
 * 2. Wait for the IPC socket to appear.
 * 3. Run CLI commands against it and verify output.
 * 4. Stop the daemon.
 *
 * Run with: node scripts/verify-cli.js
 */

const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
const errors = [];

function ok(name) {
  console.log(`  \u2714 ${name}`);
  pass++;
}

function notOk(name, err) {
  console.log(`  \u2718 ${name}: ${err}`);
  fail++;
  errors.push({ name, err });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const DAEMON_PATH = path.join(__dirname, '..', 'dynalloc-daemon.js');
const CLI_PATH = path.join(__dirname, '..', 'dynalloc-cli.js');
const SOCKET_PATH = `/tmp/dynalloc-test-${process.pid}.sock`;

function runCli(args, env = {}) {
  const fullEnv = { ...process.env, DYNALLOC_IPC_SOCKET: SOCKET_PATH, ...env };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: fullEnv,
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(SOCKET_PATH)) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  console.log('Testing IPC server + CLI tool end-to-end...\n');

  // ── Start daemon in dry-run mode ──────────────────────────────────
  console.log('  Starting daemon (dry-run mode)...');
  const daemonEnv = {
    ...process.env,
    DYNALLOC_DRY_RUN: '1',
    DYNALLOC_LOG_LEVEL: 'fatal', // suppress logs during test
    DYNALLOC_IPC_SOCKET: SOCKET_PATH,
  };
  const daemon = spawn('node', [DAEMON_PATH], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonStderr = '';
  daemon.stderr.on('data', (chunk) => { daemonStderr += chunk.toString(); });

  try {
    // Wait for socket
    const socketReady = await waitForSocket(8000);
    if (!socketReady) {
      notOk('daemon start', 'IPC socket did not appear within 8s');
      console.log('  Daemon stderr:', daemonStderr);
      process.exit(1);
    }
    ok('daemon started, IPC socket created');

    // Give the daemon a moment more to finish bootstrap
    await sleep(500);

    // ── Test: ping ──────────────────────────────────────────────────
    {
      const r = runCli(['ping']);
      if (r.exitCode !== 0) {
        notOk('ping command', `exit ${r.exitCode}: ${r.stderr}`);
      } else if (!r.stdout.includes('pong')) {
        notOk('ping output', `expected "pong" in output, got: ${r.stdout}`);
      } else {
        ok('ping command returns "pong"');
        assert(r.stdout.includes('pid:'), 'ping should include daemon PID');
        assert(r.stdout.includes('uptime:'), 'ping should include uptime');
        ok('ping output includes daemon PID and uptime');
      }
    }

    // ── Test: status ────────────────────────────────────────────────
    {
      const r = runCli(['status']);
      if (r.exitCode !== 0) {
        notOk('status command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('DynAlloc Status'), 'status header missing');
        assert(r.stdout.includes('Stress Level:'), 'stress level missing');
        assert(r.stdout.includes('Foreground PID:'), 'foreground PID missing');
        assert(r.stdout.includes('Plugins:'), 'plugins missing');
        ok('status command returns formatted state');
      }
    }

    // ── Test: status --json ─────────────────────────────────────────
    {
      const r = runCli(['status', '--json']);
      if (r.exitCode !== 0) {
        notOk('status --json', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        let parsed;
        try {
          parsed = JSON.parse(r.stdout);
        } catch (err) {
          notOk('status --json', `invalid JSON: ${err.message}`);
          throw new Error('stop');
        }
        assert(typeof parsed.stressLevel === 'string', 'stressLevel missing');
        assert(typeof parsed.throttledCount === 'number', 'throttledCount missing');
        assert(Array.isArray(parsed.plugins), 'plugins not array');
        ok('status --json returns valid JSON');
      }
    }

    // ── Test: stats ─────────────────────────────────────────────────
    {
      const r = runCli(['stats']);
      if (r.exitCode !== 0) {
        notOk('stats command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('report') || r.stdout.includes('Uptime') || r.stdout.length > 0,
          'stats output empty');
        ok('stats command returns metrics');
      }
    }

    // ── Test: metrics ───────────────────────────────────────────────
    {
      const r = runCli(['metrics', '--json']);
      if (r.exitCode !== 0) {
        notOk('metrics --json', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        let parsed;
        try { parsed = JSON.parse(r.stdout); }
        catch (err) { notOk('metrics --json', `invalid JSON: ${err.message}`); throw new Error('stop'); }
        assert(typeof parsed === 'object', 'metrics should be object');
        ok('metrics --json returns valid metrics object');
      }
    }

    // ── Test: throttled ─────────────────────────────────────────────
    {
      const r = runCli(['throttled']);
      if (r.exitCode !== 0) {
        notOk('throttled command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        // Empty throttled list is OK
        assert(r.stdout.includes('throttl') || r.stdout.includes('process'),
          'throttled output unexpected');
        ok('throttled command runs');
      }
    }

    // ── Test: boost (dry-run, so it won't actually modify the process) ─
    // Use the daemon's own PID as a safe target (it's alive but we're in DRY_RUN)
    {
      const r = runCli(['boost', String(process.pid)]);
      // In dry-run, the actuator returns success without executing
      if (r.exitCode !== 0) {
        notOk('boost command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('Boosted') || r.stdout.includes('PID'),
          'boost output unexpected');
        ok('boost command boosts a PID');
      }
    }

    // ── Test: boost invalid PID ─────────────────────────────────────
    {
      const r = runCli(['boost', '999999']); // PID that doesn't exist
      if (r.exitCode === 0) {
        // In dry-run mode the daemon may not check liveness — accept either
        ok('boost nonexistent PID returns (dry-run allows it)');
      } else {
        assert(r.stderr.includes('not running') || r.stderr.includes('Error'),
          'expected error for nonexistent PID');
        ok('boost nonexistent PID returns error');
      }
    }

    // ── Test: boost missing PID argument ────────────────────────────
    {
      const r = runCli(['boost']);
      assert(r.exitCode === 3, `expected exit 3 for missing arg, got ${r.exitCode}`);
      assert(r.stderr.includes('PID'), 'expected error mentioning PID');
      ok('boost without PID exits with code 3');
    }

    // ── Test: throttle ──────────────────────────────────────────────
    {
      const r = runCli(['throttle', String(process.pid)]);
      if (r.exitCode !== 0) {
        notOk('throttle command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('Throttled') || r.stdout.includes('PID'),
          'throttle output unexpected');
        ok('throttle command throttles a PID');
      }
    }

    // ── Test: restore ───────────────────────────────────────────────
    {
      const r = runCli(['restore', String(process.pid)]);
      if (r.exitCode !== 0) {
        notOk('restore command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('Restored') || r.stdout.includes('PID'),
          'restore output unexpected');
        ok('restore command restores a PID');
      }
    }

    // ── Test: doctor ────────────────────────────────────────────────
    {
      const r = runCli(['doctor']);
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        // exit 1 is OK if doctor finds issues; exit 0 if all healthy
        notOk('doctor command', `exit ${r.exitCode}: ${r.stderr}`);
      } else {
        assert(r.stdout.includes('DynAlloc Doctor'), 'doctor header missing');
        assert(r.stdout.includes('Daemon:') || r.stdout.includes('running'),
          'doctor should mention daemon status');
        assert(r.stdout.includes('PSI'), 'doctor should check PSI');
        assert(r.stdout.includes('Cgroups'), 'doctor should check cgroups');
        ok('doctor command runs full diagnostics');
      }
    }

    // ── Test: unknown command ───────────────────────────────────────
    {
      const r = runCli(['bogus-command']);
      assert(r.exitCode === 3, `expected exit 3 for unknown cmd, got ${r.exitCode}`);
      assert(r.stderr.includes('Unknown command'), 'expected unknown command error');
      ok('unknown command exits with code 3');
    }

    // ── Test: help ──────────────────────────────────────────────────
    {
      const r = runCli(['help']);
      assert(r.exitCode === 0, `help should exit 0, got ${r.exitCode}`);
      assert(r.stdout.includes('Usage:'), 'help should show Usage');
      assert(r.stdout.includes('Commands:'), 'help should list commands');
      assert(r.stdout.includes('status'), 'help should mention status');
      assert(r.stdout.includes('boost'), 'help should mention boost');
      assert(r.stdout.includes('doctor'), 'help should mention doctor');
      ok('help command shows usage');
    }

    // ── Test: --version ─────────────────────────────────────────────
    {
      const r = runCli(['--version']);
      assert(r.exitCode === 0);
      assert(r.stdout.includes('0.2'), 'version should include 0.2.x');
      ok('--version shows version');
    }

    // ── Test: no args → help ────────────────────────────────────────
    {
      const r = runCli([]);
      assert(r.exitCode === 0);
      assert(r.stdout.includes('Usage:'), 'no-args should show help');
      ok('no args shows help');
    }

  } catch (err) {
    if (err.message !== 'stop') {
      console.log(`  \u2718 unexpected error: ${err.message}`);
      console.log(err.stack);
    }
  } finally {
    // Cleanup: kill daemon
    try { daemon.kill('SIGTERM'); } catch (_) { /* noop */ }
    await sleep(500);
    try { daemon.kill('SIGKILL'); } catch (_) { /* noop */ }
    try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (_) { /* noop */ }
  }

  // ── Test: CLI handles daemon-not-running gracefully ─────────────────
  {
    // Socket file deleted above, so CLI should fail with exit 2
    const r = runCli(['ping']);
    if (r.exitCode === 2) {
      assert(r.stderr.includes('cannot connect') || r.stderr.includes('daemon'),
        'expected helpful connection error');
      ok('CLI handles daemon-not-running with exit code 2 + helpful message');
    } else {
      notOk('daemon-not-running', `expected exit 2, got ${r.exitCode}: ${r.stderr}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  CLI/IPC tests: ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
