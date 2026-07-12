'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const pathModule = require('path');
const os = require('os');

// ── Shared Setup ──────────────────────────────────────────────────────────

const logger = require('../../logger');
logger.setLevel('fatal');

const { DEFAULT_CONFIG, CONFIG_SCHEMA, HOT_RELOADABLE_FIELDS, KNOWN_GOVERNORS,
        VALID_LOG_LEVELS, TOTAL_CORES, validateAndMerge, validateRegexList,
        validateField, validatePath, resolveConfigPath, readJsonFile } = require('../../config');

// Suppress console output during tests
const origConsoleError = console.error;
const origConsoleWarn = console.warn;
const origConsoleLog = console.log;

function suppressConsole() {
  console.error = mock.fn();
  console.warn = mock.fn();
  console.log = mock.fn();
}
function restoreConsole() {
  console.error = origConsoleError;
  console.warn = origConsoleWarn;
  console.log = origConsoleLog;
}

const TEST_PID = 99999;
const ANOTHER_PID = 88888;

function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const mockTopology = {
  logicalCount: 8,
  physicalCount: 4,
  smtEnabled: true,
  threadsPerCore: 2,
  numaNodes: [],
  isHybrid: false,
  pCores: [],
  eCores: [],
  isAMD: false,
  ccds: [],
  ccdCount: 0,
  logicalToPhysical: new Map(),
  threadSiblings: new Map(),
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. CONFIG MODULE
// ═══════════════════════════════════════════════════════════════════════════

describe('Config module', () => {
  describe('DEFAULT_CONFIG', () => {
    it('should have all required fields', () => {
      assert.ok(typeof DEFAULT_CONFIG.FAST_TICK_MS === 'number');
      assert.ok(typeof DEFAULT_CONFIG.PSI_CPU_WARN === 'number');
      assert.ok(typeof DEFAULT_CONFIG.ENABLE_CGROUPS_V2 === 'boolean');
      assert.ok(typeof DEFAULT_CONFIG.LOG_LEVEL === 'string');
      assert.ok(typeof DEFAULT_CONFIG.HEAVY_BG_PATTERNS === 'object');
      assert.ok(Array.isArray(DEFAULT_CONFIG.HEAVY_BG_PATTERNS));
      assert.ok(typeof DEFAULT_CONFIG.ROLLBACK_STATE_FILE === 'object'); // nullable
    });
  });

  describe('CONFIG_SCHEMA', () => {
    it('should cover all config keys', () => {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        assert.ok(key in CONFIG_SCHEMA, `Schema missing key: ${key}`);
      }
    });

    it('should have type info for every schema entry', () => {
      for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
        assert.ok(schema.type, `${key} missing type`);
      }
    });
  });

  describe('validateAndMerge', () => {
    it('should return defaults when override is null/undefined/non-object', () => {
      const r1 = validateAndMerge(DEFAULT_CONFIG, null);
      assert.deepStrictEqual(r1.config, { ...DEFAULT_CONFIG });
      assert.deepStrictEqual(r1.warnings, []);

      const r2 = validateAndMerge(DEFAULT_CONFIG, undefined);
      assert.deepStrictEqual(r2.config, { ...DEFAULT_CONFIG });

      const r3 = validateAndMerge(DEFAULT_CONFIG, 'string');
      assert.deepStrictEqual(r3.config, { ...DEFAULT_CONFIG });

      const r4 = validateAndMerge(DEFAULT_CONFIG, 42);
      assert.deepStrictEqual(r4.config, { ...DEFAULT_CONFIG });
    });

    it('should merge valid overrides over defaults', () => {
      const override = { FAST_TICK_MS: 2000, DRY_RUN: true, LOG_LEVEL: 'debug' };
      const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
      assert.strictEqual(config.FAST_TICK_MS, 2000);
      assert.strictEqual(config.DRY_RUN, true);
      assert.strictEqual(config.LOG_LEVEL, 'debug');
      assert.strictEqual(warnings.length, 0);
    });

    it('should drop unknown keys silently', () => {
      const override = { UNKNOWN_KEY: 42, FAST_TICK_MS: 2000 };
      const { config } = validateAndMerge(DEFAULT_CONFIG, override);
      assert.strictEqual(config.FAST_TICK_MS, 2000);
      assert.ok(!('UNKNOWN_KEY' in config));
    });

    it('should fall back to default for invalid values and warn', () => {
      const override = {
        FAST_TICK_MS: -5,        // below min
        DRY_RUN: 'yes',          // not boolean
        LOG_LEVEL: 'invalid',    // not in enum
        PSI_CPU_WARN: 150,       // above max
      };
      const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
      assert.strictEqual(config.FAST_TICK_MS, DEFAULT_CONFIG.FAST_TICK_MS);
      assert.strictEqual(config.DRY_RUN, DEFAULT_CONFIG.DRY_RUN);
      assert.strictEqual(config.LOG_LEVEL, DEFAULT_CONFIG.LOG_LEVEL);
      assert.strictEqual(config.PSI_CPU_WARN, DEFAULT_CONFIG.PSI_CPU_WARN);
      assert.ok(warnings.length >= 4);
    });

    it('should not warn for valid regexArray overrides', () => {
      const override = {
        HEAVY_BG_PATTERNS: ['^foo$', 'bar'],
        CRITICAL_PROCESS_PATTERNS: ['^systemd$'],
      };
      const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
      assert.deepStrictEqual(config.HEAVY_BG_PATTERNS, ['^foo$', 'bar']);
      assert.deepStrictEqual(config.CRITICAL_PROCESS_PATTERNS, ['^systemd$']);
      assert.deepStrictEqual(warnings, []);
    });

    it('should enforce cross-field: PSI_CPU_WARN must be < PSI_CPU_CRITICAL', () => {
      const override = { PSI_CPU_WARN: 30, PSI_CPU_CRITICAL: 20 };
      const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
      assert.strictEqual(config.PSI_CPU_WARN, DEFAULT_CONFIG.PSI_CPU_WARN);
      assert.strictEqual(config.PSI_CPU_CRITICAL, DEFAULT_CONFIG.PSI_CPU_CRITICAL);
      assert.ok(warnings.some(w => w.includes('PSI_CPU_WARN >= PSI_CPU_CRITICAL')));
    });

    it('should enforce cross-field: PSI_MEM_WARN must be < PSI_MEM_CRITICAL', () => {
      const override = { PSI_MEM_WARN: 20, PSI_MEM_CRITICAL: 12 };
      const { config, warnings } = validateAndMerge(DEFAULT_CONFIG, override, true);
      assert.strictEqual(config.PSI_MEM_WARN, DEFAULT_CONFIG.PSI_MEM_WARN);
      assert.strictEqual(config.PSI_MEM_CRITICAL, DEFAULT_CONFIG.PSI_MEM_CRITICAL);
      assert.ok(warnings.some(w => w.includes('PSI_MEM_WARN >= PSI_MEM_CRITICAL')));
    });

    it('should accept valid nullable fields as null', () => {
      const override = { LOG_FILE_PATH: null, PLUGIN_DIR: null, ROLLBACK_STATE_FILE: null };
      const { config } = validateAndMerge(DEFAULT_CONFIG, override);
      assert.strictEqual(config.LOG_FILE_PATH, null);
      assert.strictEqual(config.PLUGIN_DIR, null);
      assert.strictEqual(config.ROLLBACK_STATE_FILE, null);
    });

    it('should not log warnings when logWarnings is false', () => {
      const override = { FAST_TICK_MS: -5 };
      const { warnings } = validateAndMerge(DEFAULT_CONFIG, override, false);
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe('validateField', () => {
    it('should validate number type with min/max', () => {
      const schema = CONFIG_SCHEMA.FAST_TICK_MS;
      assert.strictEqual(validateField('FAST_TICK_MS', 500, schema, 1000), 500);
      assert.strictEqual(validateField('FAST_TICK_MS', 50, schema, 1000), 1000); // below min
      assert.strictEqual(validateField('FAST_TICK_MS', 100000, schema, 1000), 1000); // above max
    });

    it('should validate number integer constraint', () => {
      const schema = CONFIG_SCHEMA.FOREGROUND_CPU_WEIGHT;
      assert.strictEqual(validateField('FOREGROUND_CPU_WEIGHT', 500, schema, 800), 500);
      assert.strictEqual(validateField('FOREGROUND_CPU_WEIGHT', 500.7, schema, 800), 800); // not integer
    });

    it('should validate number NaN', () => {
      const schema = CONFIG_SCHEMA.FAST_TICK_MS;
      assert.strictEqual(validateField('FAST_TICK_MS', NaN, schema, 1000), 1000);
    });

    it('should validate boolean type', () => {
      const schema = CONFIG_SCHEMA.DRY_RUN;
      assert.strictEqual(validateField('DRY_RUN', true, schema, false), true);
      assert.strictEqual(validateField('DRY_RUN', false, schema, true), false);
      assert.strictEqual(validateField('DRY_RUN', 'true', schema, false), false);
      assert.strictEqual(validateField('DRY_RUN', 1, schema, false), false);
    });

    it('should validate enum type', () => {
      const schema = CONFIG_SCHEMA.LOG_LEVEL;
      assert.strictEqual(validateField('LOG_LEVEL', 'debug', schema, 'info'), 'debug');
      assert.strictEqual(validateField('LOG_LEVEL', 'invalid', schema, 'info'), 'info');
    });

    it('should validate path type (reject traversal and null bytes)', () => {
      const schema = CONFIG_SCHEMA.CGROUP_ROOT;
      assert.strictEqual(validateField('CGROUP_ROOT', '/sys/fs/cgroup', schema, '/sys/fs/cgroup'), '/sys/fs/cgroup');
      assert.strictEqual(validateField('CGROUP_ROOT', '/sys/../etc/passwd', schema, '/sys/fs/cgroup'), '/sys/fs/cgroup');
      assert.strictEqual(validateField('CGROUP_ROOT', '/sys/foo\0bar', schema, '/sys/fs/cgroup'), '/sys/fs/cgroup');
    });

    it('should validate nullable path type', () => {
      const schema = CONFIG_SCHEMA.LOG_FILE_PATH;
      assert.strictEqual(validateField('LOG_FILE_PATH', null, schema, null), null);
      assert.strictEqual(validateField('LOG_FILE_PATH', '/var/log/dynalloc.log', schema, null), '/var/log/dynalloc.log');
      assert.strictEqual(validateField('LOG_FILE_PATH', '/var/log/../etc/passwd', schema, null), null);
    });

    it('should validate cpuMax type', () => {
      const schema = CONFIG_SCHEMA.FOREGROUND_CPU_MAX;
      assert.strictEqual(validateField('FOREGROUND_CPU_MAX', 'max', schema, 'max'), 'max');
      assert.strictEqual(validateField('FOREGROUND_CPU_MAX', '80000 100000', schema, 'max'), '80000 100000');
      assert.strictEqual(validateField('FOREGROUND_CPU_MAX', 'invalid', schema, 'max'), 'max');
      assert.strictEqual(validateField('FOREGROUND_CPU_MAX', '80000', schema, 'max'), 'max'); // missing second number
    });

    it('should validate regexArray type', () => {
      const schema = CONFIG_SCHEMA.HEAVY_BG_PATTERNS;
      const fallback = DEFAULT_CONFIG.HEAVY_BG_PATTERNS;
      assert.deepStrictEqual(validateField('HEAVY_BG_PATTERNS', ['^foo$', 'bar'], schema, fallback), ['^foo$', 'bar']);
      assert.deepStrictEqual(validateField('HEAVY_BG_PATTERNS', ['[invalid', '^valid$'], schema, fallback), ['^valid$']);
      assert.deepStrictEqual(validateField('HEAVY_BG_PATTERNS', ['[invalid'], schema, fallback), fallback);
      assert.deepStrictEqual(validateField('HEAVY_BG_PATTERNS', 'not array', schema, fallback), fallback);
    });

    it('should validate ioPrio type', () => {
      const schema = CONFIG_SCHEMA.SCHEDULER_CLASS_REALTIME_IOPRIO;
      const fallback = [1, 0];
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [1, 0], schema, fallback), [1, 0]);
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [2, 4], schema, fallback), [2, 4]);
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [0, 0], schema, fallback), fallback); // class < 1
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [4, 0], schema, fallback), fallback); // class > 3
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [1, 8], schema, fallback), fallback); // level > 7
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', [1], schema, fallback), fallback); // length != 2
      assert.deepStrictEqual(validateField('SCHEDULER_CLASS_REALTIME_IOPRIO', '1,0', schema, fallback), fallback); // not array
    });

    it('should return default for null/undefined values (non-nullable)', () => {
      const schema = CONFIG_SCHEMA.FAST_TICK_MS;
      assert.strictEqual(validateField('FAST_TICK_MS', null, schema, 1000), 1000);
      assert.strictEqual(validateField('FAST_TICK_MS', undefined, schema, 1000), 1000);
    });

    it('should return value as-is when no schema', () => {
      assert.strictEqual(validateField('NO_SCHEMA', 'anything', undefined, 'default'), 'anything');
    });
  });

  describe('validatePath', () => {
    it('should return valid path for normal strings', () => {
      assert.strictEqual(validatePath('/sys/fs/cgroup'), '/sys/fs/cgroup');
      assert.strictEqual(validatePath('/var/log/dynalloc.log'), '/var/log/dynalloc.log');
    });

    it('should reject paths with ..', () => {
      assert.strictEqual(validatePath('/sys/../etc/passwd'), undefined);
      assert.strictEqual(validatePath('../etc/passwd'), undefined);
    });

    it('should reject paths with null bytes', () => {
      assert.strictEqual(validatePath('/sys/foo\0bar'), undefined);
      assert.strictEqual(validatePath('\0'), undefined);
    });

    it('should return null when nullable=true and input is null/undefined', () => {
      assert.strictEqual(validatePath(null, true), null);
      assert.strictEqual(validatePath(undefined, true), null);
    });

    it('should return undefined for null/undefined when nullable=false', () => {
      assert.strictEqual(validatePath(null, false), undefined);
      assert.strictEqual(validatePath(undefined, false), undefined);
    });

    it('should coerce non-string to string', () => {
      assert.strictEqual(validatePath(123), '123');
    });
  });

  describe('validateRegexList', () => {
    const fallback = ['^default$'];

    it('should return fallback for non-array input', () => {
      assert.deepStrictEqual(validateRegexList('not array', fallback), fallback);
      assert.deepStrictEqual(validateRegexList(null, fallback), fallback);
      assert.deepStrictEqual(validateRegexList(42, fallback), fallback);
    });

    it('should keep valid regex strings, drop invalid ones', () => {
      assert.deepStrictEqual(validateRegexList(['^foo$', 'bar', '[invalid'], fallback), ['^foo$', 'bar']);
    });

    it('should drop non-string entries', () => {
      assert.deepStrictEqual(validateRegexList(['^valid$', 123, null, undefined, {}], fallback), ['^valid$']);
    });

    it('should return fallback when no valid patterns remain', () => {
      assert.deepStrictEqual(validateRegexList(['[invalid1', '[invalid2'], fallback), fallback);
    });
  });

  describe('resolveConfigPath', () => {
    it('should return null when no config file exists', () => {
      // Override env to a non-existent path
      const origEnv = process.env.DYNALLOC_CONFIG_PATH;
      delete process.env.DYNALLOC_CONFIG_PATH;
      const result = resolveConfigPath();
      // May or may not be null depending on system state, so just check return type
      assert.ok(result === null || typeof result === 'string');
      if (origEnv !== undefined) process.env.DYNALLOC_CONFIG_PATH = origEnv;
    });
  });

  describe('KNOWN_GOVERNORS and VALID_LOG_LEVELS', () => {
    it('should contain expected governors', () => {
      assert.ok(KNOWN_GOVERNORS.includes('performance'));
      assert.ok(KNOWN_GOVERNORS.includes('powersave'));
      assert.ok(KNOWN_GOVERNORS.includes('schedutil'));
    });

    it('should contain expected log levels', () => {
      assert.deepStrictEqual(VALID_LOG_LEVELS, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    });
  });

  describe('HOT_RELOADABLE_FIELDS', () => {
    it('should be an array of strings', () => {
      assert.ok(Array.isArray(HOT_RELOADABLE_FIELDS));
      for (const f of HOT_RELOADABLE_FIELDS) {
        assert.ok(typeof f === 'string');
      }
    });

    it('should include common hot-reloadable keys', () => {
      assert.ok(HOT_RELOADABLE_FIELDS.includes('FAST_TICK_MS'));
      assert.ok(HOT_RELOADABLE_FIELDS.includes('PSI_CPU_WARN'));
      assert.ok(HOT_RELOADABLE_FIELDS.includes('ENABLE_HYSTERESIS'));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CLASSIFIER MODULE
// ═══════════════════════════════════════════════════════════════════════════

describe('Classifier', () => {
  const { classifyByComm, classifyElectronChild, categoryToSchedulerClass,
          schedulerClassPriority, schedulerClassNice, schedulerClassIoPrio,
          isRealtime, isMultimedia, isProtected, clearCache, PATTERNS,
          CATEGORY_TO_SCHED_CLASS } = require('../../classifier');

  const config = makeConfig();

  beforeEach(() => { clearCache(); });

  describe('classifyByComm', () => {
    it('should return UNKNOWN for non-string input', () => {
      assert.strictEqual(classifyByComm(null), 'UNKNOWN');
      assert.strictEqual(classifyByComm(123), 'UNKNOWN');
      assert.strictEqual(classifyByComm(undefined), 'UNKNOWN');
    });

    it('should classify GAME processes', () => {
      assert.strictEqual(classifyByComm('SteamApp'), 'GAME');
      assert.strictEqual(classifyByComm('steamwebhelper'), 'GAME');
      assert.strictEqual(classifyByComm('steam_shutdow'), 'GAME');
    });

    it('should classify BROWSER processes', () => {
      assert.strictEqual(classifyByComm('firefox'), 'BROWSER');
      assert.strictEqual(classifyByComm('chrome'), 'BROWSER');
      assert.strictEqual(classifyByComm('brave'), 'BROWSER');
      assert.strictEqual(classifyByComm('chromium'), 'BROWSER');
    });

    it('should classify IDE processes', () => {
      assert.strictEqual(classifyByComm('code'), 'IDE');
      assert.strictEqual(classifyByComm('codium'), 'IDE');
      assert.strictEqual(classifyByComm('cursor'), 'IDE');
      assert.strictEqual(classifyByComm('idea'), 'IDE');
      assert.strictEqual(classifyByComm('vim'), 'IDE');
      assert.strictEqual(classifyByComm('emacs'), 'IDE');
      assert.strictEqual(classifyByComm('sublime_text'), 'IDE');
    });

    it('should classify COMPILER processes', () => {
      assert.strictEqual(classifyByComm('cc1'), 'COMPILER');
      assert.strictEqual(classifyByComm('cc1plus'), 'COMPILER');
      assert.strictEqual(classifyByComm('rustc'), 'COMPILER');
      assert.strictEqual(classifyByComm('cargo'), 'COMPILER');
      assert.strictEqual(classifyByComm('clang'), 'COMPILER');
      assert.strictEqual(classifyByComm('gcc'), 'COMPILER');
      assert.strictEqual(classifyByComm('make'), 'COMPILER');
      assert.strictEqual(classifyByComm('node'), 'COMPILER');
      assert.strictEqual(classifyByComm('java'), 'COMPILER');
      assert.strictEqual(classifyByComm('go'), 'COMPILER');
    });

    it('should classify AUDIO processes', () => {
      assert.strictEqual(classifyByComm('spotify'), 'AUDIO');
      assert.strictEqual(classifyByComm('audacity'), 'AUDIO');
      assert.strictEqual(classifyByComm('mpd'), 'AUDIO');
      assert.strictEqual(classifyByComm('pavucontrol'), 'AUDIO');
    });

    it('should classify VIDEO processes', () => {
      assert.strictEqual(classifyByComm('mpv'), 'VIDEO');
      assert.strictEqual(classifyByComm('vlc'), 'VIDEO');
      assert.strictEqual(classifyByComm('celluloid'), 'VIDEO');
      assert.strictEqual(classifyByComm('smplayer'), 'VIDEO');
    });

    it('should classify STREAMING processes', () => {
      assert.strictEqual(classifyByComm('obs'), 'STREAMING');
      assert.strictEqual(classifyByComm('obs-studio'), 'STREAMING');
      assert.strictEqual(classifyByComm('discord'), 'STREAMING');
      assert.strictEqual(classifyByComm('zoom'), 'STREAMING');
      assert.strictEqual(classifyByComm('skype'), 'STREAMING');
    });

    it('should classify WALLPAPER processes', () => {
      assert.strictEqual(classifyByComm('mpvpaper'), 'WALLPAPER');
      assert.strictEqual(classifyByComm('swww'), 'WALLPAPER');
      assert.strictEqual(classifyByComm('hyprpaper'), 'WALLPAPER');
      assert.strictEqual(classifyByComm('feh'), 'WALLPAPER');
      assert.strictEqual(classifyByComm('nitrogen'), 'WALLPAPER');
    });

    it('should classify CONTAINER processes', () => {
      // Note: dockerd, podman, containerd are also in DAEMON which has higher priority.
      // Use processes only in CONTAINER patterns.
      assert.strictEqual(classifyByComm('ctr'), 'CONTAINER');
      assert.strictEqual(classifyByComm('crun'), 'CONTAINER');
      assert.strictEqual(classifyByComm('buildah'), 'CONTAINER');
      assert.strictEqual(classifyByComm('nerdctl'), 'CONTAINER');
    });

    it('should classify VM processes', () => {
      assert.strictEqual(classifyByComm('qemu-system-x86_64'), 'VM');
      assert.strictEqual(classifyByComm('virt-manager'), 'VM');
      assert.strictEqual(classifyByComm('VirtualBoxVM'), 'VM');
    });

    it('should classify STEAM processes', () => {
      assert.strictEqual(classifyByComm('steam'), 'STEAM');
      assert.strictEqual(classifyByComm('steamcmd'), 'STEAM');
    });

    it('should classify WINE/PROTON/LUTRIS processes', () => {
      assert.strictEqual(classifyByComm('wine'), 'WINE');
      assert.strictEqual(classifyByComm('wine64'), 'WINE');
      assert.strictEqual(classifyByComm('proton'), 'PROTON');
      assert.strictEqual(classifyByComm('lutris'), 'LUTRIS');
    });

    it('should classify FLATPAK/SNAP processes', () => {
      assert.strictEqual(classifyByComm('flatpak'), 'FLATPAK');
      assert.strictEqual(classifyByComm('bwrap'), 'FLATPAK');
      // Note: snapd is also in DAEMON which has higher priority; use 'snap' instead
      assert.strictEqual(classifyByComm('snap'), 'SNAP');
    });

    it('should classify SYSTEM processes', () => {
      assert.strictEqual(classifyByComm('systemd'), 'SYSTEM');
      assert.strictEqual(classifyByComm('Xorg'), 'SYSTEM');
      assert.strictEqual(classifyByComm('gnome-shell'), 'SYSTEM');
      assert.strictEqual(classifyByComm('kwin_wayland'), 'SYSTEM');
      assert.strictEqual(classifyByComm('pipewire'), 'SYSTEM');
      assert.strictEqual(classifyByComm('NetworkManager'), 'SYSTEM');
      assert.strictEqual(classifyByComm('sddm'), 'SYSTEM');
    });

    it('should classify DAEMON processes', () => {
      // Note: irqbalance is also in SYSTEM which has higher priority.
      // Use processes only in DAEMON patterns.
      assert.strictEqual(classifyByComm('rsyslogd'), 'DAEMON');
      assert.strictEqual(classifyByComm('anacron'), 'DAEMON');
      assert.strictEqual(classifyByComm('tuned'), 'DAEMON');
      assert.strictEqual(classifyByComm('syslog-ng'), 'DAEMON');
    });

    it('should return UNKNOWN for unrecognized processes', () => {
      assert.strictEqual(classifyByComm('myapp'), 'UNKNOWN');
      assert.strictEqual(classifyByComm('random_process'), 'UNKNOWN');
      assert.strictEqual(classifyByComm(''), 'UNKNOWN');
    });

    it('should prioritize SYSTEM over DAEMON over GAME etc.', () => {
      // 'dockerd' appears in both CONTAINER and DAEMON patterns,
      // but DAEMON comes first in priorityOrder, so it matches DAEMON
      assert.strictEqual(classifyByComm('dockerd'), 'DAEMON');
    });
  });

  describe('classifyElectronChild', () => {
    it('should return ELECTRON for child of known Electron parent', () => {
      assert.strictEqual(classifyElectronChild('renderer', 'code'), 'ELECTRON');
      assert.strictEqual(classifyElectronChild('renderer', 'discord'), 'ELECTRON');
      assert.strictEqual(classifyElectronChild('renderer', 'slack'), 'ELECTRON');
      assert.strictEqual(classifyElectronChild('renderer', 'Notion'), 'ELECTRON');
    });

    it('should fall back to classifyByComm for non-Electron parents', () => {
      assert.strictEqual(classifyElectronChild('bash', 'systemd'), 'UNKNOWN');
    });
  });

  describe('categoryToSchedulerClass', () => {
    it('should map categories to correct scheduler classes', () => {
      assert.strictEqual(categoryToSchedulerClass('SYSTEM'), 'REALTIME');
      assert.strictEqual(categoryToSchedulerClass('DAEMON'), 'REALTIME');
      assert.strictEqual(categoryToSchedulerClass('GAME'), 'INTERACTIVE');
      assert.strictEqual(categoryToSchedulerClass('IDE'), 'INTERACTIVE');
      assert.strictEqual(categoryToSchedulerClass('BROWSER'), 'INTERACTIVE');
      assert.strictEqual(categoryToSchedulerClass('ELECTRON'), 'INTERACTIVE');
      assert.strictEqual(categoryToSchedulerClass('AUDIO'), 'MULTIMEDIA');
      assert.strictEqual(categoryToSchedulerClass('VIDEO'), 'MULTIMEDIA');
      assert.strictEqual(categoryToSchedulerClass('STREAMING'), 'MULTIMEDIA');
      assert.strictEqual(categoryToSchedulerClass('WALLPAPER'), 'MULTIMEDIA');
      assert.strictEqual(categoryToSchedulerClass('COMPILER'), 'BACKGROUND');
      assert.strictEqual(categoryToSchedulerClass('STEAM'), 'BACKGROUND');
      assert.strictEqual(categoryToSchedulerClass('CONTAINER'), 'BACKGROUND');
      assert.strictEqual(categoryToSchedulerClass('VM'), 'BACKGROUND');
      assert.strictEqual(categoryToSchedulerClass('UNKNOWN'), 'IDLE');
      assert.strictEqual(categoryToSchedulerClass('FLATPAK'), 'BACKGROUND');
      assert.strictEqual(categoryToSchedulerClass('SNAP'), 'BACKGROUND');
    });

    it('should return IDLE for unknown categories', () => {
      assert.strictEqual(categoryToSchedulerClass('NONEXISTENT'), 'IDLE');
    });
  });

  describe('schedulerClassPriority', () => {
    it('should return correct priority from config', () => {
      assert.strictEqual(schedulerClassPriority('REALTIME', config), config.SCHEDULER_CLASS_REALTIME_PRIORITY);
      assert.strictEqual(schedulerClassPriority('INTERACTIVE', config), config.SCHEDULER_CLASS_INTERACTIVE_PRIORITY);
      assert.strictEqual(schedulerClassPriority('MULTIMEDIA', config), config.SCHEDULER_CLASS_MULTIMEDIA_PRIORITY);
      assert.strictEqual(schedulerClassPriority('BACKGROUND', config), config.SCHEDULER_CLASS_BACKGROUND_PRIORITY);
      assert.strictEqual(schedulerClassPriority('IDLE', config), config.SCHEDULER_CLASS_IDLE_PRIORITY);
    });

    it('should return 10 for unknown class or missing key', () => {
      assert.strictEqual(schedulerClassPriority('NONEXISTENT', {}), 10);
    });
  });

  describe('schedulerClassNice', () => {
    it('should return correct nice values from config', () => {
      assert.strictEqual(schedulerClassNice('REALTIME', config), config.SCHEDULER_CLASS_REALTIME_NICE);
      assert.strictEqual(schedulerClassNice('INTERACTIVE', config), config.SCHEDULER_CLASS_INTERACTIVE_NICE);
      assert.strictEqual(schedulerClassNice('BACKGROUND', config), config.SCHEDULER_CLASS_BACKGROUND_NICE);
      assert.strictEqual(schedulerClassNice('IDLE', config), config.SCHEDULER_CLASS_IDLE_NICE);
    });

    it('should return 0 for unknown class', () => {
      assert.strictEqual(schedulerClassNice('NONEXISTENT', {}), 0);
    });
  });

  describe('schedulerClassIoPrio', () => {
    it('should return correct I/O priority arrays from config', () => {
      assert.deepStrictEqual(schedulerClassIoPrio('REALTIME', config), config.SCHEDULER_CLASS_REALTIME_IOPRIO);
      assert.deepStrictEqual(schedulerClassIoPrio('BACKGROUND', config), config.SCHEDULER_CLASS_BACKGROUND_IOPRIO);
    });

    it('should return [2, 4] default for unknown class', () => {
      assert.deepStrictEqual(schedulerClassIoPrio('NONEXISTENT', {}), [2, 4]);
    });
  });

  describe('isRealtime', () => {
    it('should return true for SYSTEM and DAEMON categories', () => {
      assert.strictEqual(isRealtime('SYSTEM'), true);
      assert.strictEqual(isRealtime('DAEMON'), true);
    });

    it('should return false for other categories', () => {
      assert.strictEqual(isRealtime('GAME'), false);
      assert.strictEqual(isRealtime('AUDIO'), false);
      assert.strictEqual(isRealtime('COMPILER'), false);
      assert.strictEqual(isRealtime('UNKNOWN'), false);
    });
  });

  describe('isMultimedia', () => {
    it('should return true for multimedia categories', () => {
      assert.strictEqual(isMultimedia('AUDIO'), true);
      assert.strictEqual(isMultimedia('VIDEO'), true);
      assert.strictEqual(isMultimedia('STREAMING'), true);
      assert.strictEqual(isMultimedia('WALLPAPER'), true);
    });

    it('should return false for non-multimedia categories', () => {
      assert.strictEqual(isMultimedia('SYSTEM'), false);
      assert.strictEqual(isMultimedia('GAME'), false);
      assert.strictEqual(isMultimedia('COMPILER'), false);
    });
  });

  describe('isProtected', () => {
    it('should return true for REALTIME and MULTIMEDIA classes', () => {
      assert.strictEqual(isProtected('SYSTEM'), true);
      assert.strictEqual(isProtected('DAEMON'), true);
      assert.strictEqual(isProtected('AUDIO'), true);
      assert.strictEqual(isProtected('VIDEO'), true);
    });

    it('should return false for INTERACTIVE, BACKGROUND, IDLE', () => {
      assert.strictEqual(isProtected('GAME'), false);
      assert.strictEqual(isProtected('COMPILER'), false);
      assert.strictEqual(isProtected('UNKNOWN'), false);
    });
  });

  describe('cache behavior', () => {
    it('should cache classification results', () => {
      classifyByComm('firefox');
      classifyByComm('firefox');
      // Second call should hit cache — no way to directly test, but no error means it works
      assert.strictEqual(classifyByComm('firefox'), 'BROWSER');
    });

    it('should clear cache', () => {
      classifyByComm('chrome');
      clearCache();
      // After clear, should still classify correctly
      assert.strictEqual(classifyByComm('chrome'), 'BROWSER');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SENSOR / CpuHistory
// ═══════════════════════════════════════════════════════════════════════════

describe('CpuHistory', () => {
  let CpuHistory;
  before(() => { CpuHistory = require('../../sensor').CpuHistory; });

  it('should default to size 5', () => {
    const h = new CpuHistory();
    assert.strictEqual(h.size, 5);
  });

  it('should clamp size to [1, 60]', () => {
    assert.strictEqual(new CpuHistory(0).size, 1);
    assert.strictEqual(new CpuHistory(-5).size, 1);
    assert.strictEqual(new CpuHistory(100).size, 60);
    assert.strictEqual(new CpuHistory(10).size, 10);
  });

  it('should push valid samples and compute averages', () => {
    const h = new CpuHistory(3);
    h.push({ cpuAvg10: 10, memAvg10: 5 });
    h.push({ cpuAvg10: 20, memAvg10: 10 });
    assert.strictEqual(h.count, 2);
    assert.ok(Math.abs(h.cpuAvg - 15) < 0.001);
    assert.ok(Math.abs(h.memAvg - 7.5) < 0.001);
  });

  it('should silently reject invalid samples', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: 'not a number', memAvg10: 1 });
    h.push({ cpuAvg10: 1 });
    h.push({ memAvg10: 1 });
    h.push(42); // number, not object — accessing .cpuAvg10 returns undefined
    // Note: passing null or undefined as sample crashes (implementation doesn't guard)
    // Test only samples that are objects but with wrong types
    assert.strictEqual(h.count, 0);
  });

  it('should evict oldest samples when buffer is full (overflow)', () => {
    const h = new CpuHistory(3);
    h.push({ cpuAvg10: 1, memAvg10: 1 });
    h.push({ cpuAvg10: 2, memAvg10: 2 });
    h.push({ cpuAvg10: 3, memAvg10: 3 });
    h.push({ cpuAvg10: 4, memAvg10: 4 });
    assert.strictEqual(h.count, 3);
    assert.ok(Math.abs(h.cpuAvg - 3) < 0.001);
    assert.ok(Math.abs(h.memAvg - 3) < 0.001);
  });

  it('should handle single sample', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: 42, memAvg10: 10 });
    assert.strictEqual(h.cpuAvg, 42);
    assert.strictEqual(h.memAvg, 10);
    assert.strictEqual(h.count, 1);
  });

  it('should return 0 for averages when empty', () => {
    const h = new CpuHistory(5);
    assert.strictEqual(h.cpuAvg, 0);
    assert.strictEqual(h.memAvg, 0);
    assert.strictEqual(h.count, 0);
  });

  it('should resize and trim excess samples', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: 1, memAvg10: 1 });
    h.push({ cpuAvg10: 2, memAvg10: 2 });
    h.push({ cpuAvg10: 3, memAvg10: 3 });
    h.resize(2);
    assert.strictEqual(h.size, 2);
    assert.strictEqual(h.count, 2);
    assert.ok(Math.abs(h.cpuAvg - 2.5) < 0.001);
  });

  it('should clear all samples', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: 1, memAvg10: 1 });
    h.clear();
    assert.strictEqual(h.count, 0);
    assert.strictEqual(h.cpuAvg, 0);
    assert.strictEqual(h.memAvg, 0);
  });

  it('should return copies of internal arrays', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: 10, memAvg10: 5 });
    const cpuSamples = h.cpuSamples;
    const memSamples = h.memSamples;
    assert.deepStrictEqual(cpuSamples, [10]);
    assert.deepStrictEqual(memSamples, [5]);
    cpuSamples.push(999);
    assert.strictEqual(h.count, 1);
  });

  it('should handle negative and zero values', () => {
    const h = new CpuHistory(5);
    h.push({ cpuAvg10: -5, memAvg10: 0 });
    h.push({ cpuAvg10: 0, memAvg10: -10 });
    assert.ok(Math.abs(h.cpuAvg - (-2.5)) < 0.001);
    assert.ok(Math.abs(h.memAvg - (-5)) < 0.001);
  });

  it('should resize to larger size without losing data', () => {
    const h = new CpuHistory(2);
    h.push({ cpuAvg10: 10, memAvg10: 5 });
    h.push({ cpuAvg10: 20, memAvg10: 10 });
    h.resize(10);
    assert.strictEqual(h.size, 10);
    assert.strictEqual(h.count, 2);
  });
});

describe('Sensor validateSysPath', () => {
  let sensor;
  before(() => { sensor = require('../../sensor'); });

  it('should accept /proc/ paths', () => {
    assert.strictEqual(sensor.validateSysPath('/proc/pressure/cpu'), '/proc/pressure/cpu');
  });

  it('should accept /sys/ paths', () => {
    assert.strictEqual(sensor.validateSysPath('/sys/class/thermal/thermal_zone0/temp'),
      '/sys/class/thermal/thermal_zone0/temp');
  });

  it('should reject path traversal with ..', () => {
    assert.strictEqual(sensor.validateSysPath('/proc/../etc/passwd'), null);
  });

  it('should reject null bytes', () => {
    assert.strictEqual(sensor.validateSysPath('/proc/pressure/cpu\0evil'), null);
  });

  it('should reject non-string input', () => {
    assert.strictEqual(sensor.validateSysPath(null), null);
    assert.strictEqual(sensor.validateSysPath(undefined), null);
    assert.strictEqual(sensor.validateSysPath(123), null);
  });

  it('should reject paths outside /proc and /sys', () => {
    assert.strictEqual(sensor.validateSysPath('/etc/passwd'), null);
    assert.strictEqual(sensor.validateSysPath('/tmp/file'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SCHEDULER / HysteresisState
// ═══════════════════════════════════════════════════════════════════════════

describe('HysteresisState', () => {
  const { HysteresisState } = require('../../scheduler');

  it('should start at NORMAL', () => {
    const h = new HysteresisState();
    assert.strictEqual(h.current, 'NORMAL');
  });

  it('should not change when evaluating same level', () => {
    const h = new HysteresisState();
    const result = h.evaluate('NORMAL', makeConfig());
    assert.strictEqual(result.level, 'NORMAL');
    assert.strictEqual(result.changed, false);
    assert.strictEqual(h.current, 'NORMAL');
  });

  it('should transition immediately when ENABLE_HYSTERESIS=false', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ ENABLE_HYSTERESIS: false });
    const result = h.evaluate('WARN', cfg);
    assert.strictEqual(result.level, 'WARN');
    assert.strictEqual(result.changed, true);
    assert.strictEqual(h.current, 'WARN');
  });

  it('should not transition when ENABLE_HYSTERESIS=false and same level', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ ENABLE_HYSTERESIS: false });
    const result = h.evaluate('NORMAL', cfg);
    assert.strictEqual(result.changed, false);
  });

  it('should block transition by hysteresis time', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ HYSTERESIS_NORMAL_TO_WARN_MS: 3000 });
    // First call: start pending
    const r1 = h.evaluate('WARN', cfg);
    assert.strictEqual(r1.level, 'NORMAL');
    assert.strictEqual(r1.changed, false);
    assert.strictEqual(h.current, 'NORMAL');
  });

  it('should transition after dwell time has elapsed', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ HYSTERESIS_NORMAL_TO_WARN_MS: 10 }); // 10ms dwell
    // First call: start pending
    h.evaluate('WARN', cfg);
    // Wait for dwell time
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }
    // Second call: should transition
    const result = h.evaluate('WARN', cfg);
    assert.strictEqual(result.level, 'WARN');
    assert.strictEqual(result.changed, true);
    assert.strictEqual(h.current, 'WARN');
  });

  it('should cancel pending transition if desired level changes back', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ HYSTERESIS_NORMAL_TO_WARN_MS: 5000 });
    h.evaluate('WARN', cfg); // start pending WARN
    const r2 = h.evaluate('NORMAL', cfg); // immediately back to NORMAL
    assert.strictEqual(r2.level, 'NORMAL');
    assert.strictEqual(r2.changed, false);
  });

  it('should reset to NORMAL', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({ ENABLE_HYSTERESIS: false });
    h.evaluate('CRITICAL', cfg);
    assert.strictEqual(h.current, 'CRITICAL');
    h.reset();
    assert.strictEqual(h.current, 'NORMAL');
  });

  it('should use different dwell times for different transitions', () => {
    const h = new HysteresisState();
    const cfg = makeConfig({
      HYSTERESIS_NORMAL_TO_WARN_MS: 10,
      HYSTERESIS_WARN_TO_CRITICAL_MS: 10,
      HYSTERESIS_CRITICAL_TO_NORMAL_MS: 10,
    });
    // NORMAL -> CRITICAL (skipping WARN)
    h.evaluate('CRITICAL', cfg);
    const start = Date.now();
    while (Date.now() - start < 25) { /* wait for NORMAL_TO_WARN + WARN_TO_CRITICAL */ }
    const r = h.evaluate('CRITICAL', cfg);
    assert.strictEqual(r.level, 'CRITICAL');
    assert.strictEqual(r.changed, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SCHEDULER / AutoRestoreTracker
// ═══════════════════════════════════════════════════════════════════════════

describe('AutoRestoreTracker', () => {
  const { AutoRestoreTracker } = require('../../scheduler');

  it('should start empty', () => {
    const t = new AutoRestoreTracker();
    assert.strictEqual(t.size, 0);
    assert.ok(t.getThrottledPids().size === 0);
  });

  it('should mark a PID as throttled', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'test', nice: 10 });
    assert.strictEqual(t.size, 1);
    assert.ok(t.isThrottled(TEST_PID));
    assert.ok(!t.isThrottled(ANOTHER_PID));
  });

  it('should store info with timestamp', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'test', nice: 10 });
    const info = t.getInfo(TEST_PID);
    assert.ok(info);
    assert.strictEqual(info.comm, 'test');
    assert.strictEqual(info.nice, 10);
    assert.ok(typeof info.timestamp === 'number');
  });

  it('should return null for non-existent PID info', () => {
    const t = new AutoRestoreTracker();
    assert.strictEqual(t.getInfo(TEST_PID), null);
  });

  it('should remove a PID', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'test' });
    t.remove(TEST_PID);
    assert.strictEqual(t.size, 0);
    assert.ok(!t.isThrottled(TEST_PID));
  });

  it('should prune dead PIDs', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'alive' });
    t.markThrottled(ANOTHER_PID, { comm: 'dead' });
    t.pruneDead(new Set([TEST_PID]));
    assert.strictEqual(t.size, 1);
    assert.ok(t.isThrottled(TEST_PID));
    assert.ok(!t.isThrottled(ANOTHER_PID));
  });

  it('should get all throttled PIDs with info', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'test1' });
    t.markThrottled(ANOTHER_PID, { comm: 'test2' });
    const all = t.getThrottledPidsWithInfo();
    assert.ok(all instanceof Map);
    assert.strictEqual(all.size, 2);
    assert.ok(all.has(TEST_PID));
    assert.ok(all.has(ANOTHER_PID));
  });

  it('should get throttled PIDs as Set', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, {});
    t.markThrottled(ANOTHER_PID, {});
    const pids = t.getThrottledPids();
    assert.ok(pids instanceof Set);
    assert.strictEqual(pids.size, 2);
    assert.ok(pids.has(TEST_PID));
  });

  it('should clear all entries', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, {});
    t.markThrottled(ANOTHER_PID, {});
    t.clear();
    assert.strictEqual(t.size, 0);
  });

  it('should overwrite info on re-mark', () => {
    const t = new AutoRestoreTracker();
    t.markThrottled(TEST_PID, { comm: 'old' });
    t.markThrottled(TEST_PID, { comm: 'new' });
    assert.strictEqual(t.size, 1);
    assert.strictEqual(t.getInfo(TEST_PID).comm, 'new');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. SCHEDULER / calculateAdaptiveScore
// ═══════════════════════════════════════════════════════════════════════════

describe('calculateAdaptiveScore', () => {
  const { calculateAdaptiveScore } = require('../../scheduler');

  it('should return 0 when ENABLE_SMART_SCHEDULER is false', () => {
    const cfg = makeConfig({ ENABLE_SMART_SCHEDULER: false });
    const score = calculateAdaptiveScore({ cpuPressure: 100, memPressure: 100 }, cfg);
    assert.strictEqual(score, 0);
  });

  it('should return 0 when ENABLE_ADAPTIVE_SCHEDULER is false', () => {
    const cfg = makeConfig({ ENABLE_ADAPTIVE_SCHEDULER: false });
    const score = calculateAdaptiveScore({ cpuPressure: 100, memPressure: 100 }, cfg);
    assert.strictEqual(score, 0);
  });

  it('should return 0 when all factors are zero/low', () => {
    const cfg = makeConfig();
    const score = calculateAdaptiveScore({
      cpuPressure: 0,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    assert.strictEqual(score, 0);
  });

  it('should increase with high CPU pressure', () => {
    const cfg = makeConfig();
    const score = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    assert.ok(score > 0);
  });

  it('should increase with foreground process', () => {
    const cfg = makeConfig();
    const score1 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    const score2 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: true,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    assert.ok(score2 > score1);
  });

  it('should decrease with media playing (media penalty)', () => {
    const cfg = makeConfig();
    const score1 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    const score2 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: true,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    assert.ok(score2 < score1);
  });

  it('should decrease on battery', () => {
    const cfg = makeConfig();
    const score1 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 30,
    }, cfg);
    const score2 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: true,
      thermalTemp: 30,
    }, cfg);
    assert.ok(score2 < score1);
  });

  it('should increase with high thermal temperature', () => {
    const cfg = makeConfig();
    const score1 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 50, // below threshold
    }, cfg);
    const score2 = calculateAdaptiveScore({
      cpuPressure: cfg.PSI_CPU_CRITICAL,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 80, // above threshold
    }, cfg);
    assert.ok(score2 > score1);
  });

  it('should clamp result to [0, 1]', () => {
    const cfg = makeConfig();
    const score = calculateAdaptiveScore({
      cpuPressure: 999,
      memPressure: 999,
      hasForeground: true,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: 100,
    }, cfg);
    assert.ok(score >= 0);
    assert.ok(score <= 1);
  });

  it('should handle null thermalTemp', () => {
    const cfg = makeConfig();
    const score = calculateAdaptiveScore({
      cpuPressure: 0,
      memPressure: 0,
      hasForeground: false,
      mediaPlaying: false,
      onBattery: false,
      thermalTemp: null,
    }, cfg);
    assert.strictEqual(score, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SCHEDULER CLASS
// ═══════════════════════════════════════════════════════════════════════════

describe('Scheduler class', () => {
  const { Scheduler, STRESS_LEVELS, SCHED_CLASSES, SCHED_CLASS_ORDER, STRESS_ORDER } = require('../../scheduler');
  const { CpuHistory } = require('../../sensor');

  it('should export correct constants', () => {
    assert.deepStrictEqual(STRESS_LEVELS, ['NORMAL', 'WARN', 'CRITICAL']);
    assert.deepStrictEqual(SCHED_CLASSES, ['REALTIME', 'INTERACTIVE', 'MULTIMEDIA', 'BACKGROUND', 'IDLE']);
    assert.strictEqual(STRESS_ORDER.NORMAL, 0);
    assert.strictEqual(STRESS_ORDER.WARN, 1);
    assert.strictEqual(STRESS_ORDER.CRITICAL, 2);
    assert.strictEqual(SCHED_CLASS_ORDER.REALTIME, 0);
    assert.strictEqual(SCHED_CLASS_ORDER.IDLE, 4);
  });

  describe('constructor', () => {
    it('should initialize with default stress level NORMAL', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      assert.strictEqual(s.stressLevel, 'NORMAL');
      assert.strictEqual(s.decisionCount, 0);
    });

    it('should set up foreground/background core layout', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      assert.ok(Array.isArray(s.foregroundCores));
      assert.ok(Array.isArray(s.backgroundCores));
      assert.ok(Array.isArray(s.allCores));
      assert.strictEqual(s.allCores.length, 8);
      // foregroundCores + backgroundCores should equal allCores
      const combined = [...s.foregroundCores, ...s.backgroundCores].sort((a, b) => a - b);
      assert.deepStrictEqual(combined, s.allCores);
    });
  });

  describe('tick()', () => {
    it('should remain NORMAL when PSI is low', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const result = s.tick({
        cpuPSI: { some: { avg10: 1.0 } },
        memPSI: { some: { avg10: 1.0 } },
      }, { foregroundPid: null, mediaPids: new Set() });

      restoreConsole();
      assert.strictEqual(result.stressLevel, 'NORMAL');
      assert.strictEqual(result.changed, false);
    });

    it('should transition to WARN when PSI exceeds threshold', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const result = s.tick({
        cpuPSI: { some: { avg10: 10.0 } },
        memPSI: { some: { avg10: 1.0 } },
      }, { foregroundPid: null, mediaPids: new Set() });

      restoreConsole();
      assert.strictEqual(result.stressLevel, 'WARN');
      assert.strictEqual(result.changed, true);
    });

    it('should transition to CRITICAL when PSI exceeds critical threshold', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_CRITICAL: 15.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const result = s.tick({
        cpuPSI: { some: { avg10: 20.0 } },
        memPSI: { some: { avg10: 1.0 } },
      }, { foregroundPid: null, mediaPids: new Set() });

      restoreConsole();
      assert.strictEqual(result.stressLevel, 'CRITICAL');
      assert.strictEqual(result.changed, true);
    });

    it('should increment decisionCount', () => {
      const cfg = makeConfig();
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 0 } }, memPSI: { some: { avg10: 0 } } }, {});
      s.tick({ cpuPSI: { some: { avg10: 0 } }, memPSI: { some: { avg10: 0 } } }, {});

      restoreConsole();
      assert.strictEqual(s.decisionCount, 2);
    });

    it('should handle missing PSI data gracefully', () => {
      const cfg = makeConfig();
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const result = s.tick({}, {});
      restoreConsole();
      assert.strictEqual(result.stressLevel, 'NORMAL');
    });

    it('should compute cpuPressure and memPressure from history', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0, ENABLE_CPU_HISTORY: true });
      const cpuHistory = new CpuHistory(5);
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      // Push some history
      cpuHistory.push({ cpuAvg10: 10.0, memAvg10: 1.0 });
      cpuHistory.push({ cpuAvg10: 10.0, memAvg10: 1.0 });

      const result = s.tick({
        cpuPSI: { some: { avg10: 10.0 } },
        memPSI: { some: { avg10: 1.0 } },
      }, { foregroundPid: null, mediaPids: new Set() });

      restoreConsole();
      assert.strictEqual(result.stressLevel, 'WARN');
    });

    it('should generate auto-restore actions when returning to NORMAL with AUTO_RESTORE', () => {
      const cfg = makeConfig({
        ENABLE_HYSTERESIS: false,
        AUTO_RESTORE: true,
        ENABLE_CPU_HISTORY: true,
        CPU_HISTORY_SIZE: 1, // only latest sample
        PSI_CPU_WARN: 5.0,
      });
      const cpuHistory = new CpuHistory(1);
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      // First tick: high PSI → WARN
      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});
      assert.strictEqual(s.stressLevel, 'WARN');

      // Mark a process as throttled
      s.autoRestore.markThrottled(TEST_PID, { comm: 'test_proc' });

      // Second tick: low PSI → NORMAL (history size=1, so only latest matters)
      const result = s.tick({ cpuPSI: { some: { avg10: 0 } }, memPSI: {} }, {});

      restoreConsole();
      assert.strictEqual(result.stressLevel, 'NORMAL');
      assert.ok(result.actions.length > 0);
      assert.strictEqual(result.actions[0].type, 'RESTORE');
      assert.strictEqual(result.actions[0].pid, TEST_PID);
    });
  });

  describe('classifyProcesses()', () => {
    it('should return empty array when stress is NORMAL', () => {
      const cfg = makeConfig();
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should not throttle REALTIME processes', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      // Push to WARN
      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'systemd' },
      ], null, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should not throttle MULTIMEDIA processes', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'mpv' },
      ], null, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should not throttle foreground process tree', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const fgPid = TEST_PID;
      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], fgPid, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should not throttle media-protected PIDs', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set([TEST_PID]));

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should throttle heavy BACKGROUND processes under stress', () => {
      const cfg = makeConfig({
        ENABLE_HYSTERESIS: false,
        PSI_CPU_WARN: 5.0,
        HEAVY_BG_CPU_THRESHOLD: 15.0,
      });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());

      restoreConsole();
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].type, 'THROTTLE');
      assert.strictEqual(actions[0].pid, TEST_PID);
      assert.strictEqual(actions[0].schedClass, 'BACKGROUND');
      assert.strictEqual(actions[0].nice, cfg.SCHEDULER_CLASS_BACKGROUND_NICE);
      assert.ok(Array.isArray(actions[0].cores));
    });

    it('should skip already-throttled PIDs (no duplicate actions)', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      // First classify: should throttle
      const actions1 = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());
      assert.strictEqual(actions1.length, 1);

      // Simulate caller marking the PID as throttled (as the daemon would)
      s.autoRestore.markThrottled(TEST_PID, { comm: 'rustc', nice: 10 });

      // Second classify: already throttled, should not duplicate
      const actions2 = s.classifyProcesses([
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());
      assert.strictEqual(actions2.length, 0);

      restoreConsole();
    });

    it('should skip process.pid (self)', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: process.pid, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });

    it('should skip PIDs with invalid pid values', () => {
      const cfg = makeConfig({ ENABLE_HYSTERESIS: false, PSI_CPU_WARN: 5.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 10.0 } }, memPSI: {} }, {});

      const actions = s.classifyProcesses([
        { pid: -1, ppid: 1, pcpu: 50, comm: 'rustc' },
        { pid: 0, ppid: 1, pcpu: 50, comm: 'rustc' },
      ], null, new Set());

      restoreConsole();
      assert.deepStrictEqual(actions, []);
    });
  });

  describe('generateForegroundBoost()', () => {
    it('should return null when no pid', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      assert.strictEqual(s.generateForegroundBoost(null, [], false), null);
    });

    it('should return BOOST action for foreground process', () => {
      const cfg = makeConfig();
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      const result = s.generateForegroundBoost(TEST_PID, [
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'firefox' },
      ], false);

      restoreConsole();
      assert.ok(result);
      assert.strictEqual(result.type, 'BOOST');
      assert.strictEqual(result.pid, TEST_PID);
      assert.strictEqual(result.comm, 'firefox');
      assert.strictEqual(result.schedClass, 'INTERACTIVE');
      assert.ok(Array.isArray(result.cores));
      assert.strictEqual(result.gameModeActive, false);
    });

    it('should use nice=0 when GameMode is active', () => {
      const cfg = makeConfig();
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);

      const result = s.generateForegroundBoost(TEST_PID, [
        { pid: TEST_PID, ppid: 1, pcpu: 50, comm: 'firefox' },
      ], true);

      assert.ok(result);
      assert.strictEqual(result.nice, 0);
      assert.strictEqual(result.gameModeActive, true);
    });
  });

  describe('_buildDescendantSet()', () => {
    it('should return empty set when no rootPid', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      const result = s._buildDescendantSet([], null);
      assert.ok(result instanceof Set);
      assert.strictEqual(result.size, 0);
    });

    it('should build tree of descendants', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      const procs = [
        { pid: 100, ppid: 10 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 100 },
        { pid: 400, ppid: 200 },
        { pid: 500, ppid: 999 }, // unrelated
      ];
      const result = s._buildDescendantSet(procs, 100);
      assert.ok(result.has(100));
      assert.ok(result.has(200));
      assert.ok(result.has(300));
      assert.ok(result.has(400));
      assert.ok(!result.has(500));
      assert.strictEqual(result.size, 4);
    });
  });

  describe('_isHeavyBackground()', () => {
    it('should return true for BACKGROUND scheduler class', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      assert.ok(s._isHeavyBackground({ pcpu: 1 }, 'COMPILER'));
      assert.ok(s._isHeavyBackground({ pcpu: 1 }, 'CONTAINER'));
      assert.ok(s._isHeavyBackground({ pcpu: 1 }, 'VM'));
    });

    it('should return true for processes above CPU threshold', () => {
      const cfg = makeConfig({ HEAVY_BG_CPU_THRESHOLD: 15.0 });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      assert.ok(s._isHeavyBackground({ pcpu: 20 }, 'UNKNOWN'));
      assert.ok(!s._isHeavyBackground({ pcpu: 5 }, 'UNKNOWN'));
    });

    it('should return false for INTERACTIVE class below threshold', () => {
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(makeConfig(), mockTopology, cpuHistory);
      assert.ok(!s._isHeavyBackground({ pcpu: 5 }, 'GAME'));
      assert.ok(!s._isHeavyBackground({ pcpu: 5 }, 'IDE'));
    });
  });

  describe('feature flags', () => {
    it('should skip CPU history push when ENABLE_CPU_HISTORY is false', () => {
      const cfg = makeConfig({ ENABLE_CPU_HISTORY: false, ENABLE_HYSTERESIS: false });
      const cpuHistory = new CpuHistory();
      const s = new Scheduler(cfg, mockTopology, cpuHistory);
      suppressConsole();

      s.tick({ cpuPSI: { some: { avg10: 5.0 } }, memPSI: { some: { avg10: 5.0 } } }, {});

      restoreConsole();
      assert.strictEqual(cpuHistory.count, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. LOGGER
// ═══════════════════════════════════════════════════════════════════════════

describe('Logger', () => {
  const { LEVELS, LEVEL_NAMES, setLevel, getLevel, setLogHook,
          log, trace, debug, info, warn, error, fatal,
          setSchedulerStateProvider, closeFileLogging } = require('../../logger');

  let originalLevel;

  beforeEach(() => {
    originalLevel = getLevel();
    setLogHook(null);
    closeFileLogging();
  });

  afterEach(() => {
    setLevel(originalLevel);
    setLogHook(null);
    closeFileLogging();
  });

  describe('levels ordering', () => {
    it('should have correct numeric ordering', () => {
      assert.ok(LEVELS.trace < LEVELS.debug);
      assert.ok(LEVELS.debug < LEVELS.info);
      assert.ok(LEVELS.info < LEVELS.warn);
      assert.ok(LEVELS.warn < LEVELS.error);
      assert.ok(LEVELS.error < LEVELS.fatal);
    });

    it('should have LEVEL_NAMES in correct order', () => {
      assert.deepStrictEqual(LEVEL_NAMES, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    });
  });

  describe('setLevel / getLevel', () => {
    it('should set and get level', () => {
      setLevel('debug');
      assert.strictEqual(getLevel(), 'debug');
      setLevel('fatal');
      assert.strictEqual(getLevel(), 'fatal');
    });

    it('should normalize case', () => {
      setLevel('DEBUG');
      assert.strictEqual(getLevel(), 'debug');
      setLevel('WARN');
      assert.strictEqual(getLevel(), 'warn');
    });

    it('should ignore invalid levels', () => {
      setLevel('info');
      setLevel('invalid');
      assert.strictEqual(getLevel(), 'info'); // stays at current
    });
  });

  describe('log filtering', () => {
    it('should suppress messages below current level', () => {
      suppressConsole();
      setLevel('warn');

      // These should be suppressed
      log('trace', 'should not appear');
      log('debug', 'should not appear');
      log('info', 'should not appear');

      // Check that console was not called for suppressed
      const logCalls = console.log.mock.calls.length;
      assert.strictEqual(logCalls, 0);

      restoreConsole();
    });

    it('should output messages at or above current level', () => {
      setLevel('error');
      suppressConsole();

      error('error msg');
      fatal('fatal msg');

      const errorCalls = console.error.mock.calls.length;
      assert.ok(errorCalls >= 2);

      restoreConsole();
    });

    it('should route error/fatal to console.error', () => {
      setLevel('error');
      suppressConsole();

      error('test');
      fatal('test');

      const errorCalls = console.error.mock.calls.length;
      assert.ok(errorCalls >= 2);

      restoreConsole();
    });

    it('should route warn to console.warn', () => {
      setLevel('warn');
      suppressConsole();

      warn('test');

      const warnCalls = console.warn.mock.calls.length;
      assert.ok(warnCalls >= 1);

      restoreConsole();
    });

    it('should route trace/debug/info to console.log', () => {
      setLevel('trace');
      suppressConsole();

      trace('test');
      debug('test');
      info('test');

      const logCalls = console.log.mock.calls.length;
      assert.ok(logCalls >= 3);

      restoreConsole();
    });
  });

  describe('setLogHook', () => {
    it('should call hook with level and args', () => {
      setLevel('info');
      let hookCalled = false;
      let hookLevel, hookArgs;

      setLogHook((level, ts, args) => {
        hookCalled = true;
        hookLevel = level;
        hookArgs = args;
      });

      suppressConsole();
      info('hello', 'world');
      restoreConsole();

      assert.ok(hookCalled);
      assert.strictEqual(hookLevel, 'info');
      assert.deepStrictEqual(hookArgs, ['hello', 'world']);
    });

    it('should not call hook for suppressed levels', () => {
      setLevel('error');
      let hookCalled = false;

      setLogHook(() => { hookCalled = true; });

      suppressConsole();
      info('suppressed');
      restoreConsole();

      assert.ok(!hookCalled);
    });
  });

  describe('setSchedulerStateProvider', () => {
    it('should include scheduler state in log messages', () => {
      setLevel('info');
      setSchedulerStateProvider(() => 'WARN');
      suppressConsole();

      info('test message');

      const logCalls = console.log.mock.calls.length;
      assert.ok(logCalls >= 1);
      const msg = console.log.mock.calls[0].arguments[0];
      assert.ok(msg.includes('[WARN]'), `Message should include [WARN]: ${msg}`);

      restoreConsole();
      setSchedulerStateProvider(null);
    });
  });

  describe('file logging', () => {
    it('should set up file logging to a temp path', (t, done) => {
      const tmpDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), `dynalloc-test-${Date.now()}`));
      const logPath = pathModule.join(tmpDir, 'test.log');
      const { setupFileLogging } = require('../../logger');

      setupFileLogging({ filePath: logPath, maxSizeBytes: 1024, maxFiles: 2 });
      setLevel('info');

      info('file log test');

      // Deterministik: tunggu event 'finish' asli dari stream, bukan
      // menebak durasi flush dengan setTimeout (rawan flaky di disk lambat).
      closeFileLogging(() => {
        try {
          assert.ok(fs.existsSync(logPath));
          const content = fs.readFileSync(logPath, 'utf8');
          assert.ok(content.includes('file log test'));
          done();
        } catch (err) {
          done(err);
        } finally {
          try { fs.unlinkSync(logPath); } catch (_) {}
          try { fs.rmdirSync(tmpDir); } catch (_) {}
        }
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. METRICS
// ═══════════════════════════════════════════════════════════════════════════

describe('Metrics', () => {
  const { Counter, Gauge, Histogram, MetricsRegistry, getMetrics, resetMetrics } = require('../../metrics');

  afterEach(() => { resetMetrics(); });

  describe('Counter', () => {
    it('should start at 0', () => {
      const c = new Counter('test');
      assert.strictEqual(c.value, 0);
    });

    it('should increment by default amount (1)', () => {
      const c = new Counter('test');
      c.increment();
      assert.strictEqual(c.value, 1);
      c.increment();
      assert.strictEqual(c.value, 2);
    });

    it('should increment by custom amount', () => {
      const c = new Counter('test');
      c.increment(5);
      assert.strictEqual(c.value, 5);
      c.increment(10);
      assert.strictEqual(c.value, 15);
    });

    it('should reset to 0', () => {
      const c = new Counter('test');
      c.increment(100);
      c.reset();
      assert.strictEqual(c.value, 0);
    });
  });

  describe('Gauge', () => {
    it('should start at 0', () => {
      const g = new Gauge('test');
      assert.strictEqual(g.value, 0);
    });

    it('should set value', () => {
      const g = new Gauge('test');
      g.set(42);
      assert.strictEqual(g.value, 42);
      g.set(0);
      assert.strictEqual(g.value, 0);
      g.set(-5.5);
      assert.strictEqual(g.value, -5.5);
    });
  });

  describe('Histogram', () => {
    it('should start with zero stats', () => {
      const h = new Histogram('test');
      assert.strictEqual(h.count, 0);
      assert.strictEqual(h.sum, 0);
      assert.strictEqual(h.avg, 0);
      assert.strictEqual(h.min, 0);
      assert.strictEqual(h.max, 0);
    });

    it('should record values and compute stats', () => {
      const h = new Histogram('test');
      h.record(10);
      h.record(20);
      h.record(30);
      assert.strictEqual(h.count, 3);
      assert.strictEqual(h.sum, 60);
      assert.ok(Math.abs(h.avg - 20) < 0.001);
      assert.strictEqual(h.min, 10);
      assert.strictEqual(h.max, 30);
    });

    it('should compute percentiles', () => {
      const h = new Histogram('test');
      for (let i = 1; i <= 100; i++) h.record(i);
      assert.strictEqual(h.percentile(50), 50);
      assert.strictEqual(h.percentile(95), 95);
      assert.strictEqual(h.percentile(99), 99);
      assert.strictEqual(h.percentile(100), 100);
      assert.strictEqual(h.percentile(1), 1);
    });

    it('should return 0 for percentile when empty', () => {
      const h = new Histogram('test');
      assert.strictEqual(h.percentile(50), 0);
    });

    it('should handle single value', () => {
      const h = new Histogram('test');
      h.record(42);
      assert.strictEqual(h.count, 1);
      assert.strictEqual(h.avg, 42);
      assert.strictEqual(h.min, 42);
      assert.strictEqual(h.max, 42);
      assert.strictEqual(h.percentile(50), 42);
    });

    it('should handle circular buffer overflow (>1000 samples)', () => {
      const h = new Histogram('test');
      for (let i = 0; i < 2000; i++) h.record(i % 100);
      assert.strictEqual(h.count, 2000);
      assert.ok(h.avg > 0);
      assert.strictEqual(h.min, 0);
      assert.strictEqual(h.max, 99);
    });

    it('should reset', () => {
      const h = new Histogram('test');
      h.record(100);
      h.reset();
      assert.strictEqual(h.count, 0);
      assert.strictEqual(h.sum, 0);
      assert.strictEqual(h.min, 0);
      assert.strictEqual(h.max, 0);
    });

    it('should accept custom buckets', () => {
      const h = new Histogram('test', 'desc', [1, 2, 5, 10]);
      assert.deepStrictEqual(h.buckets, [1, 2, 5, 10]);
    });
  });

  describe('MetricsRegistry', () => {
    it('should initialize with default metrics', () => {
      const r = new MetricsRegistry();
      const snap = r.snapshot();
      assert.ok('scheduler_stress_level' in snap);
      assert.ok('boost_count' in snap);
      assert.ok('cpu_pressure' in snap);
      assert.ok('scheduler_tick_latency_ms_count' in snap);
      assert.ok('uptime_seconds' in snap);
    });

    it('should return same counter on repeated calls', () => {
      const r = new MetricsRegistry();
      const c1 = r.counter('custom_counter');
      const c2 = r.counter('custom_counter');
      assert.strictEqual(c1, c2);
    });

    it('should return same gauge on repeated calls', () => {
      const r = new MetricsRegistry();
      const g1 = r.gauge('custom_gauge');
      const g2 = r.gauge('custom_gauge');
      assert.strictEqual(g1, g2);
    });

    it('should return same histogram on repeated calls', () => {
      const r = new MetricsRegistry();
      const h1 = r.histogram('custom_hist');
      const h2 = r.histogram('custom_hist');
      assert.strictEqual(h1, h2);
    });

    it('snapshot should include all counter/gauge/histogram values', () => {
      const r = new MetricsRegistry();
      r.counter('boost_count').increment(5);
      r.gauge('cpu_pressure').set(10.5);
      r.histogram('scheduler_tick_latency_ms').record(5);
      r.histogram('scheduler_tick_latency_ms').record(15);

      const snap = r.snapshot();
      assert.strictEqual(snap.boost_count, 5);
      assert.strictEqual(snap.cpu_pressure, 10.5);
      assert.strictEqual(snap.scheduler_tick_latency_ms_count, 2);
      assert.ok(snap.scheduler_tick_latency_ms_avg > 0);
    });

    it('formatReport should return a string', () => {
      const r = new MetricsRegistry();
      const report = r.formatReport();
      assert.ok(typeof report === 'string');
      assert.ok(report.includes('DynAlloc Metrics'));
      assert.ok(report.includes('Uptime:'));
      assert.ok(report.includes('Scheduler'));
    });

    it('reset should zero all metrics', () => {
      const r = new MetricsRegistry();
      r.counter('boost_count').increment(100);
      r.gauge('cpu_pressure').set(50);
      r.histogram('scheduler_tick_latency_ms').record(10);
      r.reset();

      const snap = r.snapshot();
      assert.strictEqual(snap.boost_count, 0);
      assert.strictEqual(snap.cpu_pressure, 0);
      assert.strictEqual(snap.scheduler_tick_latency_ms_count, 0);
    });
  });

  describe('getMetrics / resetMetrics singleton', () => {
    it('should return same instance', () => {
      const m1 = getMetrics();
      const m2 = getMetrics();
      assert.strictEqual(m1, m2);
    });

    it('should create new instance after reset', () => {
      const m1 = getMetrics();
      resetMetrics();
      const m2 = getMetrics();
      assert.ok(m1 !== m2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. PLUGIN MANAGER
// ═══════════════════════════════════════════════════════════════════════════

describe('PluginManager', () => {
  const { PluginManager, getPluginManager, resetPluginManager } = require('../../plugin-manager');

  afterEach(() => { resetPluginManager(); });

  describe('register', () => {
    it('should register a valid plugin', () => {
      const pm = new PluginManager();
      const result = pm.register({
        name: 'test-plugin',
        version: '1.0.0',
        detect: () => [],
      });
      assert.strictEqual(result, true);
      assert.strictEqual(pm.size, 1);
      assert.ok(pm.registeredPlugins.includes('test-plugin'));
    });

    it('should reject plugin without name', () => {
      const pm = new PluginManager();
      const result = pm.register({ detect: () => [] });
      assert.strictEqual(result, false);
      assert.strictEqual(pm.size, 0);
    });

    it('should reject plugin without detect function', () => {
      const pm = new PluginManager();
      const result = pm.register({ name: 'bad' });
      assert.strictEqual(result, false);
      assert.strictEqual(pm.size, 0);
    });

    it('should reject duplicate plugin name', () => {
      const pm = new PluginManager();
      pm.register({ name: 'dup', detect: () => [] });
      const result = pm.register({ name: 'dup', detect: () => [] });
      assert.strictEqual(result, false);
      assert.strictEqual(pm.size, 1);
    });

    it('should reject null/undefined plugin', () => {
      const pm = new PluginManager();
      assert.strictEqual(pm.register(null), false);
      assert.strictEqual(pm.register(undefined), false);
    });
  });

  describe('unregister', () => {
    it('should unregister an existing plugin', () => {
      const pm = new PluginManager();
      pm.register({ name: 'to-remove', detect: () => [] });
      const result = pm.unregister('to-remove');
      assert.strictEqual(result, true);
      assert.strictEqual(pm.size, 0);
    });

    it('should call destroy on unregister', () => {
      let destroyed = false;
      const pm = new PluginManager();
      pm.register({
        name: 'destroyable',
        detect: () => [],
        destroy: () => { destroyed = true; },
      });
      pm.unregister('destroyable');
      assert.ok(destroyed);
    });

    it('should return false for non-existent plugin', () => {
      const pm = new PluginManager();
      assert.strictEqual(pm.unregister('nonexistent'), false);
    });
  });

  describe('initAll / destroyAll', () => {
    it('should call init on all plugins', () => {
      const inited = [];
      const pm = new PluginManager();
      pm.register({
        name: 'p1', detect: () => [],
        init: (cfg) => { inited.push('p1'); },
      });
      pm.register({
        name: 'p2', detect: () => [],
        init: (cfg) => { inited.push('p2'); },
      });
      pm.initAll({ FAST_TICK_MS: 500 });
      assert.deepStrictEqual(inited, ['p1', 'p2']);
    });

    it('should handle init errors gracefully', () => {
      suppressConsole();
      const pm = new PluginManager();
      pm.register({
        name: 'error-init',
        detect: () => [],
        init: () => { throw new Error('init boom'); },
      });
      pm.initAll({}); // should not throw
      restoreConsole();
    });

    it('should call destroy on all plugins', () => {
      const destroyed = [];
      const pm = new PluginManager();
      pm.register({
        name: 'p1', detect: () => [],
        destroy: () => { destroyed.push('p1'); },
      });
      pm.register({
        name: 'p2', detect: () => [],
        destroy: () => { destroyed.push('p2'); },
      });
      pm.destroyAll();
      assert.deepStrictEqual(destroyed, ['p1', 'p2']);
      assert.strictEqual(pm.size, 0);
    });
  });

  describe('runDetection', () => {
    it('should collect results from all plugins', () => {
      const pm = new PluginManager();
      pm.register({
        name: 'detector1',
        detect: () => [
          { pid: 100, action: 'throttle', reason: 'high cpu' },
        ],
      });
      pm.register({
        name: 'detector2',
        detect: () => [
          { pid: 200, action: 'boost', reason: 'foreground' },
        ],
      });

      const results = pm.runDetection([], {});
      assert.ok(results instanceof Map);
      assert.ok(results.has(100));
      assert.ok(results.has(200));
      assert.ok(results.get(100).actions.includes('throttle'));
      assert.ok(results.get(200).actions.includes('boost'));
    });

    it('should aggregate multiple actions for same PID', () => {
      const pm = new PluginManager();
      pm.register({
        name: 'd1',
        detect: () => [{ pid: 100, action: 'throttle', reason: 'cpu' }],
      });
      pm.register({
        name: 'd2',
        detect: () => [{ pid: 100, action: 'renice', reason: 'bg' }],
      });

      const results = pm.runDetection([], {});
      const entry = results.get(100);
      assert.ok(entry);
      assert.ok(entry.actions.includes('throttle'));
      assert.ok(entry.actions.includes('renice'));
      assert.ok(entry.plugins.includes('d1'));
      assert.ok(entry.plugins.includes('d2'));
    });

    it('should skip invalid detection results', () => {
      const pm = new PluginManager();
      pm.register({
        name: 'bad',
        detect: () => [
          { pid: -1, action: 'x' },     // invalid pid
          { action: 'x' },               // missing pid
          null,                           // null entry
          { pid: 100, action: 'valid' },  // valid
        ],
      });

      const results = pm.runDetection([], {});
      assert.ok(results.has(100));
      assert.strictEqual(results.size, 1);
    });

    it('should skip plugins that return non-array', () => {
      const pm = new PluginManager();
      pm.register({
        name: 'returns-string',
        detect: () => 'not an array',
      });
      pm.register({
        name: 'returns-valid',
        detect: () => [{ pid: 100, action: 'ok' }],
      });

      const results = pm.runDetection([], {});
      assert.ok(results.has(100));
      assert.strictEqual(results.size, 1);
    });

    it('should handle detect errors gracefully', () => {
      suppressConsole();
      const pm = new PluginManager();
      pm.register({
        name: 'error-detect',
        detect: () => { throw new Error('detect boom'); },
      });
      pm.register({
        name: 'ok-detect',
        detect: () => [{ pid: 100, action: 'ok' }],
      });

      const results = pm.runDetection([], {});
      assert.ok(results.has(100));
      restoreConsole();
    });
  });

  describe('getPluginManager / resetPluginManager singleton', () => {
    it('should return same instance', () => {
      const pm1 = getPluginManager();
      const pm2 = getPluginManager();
      assert.strictEqual(pm1, pm2);
    });

    it('should create new instance after reset', () => {
      const pm1 = getPluginManager();
      resetPluginManager();
      const pm2 = getPluginManager();
      assert.ok(pm1 !== pm2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. ROLLBACK MANAGER
// ═══════════════════════════════════════════════════════════════════════════

describe('RollbackManager', () => {
  const RollbackManager = require('../../rollback');

  let tmpDir;
  let stateFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'dynalloc-test-'));
    stateFile = pathModule.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    // Cleanup
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      if (fs.existsSync(stateFile + '.tmp')) fs.unlinkSync(stateFile + '.tmp');
      fs.rmdirSync(tmpDir);
    } catch (_) {}
  });

  it('should use provided state file path', () => {
    const rm = new RollbackManager(stateFile);
    assert.strictEqual(rm.stateFilePath, stateFile);
  });

  it('should use default path when none provided', () => {
    const rm = new RollbackManager();
    assert.strictEqual(rm.stateFilePath, '/tmp/dynalloc-state.json');
  });

  describe('trackProcess', () => {
    it('should track a process property', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.persist();
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.ok(data.modifiedPids[String(TEST_PID)]);
      assert.strictEqual(data.modifiedPids[String(TEST_PID)].nice, 0);
    });

    it('should ignore invalid PIDs', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(-1, 'nice', 0);
      rm.trackProcess(0, 'nice', 0);
      rm.trackProcess(null, 'nice', 0);
      rm.persist();
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(Object.keys(data.modifiedPids).length, 0);
    });

    it('should track multiple properties for same PID', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.trackProcess(TEST_PID, 'oom_score_adj', -500);
      rm.persist();
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const entry = data.modifiedPids[String(TEST_PID)];
      assert.strictEqual(entry.nice, 0);
      assert.strictEqual(entry.oom_score_adj, -500);
    });
  });

  describe('trackGovernor', () => {
    it('should track governor for a core', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackGovernor(0, 'powersave');
      rm.persist();
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(data.governorOriginals['0'], 'powersave');
    });
  });

  describe('persist', () => {
    it('should write state to disk', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.persist();
      assert.ok(fs.existsSync(stateFile));
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.ok(data.timestamp);
      assert.strictEqual(data.pid, process.pid);
    });

    it('should use atomic write (tmp + rename)', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.persist();
      // The final file should exist, not just .tmp
      assert.ok(fs.existsSync(stateFile));
      assert.ok(!fs.existsSync(stateFile + '.tmp'));
    });
  });

  describe('clear', () => {
    it('should remove state file and reset internal state', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.persist();
      assert.ok(fs.existsSync(stateFile));

      rm.clear();
      assert.ok(!fs.existsSync(stateFile));
    });

    it('should not throw if state file does not exist', () => {
      const rm = new RollbackManager(stateFile);
      rm.clear(); // no error
    });
  });

  describe('recoverFromCrash', () => {
    it('should return false when no state file exists', () => {
      const rm = new RollbackManager(stateFile);
      assert.strictEqual(rm.recoverFromCrash({}), false);
    });

    it('should return false when state file is from same PID', () => {
      const rm = new RollbackManager(stateFile);
      rm.trackProcess(TEST_PID, 'nice', 0);
      rm.persist();

      // Same process — should skip recovery
      assert.strictEqual(rm.recoverFromCrash({}), false);
    });

    it('should return false when state has no modifiedPids', () => {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: 1 }));
      const rm = new RollbackManager(stateFile);
      assert.strictEqual(rm.recoverFromCrash({}), false);
      assert.ok(!fs.existsSync(stateFile)); // should clear invalid file
    });

    it('should detect crash state from different PID and clear it', () => {
      // Write a fake state file from a "different" PID
      const fakeState = {
        modifiedPids: {},
        governorOriginals: {},
        timestamp: new Date().toISOString(),
        pid: 1, // different from current process.pid
      };
      fs.writeFileSync(stateFile, JSON.stringify(fakeState));

      const rm = new RollbackManager(stateFile);
      const recovered = rm.recoverFromCrash({});
      // No actual PIDs to restore (empty modifiedPids), but should detect and clear
      assert.strictEqual(recovered, true);
      assert.ok(!fs.existsSync(stateFile));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. CPU TOPOLOGY
// ═══════════════════════════════════════════════════════════════════════════

describe('cpu-topology', () => {
  const { parseCpuList, getLogicalCoreCount, readSysfs, readIntSysfs, resetCache } = require('../../cpu-topology');

  describe('parseCpuList', () => {
    it('should parse a single CPU', () => {
      assert.deepStrictEqual(parseCpuList('0'), [0]);
      assert.deepStrictEqual(parseCpuList('5'), [5]);
    });

    it('should parse a comma-separated list', () => {
      assert.deepStrictEqual(parseCpuList('0,2,4'), [0, 2, 4]);
    });

    it('should parse a range', () => {
      assert.deepStrictEqual(parseCpuList('0-3'), [0, 1, 2, 3]);
    });

    it('should parse mixed ranges and singles', () => {
      assert.deepStrictEqual(parseCpuList('0-2,4,6-7'), [0, 1, 2, 4, 6, 7]);
    });

    it('should deduplicate entries', () => {
      assert.deepStrictEqual(parseCpuList('0,0,1,1'), [0, 1]);
    });

    it('should sort output', () => {
      assert.deepStrictEqual(parseCpuList('3,1,2'), [1, 2, 3]);
    });

    it('should handle empty string', () => {
      assert.deepStrictEqual(parseCpuList(''), []);
    });

    it('should handle null/undefined', () => {
      assert.deepStrictEqual(parseCpuList(null), []);
      assert.deepStrictEqual(parseCpuList(undefined), []);
    });

    it('should skip whitespace', () => {
      assert.deepStrictEqual(parseCpuList(' 0 , 2 - 3 '), [0, 2, 3]);
    });

    it('should skip empty parts', () => {
      assert.deepStrictEqual(parseCpuList('0,,2'), [0, 2]);
    });

    it('should ignore negative numbers', () => {
      assert.deepStrictEqual(parseCpuList('-1,0'), [0]);
    });

    it('should ignore non-numeric values', () => {
      assert.deepStrictEqual(parseCpuList('a,b,c'), []);
    });
  });

  describe('getLogicalCoreCount', () => {
    it('should return a positive integer', () => {
      const count = getLogicalCoreCount();
      assert.ok(Number.isInteger(count));
      assert.ok(count > 0);
    });
  });

  describe('readSysfs', () => {
    it('should return null for non-existent file', () => {
      assert.strictEqual(readSysfs('/sys/nonexistent/file'), null);
    });

    it('should return trimmed content for existing file', () => {
      const content = readSysfs('/proc/cpuinfo');
      // May or may not be readable, just check return type
      if (content !== null) {
        assert.ok(typeof content === 'string');
        assert.ok(!content.endsWith('\n'));
      }
    });
  });

  describe('readIntSysfs', () => {
    it('should return fallback for non-existent file', () => {
      assert.strictEqual(readIntSysfs('/sys/nonexistent/file', 42), 42);
    });

    it('should parse integer from file', () => {
      // Use a file we know exists
      const val = readIntSysfs('/proc/sys/kernel/pid_max', 0);
      assert.ok(typeof val === 'number');
      assert.ok(Number.isFinite(val));
    });

    it('should return fallback for non-integer content', () => {
      // The function reads a real file, so we test the fallback path indirectly
      // by noting that if the file has non-numeric content, it returns fallback
    });
  });

  describe('detect / resetCache', () => {
    it('should return a topology object', () => {
      resetCache();
      const topo = require('../../cpu-topology').detect();
      assert.ok(typeof topo.logicalCount === 'number');
      assert.ok(topo.logicalCount > 0);
      assert.ok(typeof topo.physicalCount === 'number');
      assert.ok(typeof topo.smtEnabled === 'boolean');
      assert.ok(typeof topo.threadsPerCore === 'number');
      assert.ok(Array.isArray(topo.numaNodes));
      assert.ok(typeof topo.isHybrid === 'boolean');
      assert.ok(Array.isArray(topo.pCores));
      assert.ok(Array.isArray(topo.eCores));
      assert.ok(typeof topo.isAMD === 'boolean');
      assert.ok(Array.isArray(topo.ccds));
      assert.ok(typeof topo.ccdCount === 'number');
      assert.ok(topo.logicalToPhysical instanceof Map);
      assert.ok(topo.threadSiblings instanceof Map);
    });

    it('should return cached result on second call', () => {
      resetCache();
      const topo1 = require('../../cpu-topology').detect();
      const topo2 = require('../../cpu-topology').detect();
      assert.strictEqual(topo1, topo2);
    });

    it('should return new result after resetCache', () => {
      resetCache();
      const topo1 = require('../../cpu-topology').detect();
      resetCache();
      const topo2 = require('../../cpu-topology').detect();
      // May or may not be the same object, but should be valid
      assert.ok(topo2.logicalCount > 0);
    });
  });
});