# Testing

## Test Structure

DynAlloc is designed for testability at the module level. Each module exports its classes and functions, making them independently testable without spawning the full daemon.

```
dynalloc/
├── config.js          # Pure logic: validation, merging, path resolution
├── classifier.js      # Pure logic: regex matching, caching
├── scheduler.js       # Core logic: hysteresis, scoring, classification
├── sensor.js          # I/O: PSI reading, process listing, external commands
├── actuator.js        # I/O: system command execution
├── governor.js        # I/O: cpufreq sysfs, cpupower command
├── multimedia.js      # I/O: PipeWire, PulseAudio detection
├── cpu-topology.js    # I/O: sysfs reading
├── metrics.js         # Pure logic: counters, gauges, histograms
├── plugin-manager.js  # Logic: plugin lifecycle management
├── self-check.js      # I/O: system capability detection
├── rollback.js        # I/O: file persistence, process restoration
├── logger.js          # Side-effect: console and file output
└── daemon.js          # Integration: orchestrates all modules
```

## Running Unit Tests

```bash
# Node.js built-in test runner:
node --test test/

# With verbose output:
node --test --test-reporter spec test/

# Run a specific test file:
node --test test/unit/test-all.js
```

## Running Integration Tests

Integration tests validate module interactions and require a Linux environment with PSI support. They may perform actual system calls.

```bash
# Run all tests (unit + integration):
node --test test/

# Run only integration tests:
node --test test/integration/
```

Integration tests should:
- Use `DYNALLOC_DRY_RUN=1` to prevent real system modifications.
- Check for PSI availability before running PSI-dependent tests.
- Check for cgroups availability before running cgroup-dependent tests.
- Clean up any created files or cgroups in `afterEach()` / `after()`.

## Running Benchmarks

```bash
# Enable benchmark mode in config or env:
ENABLE_BENCHMARK=1 DYNALLOC_DRY_RUN=1 DYNALLOC_LOG_LEVEL=info node dynalloc-daemon.js
```

The daemon will log additional timing data. Access the metrics report programmatically if needed (via the `getState()` / `getMetricsReport()` API).

## Coverage Targets

| Module | Target Coverage | Notes |
|---|---|---|
| `config.js` | > 95% | Pure validation logic — fully testable. |
| `classifier.js` | > 90% | Regex patterns + cache logic. |
| `scheduler.js` | > 90% | Hysteresis, scoring, classification — mock sensor data. |
| `metrics.js` | > 95% | Pure data structures. |
| `plugin-manager.js` | > 85% | Registration, lifecycle, detection aggregation. |
| `sensor.js` | > 70% | I/O bound — mock file reads and child_process. |
| `actuator.js` | > 70% | I/O bound — test dry-run mode (no real system calls). |
| `multimedia.js` | > 60% | Heavy I/O — mock pw-cli/pactl/pgrep. |
| `cpu-topology.js` | > 60% | Sysfs dependent — mock fs reads. |
| `governor.js` | > 60% | Sysfs + cpupower — test dry-run. |
| `self-check.js` | > 50% | System probes — mock fs and execFileSync. |
| `rollback.js` | > 70% | File I/O — test with temp directory. |
| `logger.js` | > 80% | Capture console output for assertions. |
| `daemon.js` | > 50% | Integration — mock all subsystems. |

## Writing Tests

### Example: Config Validation Test

```javascript
const assert = require('node:assert/strict');
const { validateAndMerge, DEFAULT_CONFIG } = require('../config');

// Test: invalid PSI thresholds fall back to defaults
const result = validateAndMerge(DEFAULT_CONFIG, {
  PSI_CPU_WARN: 50,
  PSI_CPU_CRITICAL: 10,  // WARN > CRITICAL — should revert
}, false);

assert.strictEqual(result.config.PSI_CPU_WARN, DEFAULT_CONFIG.PSI_CPU_WARN);
assert.strictEqual(result.config.PSI_CPU_CRITICAL, DEFAULT_CONFIG.PSI_CPU_CRITICAL);
assert.strictEqual(result.warnings.length, 1);
```

### Example: Scheduler Hysteresis Test

```javascript
const assert = require('node:assert/strict');
const { HysteresisState } = require('../scheduler');

const config = {
  ENABLE_HYSTERESIS: true,
  HYSTERESIS_NORMAL_TO_WARN_MS: 100,
  HYSTERESIS_WARN_TO_CRITICAL_MS: 100,
  HYSTERESIS_CRITICAL_TO_NORMAL_MS: 200,
};

const h = new HysteresisState();

// First transition: immediate (no pending)
let r = h.evaluate('WARN', config);
assert.strictEqual(r.level, 'NORMAL');  // Not enough time
assert.strictEqual(r.changed, false);

// Wait for dwell time
await new Promise(resolve => setTimeout(resolve, 150));
r = h.evaluate('WARN', config);
assert.strictEqual(r.level, 'WARN');
assert.strictEqual(r.changed, true);
```

### Example: Classifier Test

```javascript
const assert = require('node:assert/strict');
const { classifyByComm, categoryToSchedulerClass } = require('../classifier');

assert.strictEqual(classifyByComm('systemd'), 'SYSTEM');
assert.strictEqual(classifyByComm('firefox'), 'BROWSER');
assert.strictEqual(classifyByComm('unknown_binary'), 'UNKNOWN');
assert.strictEqual(categoryToSchedulerClass('SYSTEM'), 'REALTIME');
assert.strictEqual(categoryToSchedulerClass('VIDEO'), 'MULTIMEDIA');
assert.strictEqual(categoryToSchedulerClass('COMPILER'), 'BACKGROUND');
```

### Example: Actuator Dry-Run Test

```javascript
const assert = require('node:assert/strict');
const Actuator = require('../actuator');

const config = { ...require('../config').DEFAULT_CONFIG, DRY_RUN: true };
const actuator = new Actuator(config);

// Dry-run should not actually execute anything
const result = actuator.pinToCores(1, [0, 1, 2]);
assert.strictEqual(result, true);

// Verify modification was logged
const log = actuator.getModificationLog();
assert.strictEqual(log.length, 1);
assert.strictEqual(log[0].action, 'taskset');
```

### Testing Modules with I/O

For modules that read from the filesystem or spawn processes, use Node.js test runner's mocking capabilities or inject dependencies:

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const mock = require('node:test').mock;

// Mock fs.readFileSync for sensor tests
test('readCpuPSI returns parsed data', () => {
  // Use dependency injection or module mocking
  // to provide fake /proc/pressure/cpu content
});
```

## Test Categories

### Pure Logic (No I/O, Fast)

These can run on any platform, including CI:

- `config.js` — validation, merging, cross-field checks
- `classifier.js` — pattern matching, caching, category mapping
- `scheduler.js` — hysteresis, adaptive scoring, process classification (with mock data)
- `metrics.js` — counter, gauge, histogram operations
- `plugin-manager.js` — registration, dedup, detection aggregation (with mock plugins)

### I/O Bound (Requires Linux, May Need Permissions)

These need a Linux environment and may require specific system features:

- `sensor.js` — PSI reading, process listing, foreground detection
- `actuator.js` — dry-run mode testing (no real changes)
- `governor.js` — dry-run mode testing
- `cpu-topology.js` — sysfs reading (varies by CPU)
- `multimedia.js` — PipeWire/PulseAudio detection
- `self-check.js` — capability detection
- `rollback.js` — file persistence

### Integration (Full Daemon)

Tests the `daemon.js` orchestrator with all subsystems (mocked or real). These are the most comprehensive but also the slowest and most environment-dependent. Always use `DYNALLOC_DRY_RUN=1`.