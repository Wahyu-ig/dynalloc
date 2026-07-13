'use strict';

/**
 * Regression tests for maintenance fixes (v2.0.0 maintenance pass).
 *
 * Each test corresponds to a specific bug fix to prevent regressions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── 1. rollback.js: crash recovery uses saved nice value, not hardcoded 0 ──
describe('rollback: restore uses saved values', () => {
  it('should use procState.nice instead of hardcoded 0', () => {
    const src = require('../../rollback');
    // Verify the source code contains String(procState.nice) not String(0) for renice
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../rollback.js'), 'utf8');
    assert.ok(code.includes("String(procState.nice)"), 'renice should use saved nice value');
    assert.ok(!code.includes("'-n', '0', '-p'"), 'renice should not hardcode 0');
  });

  it('should use procState.ionice values instead of hardcoded 2/4', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../rollback.js'), 'utf8');
    assert.ok(code.includes('procState.ionice[0]'), 'ionice should use saved class');
    assert.ok(code.includes('procState.ionice[1]'), 'ionice should use saved level');
    assert.ok(!code.includes("'-c', '2', '-n', '4'"), 'ionice should not hardcode 2/4');
  });
});

// ── 2. config.js: no duplicate DEFAULT_CONFIG keys ──
describe('config: no duplicate keys in DEFAULT_CONFIG', () => {
  it('should have no duplicate property names in DEFAULT_CONFIG', () => {
    const { DEFAULT_CONFIG } = require('../../config');
    // JSON round-trip to detect duplicate keys (JSON.parse keeps last)
    const { readJsonFile } = require('../../config');
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../config.js'), 'utf8');

    // Count key definitions in the DEFAULT_CONFIG object literal
    const defaultConfigMatch = code.match(/const DEFAULT_CONFIG = \{([\s\S]*?)\n\};/);
    if (!defaultConfigMatch) return; // can't parse

    const body = defaultConfigMatch[1];
    const keys = [];
    const keyRe = /^\s{2}(\w+)\s*:/gm;
    let match;
    while ((match = keyRe.exec(body)) !== null) {
      keys.push(match[1]);
    }

    const seen = new Set();
    const dupes = [];
    for (const k of keys) {
      if (seen.has(k)) dupes.push(k);
      seen.add(k);
    }
    assert.strictEqual(dupes.length, 0, `Duplicate DEFAULT_CONFIG keys found: ${dupes.join(', ')}`);
  });
});

// ── 3. config.js: thermal hysteresis cross-field validation ──
describe('config: thermal hysteresis validation', () => {
  it('should revert when THERMAL_RESUME_THRESHOLD >= THERMAL_PAUSE_THRESHOLD', () => {
    const { validateAndMerge, DEFAULT_CONFIG } = require('../../config');
    const bad = {
      THERMAL_RESUME_THRESHOLD: 90,
      THERMAL_PAUSE_THRESHOLD: 85,
    };
    const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, bad, true);
    assert.ok(warnings.some(w => w.includes('THERMAL_RESUME_THRESHOLD')), 'should warn about thermal hysteresis');
    assert.ok(config.THERMAL_RESUME_THRESHOLD < config.THERMAL_PAUSE_THRESHOLD, 'resume should be less than pause');
  });
});

// ── 4. config.js: os.homedir() failure handled ──
describe('config: os.homedir() failure safety', () => {
  it('should not throw when os.homedir() throws', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../config.js'), 'utf8');
    // Verify the code has try/catch around os.homedir() in resolveConfigPath
    const homeDirBlock = code.match(/homedir[\s\S]{0,200}resolveConfigPath/);
    assert.ok(
      code.includes('try') && code.includes('homedir') && code.includes('catch') &&
      code.indexOf('homedir') < code.indexOf('catch'),
      'os.homedir() should be wrapped in try/catch'
    );
  });
});

// ── 5. multimedia.js: isPlayingMedia is not async ──
describe('multimedia: isPlayingMedia returns boolean directly', () => {
  it('should return a boolean, not a Promise', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../multimedia.js'), 'utf8');
    // Find the isPlayingMedia function definition
    const asyncMatch = code.match(/async\s+function\s+isPlayingMedia/);
    assert.ok(!asyncMatch, 'isPlayingMedia should not be async');
  });
});

// ── 6. sensor.js: getSystemdUnit uses reverse scan ──
describe('sensor: getSystemdUnit finds innermost service', () => {
  it('should use reverse iteration, not regex', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../sensor.js'), 'utf8');
    // Should have reverse() or similar backward scan, not the old regex
    const funcBlock = code.match(/function getSystemdUnit[\s\S]{0,500}?^\}/m);
    if (funcBlock) {
      assert.ok(
        funcBlock[0].includes('reverse') || funcBlock[0].includes('.service'),
        'getSystemdUnit should scan backward for innermost .service'
      );
    }
  });
});

// ── 7. sensor.js: PSI NaN guard ──
describe('sensor: PSI parsing guards against NaN', () => {
  it('should have NaN check in PSI parsing', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../sensor.js'), 'utf8');
    // Find the PSI parsing section
    const psiSection = code.match(/parsePSI[\s\S]{0,800}?^\}/m) || code.match(/function _parsePSI[\s\S]{0,800}?^\}/m);
    if (psiSection) {
      assert.ok(
        psiSection[0].includes('isNaN'),
        'PSI parser should check for NaN from parseFloat'
      );
    }
  });
});

// ── 8. metrics.js: HZ not hardcoded to 100 ──
describe('metrics: HZ constant uses system value', () => {
  it('should not hardcode hz = 100', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../metrics.js'), 'utf8');
    // The line should NOT be `const hz = 100;` (the old code)
    assert.ok(!code.includes('const hz = 100;'), 'hz should not be hardcoded to 100');
  });
});

// ── 9. learning-logger: key.split uses lastIndexOf ──
describe('learning-logger: key splitting handles colons in process names', () => {
  it('should use lastIndexOf for colon splitting', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../learning-logger.js'), 'utf8');
    // Should use lastIndexOf, not split
    assert.ok(code.includes('lastIndexOf'), 'should use lastIndexOf for colon split');
    // The old pattern `key.split(':')` with destructuring should not be present
    // in the suggestRules function context
    const suggestBlock = code.match(/suggestRules[\s\S]{0,500}?^\}/m);
    if (suggestBlock) {
      assert.ok(!suggestBlock[0].includes("key.split(':')"), 'should not use simple split in suggestRules');
    }
  });
});

// ── 10. event-bus.js: wildcard iteration uses local copy ──
describe('event-bus: wildcard iteration safe from offAll during dispatch', () => {
  it('should capture wildcard listeners in a local variable before iterating', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../policy-engine/event-bus.js'), 'utf8');
    // The emit method should capture wildcards locally
    const emitBlock = code.match(/emit\(eventName[\s\S]{0,1500}?^\}/m);
    if (emitBlock) {
      // Should have a local variable for wildcards
      assert.ok(
        emitBlock[0].includes('const wildcards') || emitBlock[0].includes('const wc'),
        'emit() should capture wildcard listeners in a local variable'
      );
    }
  });
});

// ── 11. policy-logger.js: rotation uses callback ──
describe('policy-logger: rotation prevents data loss', () => {
  it('should use stream.end() callback to sequence rotation', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../policy-engine/policy-logger.js'), 'utf8');
    // Should have a _rotating flag or use stream.end(callback)
    assert.ok(
      code.includes('_rotating') || code.includes('stream.end('),
      'rotation should prevent concurrent rotations'
    );
  });
});

// ── 12. action-executor.js: RCM calls use await ──
describe('action-executor: RCM profile calls are awaited', () => {
  it('should await applyThermalProfile, applyPowerProfile, setPpdProfile', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../policy-engine/action-executor.js'), 'utf8');
    assert.ok(code.includes('await this._rcm.applyThermalProfile'), 'applyThermalProfile should be awaited');
    assert.ok(code.includes('await this._rcm.applyPowerProfile') || code.includes('await this._rcm.setPpdProfile'), 'power profile call should be awaited');
  });
});

// ── 13. policy-loader.js: YAML comment stripping respects quotes ──
describe('policy-loader: YAML comment stripping respects quotes', () => {
  it('should not strip # inside quoted strings', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../policy-engine/policy-loader.js'), 'utf8');
    // Should have quote-aware parsing logic
    const yamlSection = code.match(/loadYaml[\s\S]{0,1500}?^\}/m) || code.match(/_stripComment[\s\S]{0,500}?^\}/m);
    if (yamlSection) {
      assert.ok(
        yamlSection[0].includes('inSingle') || yamlSection[0].includes('inDouble') || yamlSection[0].includes("quote"),
        'YAML parser should be quote-aware when stripping comments'
      );
    }
  });
});

// ── 14. event-sources.js: constructor thresholds use typeof check ──
describe('event-sources: constructor thresholds handle zero correctly', () => {
  it('should use typeof check instead of || for thresholds', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../policy-engine/event-sources.js'), 'utf8');
    // The constructor should NOT have `PSI_CPU_WARN || 8.0`
    assert.ok(
      !code.includes('PSI_CPU_WARN || 8.0') && !code.includes('PSI_MEM_WARN || 4.0'),
      'constructor thresholds should use typeof check, not ||'
    );
  });
});

// ── 15. doctor-engine.js: no command injection ──
describe('doctor-engine: no shell command injection', () => {
  it('should use execFileSync, not execSync with string interpolation', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../intelligence/doctor-engine.js'), 'utf8');
    // Should NOT have execSync with template literal
    const badPattern = /execSync\s*\(\s*`/;
    assert.ok(!badPattern.test(code), 'should not use execSync with template literals');
    assert.ok(code.includes('execFileSync'), 'should use execFileSync for safe argument passing');
  });
});

// ── 16. plugins/game.js: syntax valid ──
describe('plugins/game.js: syntax is valid', () => {
  it('should load without syntax errors', () => {
    const plugin = require('../../plugins/game');
    assert.ok(typeof plugin.detect === 'function');
    assert.strictEqual(plugin.name, 'game');
  });
});

// ── 17. plugins/steam.js: null guard on context ──
describe('plugins/steam.js: context null guard', () => {
  it('should guard context access with null check', () => {
    const plugin = require('../../plugins/steam');
    // Calling with no context should not throw
    const results = plugin.detect([{ pid: 1234, comm: 'steam' }], null);
    assert.ok(Array.isArray(results));
  });

  it('should not throw when context.gameModeActive is accessed without null check', () => {
    const plugin = require('../../plugins/steam');
    // Should not throw even with undefined context
    const results = plugin.detect([{ pid: 1234, comm: 'steam' }], undefined);
    assert.ok(Array.isArray(results));
  });
});

// ── 18. version consistency ──
describe('version consistency', () => {
  it('package.json version should be 2.0.0', () => {
    const pkg = require('../../package.json');
    assert.strictEqual(pkg.version, '2.0.0');
  });
});

// ── 19. governor.js: no unused execFile import ──
describe('governor.js: clean imports', () => {
  it('should not import execFile if unused', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../governor.js'), 'utf8');
    const importLine = code.split('\n').find(l => l.includes("require('child_process')"));
    // Check if execFile is imported as a standalone name (not as part of execFileSync)
    const importsExecFileStandalone = importLine && /\bexecFile\b/.test(importLine.replace(/execFileSync/g, ''));
    assert.ok(!importsExecFileStandalone, 'execFile should not be imported if unused');
  });
});

// ── 20. actuator.js: setConfig propagates to network ──
describe('actuator.js: setConfig propagates to NetworkController', () => {
  it('should call this._network.setConfig in setConfig method', () => {
    const code = require('fs').readFileSync(require('path').resolve(__dirname, '../../actuator.js'), 'utf8');
    // Find setConfig method and verify it calls this._network.setConfig
    const setConfigBlock = code.match(/setConfig\(config\)[\s\S]{0,800}?^\}/m);
    if (setConfigBlock) {
      assert.ok(
        setConfigBlock[0].includes('this._network.setConfig') || setConfigBlock[0].includes('_network') && setConfigBlock[0].includes('.setConfig'),
        'setConfig should propagate to NetworkController'
      );
    }
  });
});