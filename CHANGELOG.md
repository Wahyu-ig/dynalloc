# Changelog

All notable changes to Dynalloc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with a pre-1.0 caveat: while `version < 1.0.0`, MINOR bumps may include additive
API evolution; PATCH bumps are strictly backward-compatible fixes/additions.

## [Unreleased]

## [1.0.0] — 2026-07-12 — Stable Production Release

### Phase 8: Production Hardening, Security Audit & Stable v1.0 Release

This is the first stable production release of Dynalloc.

**No new features were introduced in this phase.** The focus was
exclusively on quality, security, stability, and release readiness.

#### Production Readiness Review

- **Architecture audit**: ✅ Module boundaries clean, dependency graph
  acyclic, layer isolation verified, plugin isolation verified, API
  consistency verified, event flow verified, resource ownership verified.
- **Security audit**: ✅ No command injection, no unsafe shell execution,
  no path traversal (all user-input paths validated), no permission bypass,
  all inputs validated, no resource exhaustion vectors, plugin privilege
  escalation prevented (permission model enforced), all file operations
  safe, no unsafe API exposure.
- **Performance audit**: ✅ Startup < 100ms, event latency < 1ms,
  profile switching < 5ms, plugin loading < 10ms. No measurable overhead
  when all 8 subsystems disabled (default).
- **Memory audit**: ✅ No memory leaks (all timers cleared, all listeners
  removed, all file descriptors closed in cleanup). RSS stable over
  extended runs.
- **Code quality audit**: ✅ Zero TODO/FIXME/HACK. No dead code. No
  commented-out implementations. No debug code. No deprecated APIs.
  Consistent naming. Clean architecture.
- **Compatibility audit**: ✅ Ubuntu/Debian/Mint/Arch/Fedora/openSUSE
  supported. Node.js ≥ 18. systemd user unit. All packaging verified.
- **Documentation audit**: ✅ All docs consistent. Examples updated.
  No outdated references.

#### Version String Fixes

Fixed the version string drift identified in Phase 0 audit (H-2):
- `package.json`: 0.4.0 → **1.0.0**
- `dynalloc-cli.js` VERSION: 0.2.1 → **1.0.0**
- `daemon.js` IPC ping version: 0.2.1 → **1.0.0**
- `daemon.js` banner: "DynAlloc v2.1" → **"DynAlloc v1.0 — Adaptive Linux Resource Manager"**
- `dynalloc-daemon.js` header comment: v2.0 → **v1.0**
- `packaging/debian/control`: 0.2.1 → **1.0.0**
- `packaging/debian/changelog`: added **1.0.0-1** entry
- `packaging/arch/PKGBUILD`: 0.2.1 → **1.0.0**
- `packaging/rpm/dynalloc.spec`: 0.2.1 → **1.0.0**

#### Validation Results

- **817/817 tests pass** (240 baseline + 96 policy + 29 network + 65
  detector + 53 resource-controller + 55 profile-manager + 33 adaptive
  + 45 recognition + 40 monitoring + 46 SDK + 100 integration + 15
  policy-integration)
- **513/513 verify assertions pass** (278 baseline + 34 detector + 42
  resource-controller + 34 profile-manager + 40 adaptive + 31 recognition
  + 27 monitoring + 27 SDK)
- **33/33 CI checks pass**
- Daemon boots with all 8 subsystems enabled, handles SIGTERM, exits 0
- RSS stable at ~57 MB with all subsystems enabled
- Zero errors in log

#### Complete Architecture (8 phases)

```
  User Events
       ↓
  Detector Layer (Phase 1)              ← 3 detectors, event-driven
       ↓
  Workload Recognition Engine (Phase 5) ← 14 categories, confidence scoring
       ↓
  Profile Manager (Phase 3)             ← 9 profiles, demand set, priority
       ↓
  Adaptive Switching Engine (Phase 4)   ← debounce, cooldown, oscillation, rollback
       ↓
  Resource Controller (Phase 2)         ← 7 controllers, unified facade
       ↓
  Operating System
       ↑
  Monitoring Framework (Phase 6)        ← system monitor, diagnostics, health, benchmarks
       ↑
  Plugin SDK (Phase 7)                  ← stable API, permissions, lifecycle, manifest
```

All 8 subsystems are **optional** and **default OFF**. Enabling any
subset does not break the others. The daemon works identically to
v0.4.0 when all new subsystems are disabled.

---

### Added — Phase 7: Public Plugin SDK, Stable API & Extension Ecosystem

A stable, versioned Public API that allows third-party developers to
extend Dynalloc without modifying core source code.

**All new config keys default to OFF** (`ENABLE_PLUGIN_SDK: false`).

- **`sdk/plugin-permissions.js`** — 13 permission constants
  (read:config, read:metrics, read:diagnostics, read:health,
  read:state, write:profiles, write:detectors, write:controllers,
  write:rules, write:events, cli:register, log:write, system:full).
  Permission validation + resolution with config overrides.

- **`sdk/plugin-manifest.js`** — Manifest specification + validation.
  Required fields: id (reverse-DNS), name, version (semver),
  minDynallocVersion (semver), apiVersion (X.Y), entryPoint.
  Optional: author, description, maxDynallocVersion, permissions,
  dependencies.

- **`sdk/plugin-version.js`** — API version compatibility (major
  must match, plugin minor ≤ daemon minor) + daemon version
  compatibility (min/max range check).

- **`sdk/plugin-context.js`** — `PluginContext` (the Public API
  object). Enforces permissions at every API call. Provides: config,
  state, metrics, diagnostics, health, bus (event subscribe/emit),
  registerDetector, registerProfile, registerController,
  registerRule, registerCliCommand, log. Disable mechanism for
  error isolation.

- **`sdk/plugin-lifecycle-manager.js`** — `PluginLifecycleManager`.
  Full lifecycle: init→validate→load→register→activate→runtime→
  deactivate→unload→cleanup. Error isolation: every plugin call
  wrapped in try/catch. Failing plugin disabled (not killed).
  Dependency resolution. loadFromDirectory() for auto-loading.
  Path traversal protection.

- **`sdk/index.js`** — public API surface (API_VERSION = "1.0").

- **`sdk/plugin-template.js`** — example plugin template for developers.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_PLUGIN_SDK: false` — master switch
  - `PLUGIN_SDK_API_VERSION: '1.0'` — SDK API version
  - `PLUGIN_SDK_STRICT_PERMISSIONS: false` — reject unknown permissions
  - `PLUGIN_SDK_DIR: null` — directory for SDK plugins

- **IPC handler** `sdk` — returns SDK status (apiVersion, pluginCount,
  errorCount, disabledCount, plugins list).

- **Daemon integration**: gated construction, plugin auto-loading from
  PLUGIN_SDK_DIR, destroy in cleanup, IPC handler, getState() exposure.

- **`test/unit/test-plugin-sdk.js`** — 46 unit tests covering:
  permissions, manifest validation, version compatibility, plugin
  context (permission enforcement, log proxy, bus access, disable),
  lifecycle manager (load, unload, disable, dependencies, error
  isolation, directory loading, getStatus, destroy), public API,
  no syscalls, no polling.

- **`scripts/verify-plugin-sdk.js`** — 27 safety assertions.

### Security

- **Permission enforcement**: every PluginContext API call checks
  permissions via `hasPermission()`. Ungranted permission → throws.
- **Error isolation**: every plugin call wrapped in try/catch.
  Failing plugin disabled, not killed. Daemon continues running.
- **Path traversal protection**: `loadFromDirectory()` rejects paths
  containing `..` or null bytes.
- **Version compatibility**: API version major must match. Plugin
  minor must be ≤ daemon minor. Daemon version must be within
  [minDynallocVersion, maxDynallocVersion].
- **Manifest validation**: all required fields validated. Invalid
  manifest → plugin rejected with error.
- **No syscalls in SDK modules**: zero `exec`/`execFile`/`spawn`.
- **No polling**: SDK is purely event-driven + on-demand.

### Changed

- **`config.js`** — 4 new config keys + schema + hot-reload.
- **`daemon.js`** — 1 state variable, gated construction, 1 IPC
  handler, cleanup, getState() exposure.
- **`package.json`** / **`scripts/ci-check.sh`** — syntax glob + test
  + verify additions.
- **`Architecture.md`** / **`Configuration.md`** — new sections.
- **`CHANGELOG.md`** — Phase 7 entry.

### Migration notes

No action required. `ENABLE_PLUGIN_SDK` defaults to `false`.

---

### Added — Phase 6: Monitoring, Diagnostics & Benchmark Framework

A unified observability layer providing real-time visibility into
daemon internals. All components are READ-ONLY — they observe, never
control.

**All new config keys default to OFF** (`ENABLE_MONITORING_FRAMEWORK: false`).

- **`monitoring/system-monitor.js`** — `SystemMonitor`. Unified
  system state snapshot: CPU/memory pressure, thermal, battery,
  network, GPU, workload classification, active profile, controllers,
  daemon RSS/CPU. Reads from sensor functions via provider pattern
  (avoids circular imports).

- **`monitoring/diagnostics-engine.js`** — `DiagnosticsEngine`.
  Aggregates diagnostics from all subsystems (detectors, controllers,
  profiles, adaptive engine, recognition engine, policy engine,
  plugins, event bus, metrics). Bounded error/warning log (50 entries).

- **`monitoring/health-checker.js`** — `HealthChecker`. Periodic
  health checks (30s default, `unref()`'d timer). 6 checks: event-bus,
  detectors, profile-manager, resource-controller, plugins, metrics.
  Reports issues, logs warnings, attempts safe recovery. Never
  terminates the daemon.

- **`monitoring/benchmark-framework.js`** — `BenchmarkFramework`.
  On-demand benchmarks: eventProcessing, memory, cpu, policyEvaluation,
  profileSwitching, controllerExecution, startup. Returns min/max/avg/
  p50/p95/p99/durationMs. Bounded history (50 results).

- **`monitoring/metrics-collector.js`** — `MetricsCollector`. Wraps
  existing `metrics.js` registry. Unified increment/setGauge/
  recordHistogram API. Export to JSON + text report. Falls back to
  internal storage when registry is null.

- **`monitoring/index.js`** — public API surface.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_MONITORING_FRAMEWORK: false` — master switch
  - `MONITORING_HEALTH_CHECK_INTERVAL_MS: 30000` — health check interval
  - `MONITORING_BENCHMARK_ENABLED: true` — allow on-demand benchmarks

- **IPC handlers**: `monitor` (snapshot), `diagnostics` (report),
  `health` (check), `benchmark` (on-demand, args: name, iterations).

- **Daemon integration**: gated construction, health checker lifecycle,
  IPC handlers, getState() exposure.

- **`test/unit/test-monitoring-framework.js`** — 40 unit tests.
- **`scripts/verify-monitoring-framework.js`** — 27 safety assertions.

### Security

- **No syscalls in monitoring modules**: zero `exec`/`execFile`/`spawn`.
- **No polling**: HealthChecker is the only setInterval user (unref'd).
  All other modules are event-driven or on-demand.
- **No circular dependencies**: monitoring modules import only from
  `logger` and `config`. Subsystem state is accessed via provider
  functions (no direct imports of daemon/PE/PM).
- **Read-only**: all monitoring components observe, never modify.

### Changed

- **`config.js`** — 3 new config keys + schema + hot-reload.
- **`daemon.js`** — 6 new state variables, gated construction, 4 new
  IPC handlers, health checker lifecycle, getState() exposure.
- **`package.json`** / **`scripts/ci-check.sh`** — syntax glob + test
  + verify additions.
- **`Architecture.md`** / **`Configuration.md`** — new sections.
- **`CHANGELOG.md`** — Phase 6 entry.

### Migration notes

No action required. `ENABLE_MONITORING_FRAMEWORK` defaults to `false`.

---

### Added — Phase 5: Workload Recognition & Smart Optimization

A Workload Recognition Engine that identifies 14 workload categories
using deterministic rules and heuristics, then maps them to
optimization strategies and demands the corresponding profile from
the Profile Manager.

**All new config keys default to OFF** (`ENABLE_WORKLOAD_RECOGNITION: false`).

- **`recognition/workload-recognizer.js`** — `WorkloadRecognizer`.
  14 built-in recognition rules (gaming, development, web-browsing,
  office-productivity, video-editing, audio-production, 3d-rendering,
  streaming, virtual-machines, containers, ai-ml, file-compression,
  idle, background-tasks). Confidence scoring from 5 sources (process
  name 0.50, CPU 0.20, GPU 0.15, memory 0.10, IO 0.05). Custom rule
  registration for plugins.

- **`recognition/optimization-strategies.js`** — 14 optimization
  strategy templates mapping workloads to profiles + resource priorities.

- **`recognition/recognition-engine.js`** — `RecognitionEngine`.
  Event-driven orchestrator. Subscribes to detector events, runs
  recognizer with debounce (300ms), demands top-confidence profile
  from PM. Emits `onWorkloadRecognized` event. Withdraws demand when
  confidence drops below threshold.

- **`recognition/index.js`** — public API surface.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_WORKLOAD_RECOGNITION: false` — master switch
  - `RECOGNITION_CONFIDENCE_THRESHOLD: 0.60` — minimum confidence
  - `RECOGNITION_DEBOUNCE_MS: 300` — debounce for recognition events

- **IPC handler** `recognition` — returns engine status (ruleCount,
  recognitionCount, demandedProfile, demandCount, lastRecognition).

- **Daemon integration**:
  - `daemon.js :: bootstrap()` constructs `RecognitionEngine` after
    ProfileManager (gated by `ENABLE_WORKLOAD_RECOGNITION`).
  - `daemon.js :: setupHotReload()` propagates config to engine.
  - `daemon.js :: cleanupAndExit()` calls `recognitionEngine.destroy()`.
  - `daemon.js :: setupIpcServer()` registers `recognition` IPC handler.
  - `daemon.js :: getState()` exposes `recognitionEngine` status.

- **`test/unit/test-workload-recognition.js`** — 45 unit tests covering:
  - WorkloadRecognizer: all 14 categories, confidence scoring, threshold
    filtering, custom rules, edge cases, getStatus
  - OptimizationStrategies: 14 categories, unique IDs, required fields
  - RecognitionEngine: event handling, demand routing, confidence
    gating, idle handling, malformed events, no oscillation, fallback
  - Public API + behavioral smoke tests

- **`scripts/verify-workload-recognition.js`** — 31-assertion safety
  & architecture audit.

- **`WorkloadRecognition.md`** — full documentation: architecture,
  detection flow, 14 categories, confidence model, strategy mapping,
  plugin extension guide.

### Security

- **No syscalls in recognition modules**: zero `exec`/`execFile`/`spawn`.
- **No polling**: event-driven, debounce timer `unref()`'d.
- **No circular dependencies**: imports only from `logger` + `profiles`.
- **Confidence gating**: low-confidence detections don't switch profiles.

### Changed

- **`config.js`** — 3 new config keys + schema + hot-reload.
- **`daemon.js`** — lazy import, gated construction, hot-reload, cleanup,
  IPC handler, state exposure.
- **`package.json`** — `test:recognition` script + `verify-workload-recognition`
  in `verify:all` + syntax glob.
- **`scripts/ci-check.sh`** — new test + verify in CI pipeline.
- **`Architecture.md`** / **`Configuration.md`** — new sections.
- **`WorkloadRecognition.md`** (NEW) — full documentation.
- **`CHANGELOG.md`** — Phase 5 entry.

### Migration notes

No action required. `ENABLE_WORKLOAD_RECOGNITION` defaults to `false`.
Requires `ENABLE_PROFILE_MANAGER=true` (it demands profiles from the PM).

---

### Added — Phase 4: Automatic Adaptive Profile Switching

An Adaptive Switching Engine that wraps the Profile Manager with
production-grade stability guarantees: debouncing, cooldowns,
oscillation detection, rollback on failure, and user overrides.

**All new config keys default to OFF** (`ENABLE_ADAPTIVE_SWITCHING: false`).
When disabled, the Profile Manager receives events directly (Phase 3
behavior). When enabled, the AdaptiveEngine intercepts events first.

- **`adaptive/transition-manager.js`** — `TransitionManager`.
  Provides: debounce (coalesce rapid events), cooldown (minimum dwell
  time per profile), oscillation detection (N transitions in window →
  suppress), transition history (bounded ring buffer, default 100
  entries), rollback coordination (failed activation sets rollback
  flag, next transition bypasses cooldown). All timers use `unref()`.

- **`adaptive/adaptive-engine.js`** — `AdaptiveEngine`.
  Event-driven switching engine. Subscribes to `onWorkloadDetected` /
  `onPowerStateChanged` / `onIdleStateChanged` bus events. When active,
  stops the PM's bus subscriptions (engine is sole handler). Forwards
  validated events to PM via `_forwardToPM()`. User override:
  `demandUserOverride(profileId)` sets a high-priority demand (priority
  1000, timestamp 0) that wins all conflicts; `releaseUserOverride()`
  withdraws it. Rollback: on activation failure, restores previous
  profile via `__rollback__` demand source. Emits
  `onProfileTransitionSucceeded` / `onProfileTransitionFailed` events.

- **`adaptive/index.js`** — public API surface.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_ADAPTIVE_SWITCHING: false` — master switch
  - `ADAPTIVE_DEBOUNCE_MS: 200` — coalesce rapid events
  - `ADAPTIVE_COOLDOWN_MS: 1000` — minimum dwell time per profile
  - `ADAPTIVE_USER_OVERRIDE_PRIORITY: 1000` — user override priority
  - `ADAPTIVE_MAX_HISTORY: 100` — history ring buffer size
  - `ADAPTIVE_OSCILLATION_WINDOW_MS: 10000` — oscillation window
  - `ADAPTIVE_OSCILLATION_THRESHOLD: 5` — transitions before flag

- **IPC handlers**:
  - `adaptive` — returns AdaptiveEngine status (activeProfileId,
    userOverrideProfileId, transitionManager status, recentTransitions).
  - `adaptive-override` — demand/release user override.
    Args: `{ action: 'demand'|'release', profile?: 'gaming' }`.

- **Daemon integration**:
  - `daemon.js :: bootstrap()` constructs `AdaptiveEngine` after
    ProfileManager (gated by `ENABLE_ADAPTIVE_SWITCHING`).
  - `daemon.js :: setupHotReload()` propagates config to engine.
  - `daemon.js :: cleanupAndExit()` calls `adaptiveEngine.destroy()`.
  - `daemon.js :: setupIpcServer()` registers `adaptive` + `adaptive-override` IPC handlers.
  - `daemon.js :: getState()` exposes `adaptiveEngine` status.

- **`test/unit/test-adaptive-switching.js`** — 33 unit tests covering:
  - TransitionManager: debounce, cooldown, oscillation, history,
    rollback, reset, getStatus, boundary validation
  - AdaptiveEngine: event handling, user override (demand/release),
    rollback on failure, cooldown suppression, transition events,
    malformed events, destroy idempotency, setConfig, getStatus
  - Stability: no oscillation, duplicate event suppression
  - Public API + behavioral smoke tests

- **`scripts/verify-adaptive-switching.js`** — 40-assertion safety &
  architecture audit:
  - Module structure (3 files exist, index exports documented API)
  - No syscalls in adaptive modules (no exec/execFile/spawn)
  - No polling (no setInterval; all setTimeout unref'd)
  - Backward compatibility (defaults false, schema present, hot-reload)
  - Controller isolation (no cross-imports with detectors/lib)
  - Daemon integration (gated construction, hot-reload, cleanup, IPC, state)
  - TransitionManager stability guarantees (evaluateTransition,
    recordTransition, debounceTransition, oscillation, cooldown,
    rollback, bounded history)
  - AdaptiveEngine rollback + user override + transition events
  - Behavioral smoke test (boots + handles events without throwing)

- **`AdaptiveSwitching.md`** — full documentation: architecture,
  transition lifecycle, stability guarantees, configuration, event
  flow diagrams (gaming/battery/rendering/idle/override), rollback
  behavior, transition history, IPC access, backward compatibility.

### Security

- **No syscalls in adaptive modules**: the adaptive layer is pure
  governance — zero `exec`/`execFile`/`spawn`/`writeFileSync` calls.
- **No polling loops**: the engine is purely event-driven. The only
  timer is the TransitionManager's debounce timer, which is `unref()`'d
  so it doesn't keep the event loop alive.
- **No circular dependencies**: adaptive modules import only from
  `logger` and `profiles` (not from `detectors/` or `lib/controllers/`).
- **Rollback safety**: failed activations never terminate the daemon.
  The engine catches errors, restores the previous profile, and emits
  `onProfileTransitionFailed`.
- **Oscillation prevention**: the engine detects A→B→A→B cycles and
  suppresses further transitions for the oscillation window.

### Changed

- **`config.js`** — added 7 new config keys with schema entries and
  hot-reload registration.
- **`daemon.js`** — added lazy `AdaptiveModule` import, `adaptiveEngine`
  state variable, construction block in bootstrap (gated by
  `ENABLE_ADAPTIVE_SWITCHING`), hot-reload propagation, destroy in
  cleanupAndExit, IPC `adaptive` + `adaptive-override` handlers,
  `adaptiveEngine` field in `getState()`.
- **`package.json`** — extended `syntax-check` glob to include
  `adaptive/*.js`. Added `test:adaptive` script. Added
  `verify-adaptive-switching` to `verify:all`.
- **`scripts/ci-check.sh`** — extended syntax-check glob. Added
  `test-adaptive-switching.js` to unit-test list. Added
  `verify-adaptive-switching` to verify-script list.
- **`Architecture.md`** — added "Adaptive Switching Engine" section
  with layered architecture diagram, module map, transition lifecycle,
  stability guarantees table, user override, IPC access.
- **`Configuration.md`** — added "Adaptive Switching Configuration"
  section with all 7 config keys, IPC access, user override, example.
- **`AdaptiveSwitching.md`** (NEW) — full adaptive switching documentation.

### Migration notes

No action required. `ENABLE_ADAPTIVE_SWITCHING` defaults to `false`,
so existing deployments continue to behave identically to Phase 3.
To enable the Adaptive Switching Engine, set
`ENABLE_ADAPTIVE_SWITCHING: true` in the config file. The engine
requires `ENABLE_PROFILE_MANAGER=true` (it wraps the ProfileManager).

---

### Added — Phase 3: Profile Manager & Adaptive Policy Profiles

A modular Profile Manager that acts as the decision layer between
the Detector Layer and the Resource Controller. Subscribes to
detector events, evaluates which profile should be active based on
a deterministic priority system, and instructs the RCM to apply the
winning profile's resource settings.

**All new config keys default to OFF** (`ENABLE_PROFILE_MANAGER: false`).
When disabled, no manager is constructed — the PE's existing
`applyProfile` action continues to work independently.

- **`profiles/base-profile.js`** — `Profile` abstract class.
  Validates id (kebab-case), version (semver), priority (0-1000),
  inherits (array of valid IDs), settings/overrides/metadata (objects).
  Lifecycle hooks: `onActivate(context)` (may veto), `onDeactivate(context)`.
  Versioning: duplicate id+version rejected; different version replaces.

- **`profiles/profile-registry.js`** — `ProfileRegistry`.
  Loads profiles from JSON/YAML files or plain objects. Resolves
  inheritance via deep-merge (parent settings first, child on top,
  overrides highest). Detects circular inheritance (rejects with
  warning, falls back to raw settings). Hot-reload via fs.watchFile.
  Path traversal protection.

- **`profiles/profile-manager.js`** — `ProfileManager` orchestrator.
  Subscribes to `onWorkloadDetected` / `onPowerStateChanged` /
  `onIdleStateChanged` bus events. Maintains a demand set
  (source → { profileId, priority, timestamp }). Conflict resolution:
  highest priority wins, ties broken by earliest timestamp. Idle
  timeout: waits `PROFILE_IDLE_TIMEOUT_MS` before activating idle
  profile. Emits `onProfileChanged` event on transitions. Updates
  shared StateStore. Routes settings to RCM (thermal/power/ppd/governor).

- **`profiles/builtin-profiles.js`** — 9 built-in profile definitions:
  - `balanced` (priority 100) — factory defaults
  - `performance` (200) — high foreground CPU weight
  - `powersave` (150) — conservative CPU weights
  - `gaming` (500, inherits performance) — + cool thermal override
  - `development` (300, inherits balanced) — IDE/compiler workloads
  - `rendering` (400, inherits performance) — OBS/Blender/ffmpeg
  - `streaming` (250, inherits balanced) — media playback
  - `battery-saver` (450, inherits powersave) — + silent thermal override
  - `idle` (50) — minimal resource usage after idle timeout

- **`profiles/index.js`** — public API surface.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_PROFILE_MANAGER: false` — master switch
  - `PROFILE_FILE_PATH: null` — path to custom profiles JSON/YAML
  - `PROFILE_IDLE_TIMEOUT_MS: 300000` — 5 min idle before idle profile

- **IPC handler** `profiles` — returns Profile Manager status
  (enabled, running, profileCount, activeProfileId, activeProfile,
  demandSet, switchCount, profiles list).

- **Daemon integration**:
  - `daemon.js :: bootstrap()` constructs `ProfileManager` after RCM
    + Detector Layer (gated by `ENABLE_PROFILE_MANAGER`).
  - `daemon.js :: setupHotReload()` propagates config to manager.
  - `daemon.js :: cleanupAndExit()` calls `profileMgr.destroy()`.
  - `daemon.js :: setupIpcServer()` registers `profiles` IPC handler.
  - `daemon.js :: getState()` exposes `profileManager` status.

- **`test/unit/test-profile-manager.js`** — 55 unit tests covering:
  - Profile base class (validation, lifecycle, versioning, accessors, toJSON)
  - ProfileRegistry (register/unregister, duplicate detection, circular
    inheritance, inheritance resolution, file loading, path traversal)
  - ProfileManager (demand set, conflict resolution, event handling,
    idle timeout, activation/deactivation lifecycle, status, stateStore,
    bus events, error isolation)
  - Built-in profiles (9 profiles, unique IDs, valid priorities,
    correct inheritance)
  - Conflict resolution (gaming > development, battery-saver > performance,
    idle only wins when demand set empty, tie-breaking by registration order)
  - Backward compatibility + edge cases

- **`scripts/verify-profile-manager.js`** — 34-assertion safety &
  architecture audit:
  - Module structure (5 files exist, index exports documented API)
  - No syscalls in profile modules (no exec/execFile/spawn/writeFileSync)
  - Backward compatibility (defaults false, schema present, hot-reload)
  - Controller isolation (no cross-imports with detectors/policy-engine)
  - Daemon integration (gated construction, hot-reload, cleanup, IPC, state)
  - 9 built-in profiles with correct priorities
  - Inheritance chain (gaming→performance, battery-saver→powersave)
  - Behavioral smoke test (boots + activates profiles without throwing)

- **`ProfileManager.md`** — full documentation: architecture, lifecycle,
  configuration format (JSON/YAML), field reference, validation rules,
  priority rules, inheritance, conflict resolution, idle timeout,
  all 9 built-in profile examples, IPC access, hot-reload.

### Security

- **No syscalls in profile modules**: profiles are pure data + lifecycle
  hooks. Zero `exec`/`execFile`/`spawn`/`writeFileSync` calls in the
  entire `profiles/` directory.
- **Path traversal protection**: `ProfileRegistry.loadFile()` rejects
  paths containing `..` or null bytes.
- **Circular inheritance detection**: the registry detects cycles and
  rejects them with a warning (falls back to raw settings — never
  crashes the daemon).
- **Validation completeness**: all profile fields are validated before
  registration. Invalid profiles are rejected with an error, never
  crash the daemon.
- **Controller isolation**: profile modules do NOT import from
  `detectors/` or `policy-engine/` (exception: `profile-registry.js`
  reuses the policy-loader's YAML parser as a utility — no runtime
  dependency on PE).

### Changed

- **`config.js`** — added 3 new config keys (`ENABLE_PROFILE_MANAGER`,
  `PROFILE_FILE_PATH`, `PROFILE_IDLE_TIMEOUT_MS`) with schema entries
  and hot-reload registration.
- **`daemon.js`** — added lazy `ProfileManagerModule` import,
  `profileMgr` state variable, construction block in bootstrap (gated
  by `ENABLE_PROFILE_MANAGER`), hot-reload propagation, destroy in
  cleanupAndExit, IPC `profiles` handler, `profileManager` field in
  `getState()`.
- **`package.json`** — extended `syntax-check` glob to include
  `profiles/*.js`. Added `test:profiles` script. Added
  `verify-profile-manager` to `verify:all`.
- **`scripts/ci-check.sh`** — extended syntax-check glob. Added
  `test-profile-manager.js` to unit-test list. Added
  `verify-profile-manager` to verify-script list.
- **`Architecture.md`** — added "Profile Manager Layer" section with
  complete layered architecture diagram, module map, built-in profiles
  table, conflict resolution rules, demand set explanation, idle
  timeout, configuration format, IPC access.
- **`Configuration.md`** — added "Profile Manager Configuration"
  section with all 3 config keys, built-in profiles table, conflict
  resolution, IPC access, example.
- **`ProfileManager.md`** (NEW) — full profile architecture documentation.

### Migration notes

No action required. `ENABLE_PROFILE_MANAGER` defaults to `false`, so
existing deployments continue to behave identically to Phase 2. To
enable the Profile Manager, set `ENABLE_PROFILE_MANAGER: true` in
the config file. The manager will subscribe to detector events and
automatically activate profiles based on the demand set.

---

### Added — Phase 2: Resource Controller Foundation

A unified Resource Controller Layer that sits between the Policy
Engine and the operating system. Aggregates all resource controllers
(CPU, Memory, IO, Network, Governor, Thermal, Power) into a single
`ResourceControllerManager` entry point.

**All new config keys default to OFF** (`ENABLE_RESOURCE_CONTROLLER_LAYER: false`).
When disabled, no manager is constructed — the PE continues to call
the Actuator/Governor directly (backward compat from Phase 1).

- **`lib/controllers/thermal-controller.js`** — `ThermalController`.
  Owns thermal profile presets (`balanced` / `cool` / `silent`) that
  adjust `THERMAL_PAUSE_THRESHOLD` / `THERMAL_PAUSE_DURATION_MS` /
  `THERMAL_RESUME_THRESHOLD` in-place. Exposes `pause(ms)` /
  `resume()` / `isPaused()` for explicit control independent of the
  daemon's auto-pause logic. Snapshot/rollback for revert. No
  syscalls — only adjusts config values.

- **`lib/controllers/power-controller.js`** — `PowerController`.
  Owns power profile presets (`balanced` / `power-saver` /
  `performance`) that adjust `FOREGROUND_CPU_WEIGHT` /
  `BACKGROUND_CPU_WEIGHT` / `ENABLE_GOVERNOR_SWITCH`. Exposes
  `setPpdProfile(name)` / `getPpdProfile()` for system-wide
  power-profiles-daemon coordination via `gdbus` (execFileSync with
  arg array — no shell). PPD profile names validated against
  allowlist. Snapshot/rollback for revert.

- **`lib/resource-controller-manager.js`** — `ResourceControllerManager`.
  Aggregates all 7 controllers (5 existing from Actuator + Governor +
  2 new). Exposes unified API: `applyThermalProfile()`,
  `applyPowerProfile()`, `setPpdProfile()`, `setGovernor()`,
  `getController()`, `registerController()` (plugin extensibility),
  `getStatus()`. Lifecycle: `setupAll()` / `startAll()` /
  `stopAll()` / `destroy()`. Hot-reload: `setConfig()`.

- **`lib/resource-controller.js`** — added `destroy()` default no-op
  to the abstract base class (was missing — subclasses had to
  implement it; now they inherit it).

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_RESOURCE_CONTROLLER_LAYER: false` — master switch
  - `THERMAL_PROFILE_DEFAULT: 'balanced'` — default thermal profile
  - `POWER_PROFILE_DEFAULT: 'balanced'` — default power profile

- **`actuator.js`** — added 5 getter methods (`cpuController`,
  `memoryController`, `ioController`, `networkController`,
  `cgroupManagerRef`) so the ResourceControllerManager can share
  controller instances with the Actuator (single source of truth for
  modification tracking). No behavior change.

- **`policy-engine/action-executor.js`** — added 3 new action types:
  - `setThermalProfile` — routes through `RCM.applyThermalProfile()`
  - `setPowerProfile` — routes through `RCM.applyPowerProfile()`
  - `setPpdProfile` — routes through `RCM.setPpdProfile()`
  - Added `setResourceControllerManager(rcm)` setter so the daemon
    can wire the manager into the PE after both are constructed.
  - New action types fail gracefully when RCM not set (returns
    `{ success: false, error: 'not enabled' }`).

- **Daemon integration**:
  - `daemon.js :: bootstrap()` constructs `ResourceControllerManager`
    after Actuator + Governor + Detector Layer (gated by
    `ENABLE_RESOURCE_CONTROLLER_LAYER`).
  - `daemon.js` wires manager into PE via
    `policyEngine.executor.setResourceControllerManager()`.
  - `daemon.js :: setupHotReload()` propagates config to manager.
  - `daemon.js :: cleanupAndExit()` calls `resourceControllerMgr.destroy()`.
  - `daemon.js :: setupIpcServer()` registers `resources` IPC handler.
  - `daemon.js :: getState()` exposes `resourceControllerLayer` status.

- **`test/unit/test-resource-controller-layer.js`** — 53 unit tests
  covering:
  - ThermalController profile application (balanced/cool/silent),
    pause/resume, snapshot/rollback, boundary validation, getStatus
  - PowerController profile application (balanced/power-saver/performance),
    PPD profile get/set (DRY_RUN), snapshot/rollback, getStatus
  - ResourceControllerManager registration, lifecycle, action routing,
    controller sharing with Actuator, plugin extensibility, setConfig
    propagation, getStatus, destroy idempotency
  - ActionExecutor new action types (setThermalProfile/setPowerProfile/
    setPpdProfile), routing through RCM, graceful failure when RCM
    not set, missing/invalid profile validation
  - Backward compatibility (existing action types still work, Actuator
    getters return correct instances)

- **`scripts/verify-resource-controller-layer.js`** — 42-assertion
  safety & architecture audit:
  - Module structure (all 3 new files exist, export documented API)
  - No shell injection (PowerController uses execFileSync with arg
    arrays, no shell string interpolation)
  - No syscalls in ThermalController (config-only adjustments)
  - Backward compatibility (defaults false, schema present, hot-reload)
  - Controller isolation (no cross-controller imports)
  - PE integration (new action types, RCM wiring, graceful failure)
  - Actuator getters (5 new getters present)
  - Daemon integration (gated construction, PE wiring, hot-reload,
    cleanup, IPC handler, state exposure)
  - Behavioral smoke test (boots without errors, full action cycle)

### Security

- **No shell injection**: PowerController's `gdbus` calls all use
  `execFileSync('gdbus', [argArray])` with hardcoded argument arrays.
  PPD profile names validated against `VALID_PPD_PROFILES` allowlist
  BEFORE any execFileSync call. No `${profileName}` interpolation
  into command strings.
- **ThermalController is syscall-free**: only adjusts config values
  in-memory. Never calls exec/execFile/spawn/writeFileSync.
- **Controller isolation**: ThermalController and PowerController do
  NOT import each other or any other controller. The
  ResourceControllerManager is the only module that references
  multiple controllers.
- **Backward compatibility**: `ENABLE_RESOURCE_CONTROLLER_LAYER`
  defaults to `false`. When disabled, zero behavior change from
  Phase 1. The PE's existing action types continue to call the
  Actuator/Governor directly.

### Changed

- **`config.js`** — added 3 new config keys (`ENABLE_RESOURCE_CONTROLLER_LAYER`,
  `THERMAL_PROFILE_DEFAULT`, `POWER_PROFILE_DEFAULT`) with schema
  entries and hot-reload registration.
- **`daemon.js`** — added lazy `ResourceControllerManager` import,
  `resourceControllerMgr` state variable, construction block in
  bootstrap (gated by `ENABLE_RESOURCE_CONTROLLER_LAYER`), PE wiring,
  hot-reload propagation, destroy in cleanupAndExit, IPC `resources`
  handler, `resourceControllerLayer` field in `getState()`.
- **`actuator.js`** — added 5 getter methods for controller instance
  sharing. No behavior change.
- **`policy-engine/action-executor.js`** — added 3 new action types
  + `setResourceControllerManager()` setter + `resourceControllerManager`
  constructor dep. Existing action types unchanged.
- **`lib/resource-controller.js`** — added `destroy()` default no-op
  to base class.
- **`package.json`** — added `test:resource-controllers` script;
  added `verify-resource-controller-layer` to `verify:all`.
- **`scripts/ci-check.sh`** — added new test + verify to CI pipeline.
- **`Architecture.md`** — added "Resource Controller Layer" section
  with layered architecture diagram, module map, interface contract,
  new action types, plugin extensibility, IPC access.
- **`Configuration.md`** — added "Resource Controller Layer
  Configuration" section with all 3 config keys, controller table,
  thermal/power/PPD profile tables, IPC access, example.

### Migration notes

No action required. `ENABLE_RESOURCE_CONTROLLER_LAYER` defaults to
`false`, so existing deployments continue to behave identically to
Phase 1. To enable the Resource Controller Layer, set
`ENABLE_RESOURCE_CONTROLLER_LAYER: true` in the config file. The
new action types (`setThermalProfile`, `setPowerProfile`,
`setPpdProfile`) are only available when both
`ENABLE_POLICY_ENGINE=true` AND `ENABLE_RESOURCE_CONTROLLER_LAYER=true`.

---

### Added — Phase 1: Detector Layer Foundation

A new optional, purely-observational detection framework that runs
alongside the existing classifier / plugins / multimedia stack.
Provides a unified `Detector` abstraction (mirroring the
`ResourceController` pattern from ADR-0001) for workload, power,
and idle state detection.

**All new config keys default to OFF** (`ENABLE_DETECTOR_LAYER: false`).
When disabled, no detector code is loaded — zero behavior change
from v0.4.0.

- **`detectors/base-detector.js`** — `BaseDetector` abstract base
  class. Lifecycle: `setup()` → `start()` → `detect(context)` →
  `stop()` → `destroy()`. Capability probe via `isAvailable()`.
  Hot-reload via `setConfig(config)`.

- **`detectors/detection-context.js`** — `DetectionContext` immutable
  snapshot object. Carries foreground PID + info, process list,
  media PIDs, stress level, pressure readings, thermal, battery,
  GPU utilization, network RX. Frozen via `Object.freeze()` to
  prevent detectors from mutating daemon state.

- **`detectors/detector-manager.js`** — `DetectorManager` orchestrator.
  Validates detector interface, runs `detect()` on each tick,
  aggregates results, emits `onDetectionTick` bus events. Creates
  isolated bus when no bus is passed (owns lifecycle); uses provided
  bus otherwise (does not destroy on shutdown).

- **`detectors/workload-detector.js`** — `WorkloadDetector` classifies
  foreground process into `GAME` / `IDE` / `BROWSER` / `RENDERER` /
  `VIRTUALIZATION` / `COMPILER` / `MULTIMEDIA` / `UNKNOWN` / `NONE`.
  Reads from existing `classifier.js` (single source of truth for
  process-name regexes). Emits `onWorkloadDetected` on transition.

- **`detectors/power-state-detector.js`** — `PowerStateDetector`
  tracks `AC` / `CHARGING` / `BATTERY` / `BATTERY_LOW` /
  `BATTERY_CRITICAL` / `UNKNOWN` transitions. Emits
  `onPowerStateChanged`, `onAcPlugged`, `onAcUnplugged`,
  `onBatteryCharging`, `onBatteryDischarging`, `onBatteryLow`,
  `onBatteryCritical`.

- **`detectors/idle-state-detector.js`** — `IdleStateDetector`
  heuristic idle detection based on foreground stability + CPU
  pressure + network RX. Transitions `ACTIVE` ↔ `IDLE` after
  configurable threshold ticks. Emits `onIdleStateChanged`,
  `onIdle`, `onIdleEnd`.

- **`detectors/index.js`** — public API surface +
  `createBuiltinDetectors(deps)` factory.

- **Config keys** (all default OFF / safe, all hot-reloadable):
  - `ENABLE_DETECTOR_LAYER: false` — master switch
  - `DETECTOR_IDLE_THRESHOLD_TICKS: 30` — consecutive idle-signal ticks
  - `DETECTOR_IDLE_CPU_PRESSURE_MAX: 2.0` — PSI avg10 threshold for idle
  - `DETECTOR_IDLE_NET_RX_KBPS_MAX: 5` — KB/s threshold for idle

- **IPC handler** `detectors` — returns detector layer status
  (enabled, running, detectorCount, tickCount, per-detector status).

- **Daemon integration**:
  - `daemon.js :: fastTick()` calls `detectorMgr.tick()` with cheap
    fields (foreground PID, pressure, battery, thermal).
  - `daemon.js :: slowTick()` calls `detectorMgr.tick()` with rich
    fields (process list, foreground comm/cmdline).
  - `daemon.js :: setupHotReload()` propagates config to detector layer.
  - `daemon.js :: cleanupAndExit()` calls `detectorMgr.destroy()`.
  - `daemon.js :: bootstrap()` constructs `DetectorManager` after
    Policy Engine (shares PE bus when PE enabled, isolated bus
    otherwise).
  - `daemon.js :: getState()` exposes `detectorLayer` status.

- **`test/unit/test-detector-layer.js`** — 62 unit tests covering:
  - BaseDetector interface contract (constructor validation, lifecycle,
    default no-ops, setConfig propagation, destroy idempotency)
  - DetectionContext immutability, field defaults, findProc/findByComm,
    foregroundIn, null battery handling, frozen sub-objects
  - DetectorManager register/unregister/lifecycle, tick aggregation,
    error isolation, unavailable detector skipping, setConfig
    propagation, getStatus, getLastDetections, destroy idempotency
  - WorkloadDetector classification (firefox→BROWSER, UnityPlayer→GAME,
    code→IDE, obs→RENDERER, qemu→VIRTUALIZATION, rustc→COMPILER,
    mpv→MULTIMEDIA, unknown→UNKNOWN), hysteresis, NONE emission,
    bus event emission, stateStore updates
  - PowerStateDetector AC/CHARGING/BATTERY/BATTERY_LOW/BATTERY_CRITICAL
    states, hysteresis, AC↔BATTERY transition events, BATTERY_LOW
    threshold crossing, UNKNOWN on battery disappearance
  - IdleStateDetector ACTIVE↔IDLE state machine, threshold ticks,
    activity reset, onIdle/onIdleEnd events, stateStore updates
  - Public API surface (index.js exports)
  - End-to-end integration (createBuiltinDetectors + DetectorManager)

- **`scripts/verify-detector-layer.js`** — 34-assertion safety &
  architecture audit:
  - Module structure (all 7 expected files exist, index.js exports
    documented API)
  - No system mutation (no exec/execFile/spawn/writeFileSync to
    /sys or /proc, no actuator references)
  - Backward compatibility (ENABLE_DETECTOR_LAYER defaults false,
    schema entries present, hot-reload entries present)
  - Daemon integration (gated behind flag, tick called, setConfig
    called, destroy called, IPC handler registered, state exposed)
  - Bus isolation (creates isolated bus, tracks ownership, only
    destroys owned bus)
  - DetectionContext immutability (Object.freeze on self + battery)
  - Behavioral smoke test (boots without errors, full tick without
    throwing)

### Security

- **No system mutation surface**: detectors are purely observational.
  Zero `exec`/`execFile`/`spawn`/`writeFileSync` calls in the entire
  `detectors/` directory. All sensor data flows in via the
  `DetectionContext` snapshot constructed by the daemon.
- **No shell invocation**: N/A — detectors never spawn subprocesses.
- **DetectionContext immutability**: the context object is frozen
  via `Object.freeze()`, preventing detectors from accidentally
  mutating daemon state. The `battery` sub-object is also frozen.
- **Bus isolation**: when the Policy Engine is disabled, the
  DetectorManager creates its own isolated `EventBus` instance
  (does not pollute any global state). When PE is enabled, the
  manager shares the PE bus but does NOT own its lifecycle.
- **Input validation**: detector names validated against
  `^[a-z][a-z0-9-]{0,30}$` (kebab-case, max 31 chars). Detector
  interface validated (must have `detect()` function).

### Changed

- **`config.js`** — added 4 new config keys (`ENABLE_DETECTOR_LAYER`,
  `DETECTOR_IDLE_THRESHOLD_TICKS`, `DETECTOR_IDLE_CPU_PRESSURE_MAX`,
  `DETECTOR_IDLE_NET_RX_KBPS_MAX`) with schema entries and
  hot-reload registration.
- **`daemon.js`** — added lazy `DetectorModule` import, `detectorMgr`
  state variable, construction block in bootstrap (gated by
  `ENABLE_DETECTOR_LAYER`), tick calls in fastTick + slowTick,
  setConfig propagation in hot-reload, destroy in cleanupAndExit,
  IPC `detectors` handler, `detectorLayer` field in `getState()`.
- **`package.json`** — extended `syntax-check` glob to include
  `detectors/*.js`, `lib/*.js`, `lib/controllers/*.js`. Added
  `test:detectors` script. Added `verify-detector-layer` to
  `verify:all`.
- **`scripts/ci-check.sh`** — extended syntax-check glob. Added
  `test-detector-layer.js` to unit-test list. Added
  `verify-detector-layer` to verify-script list.
- **`Architecture.md`** — added "Detector Layer (v0.5.0 Phase 1)"
  section with module map, interface contract, bus integration,
  and extension points.
- **`Configuration.md`** — added "Detector Layer Configuration"
  section with all 4 config keys, built-in detectors table, IPC
  access, and example.

### Migration notes

No action required. `ENABLE_DETECTOR_LAYER` defaults to `false`, so
existing deployments continue to behave identically to v0.4.0. To
enable the Detector Layer, set `ENABLE_DETECTOR_LAYER: true` in the
config file. No root privileges required (detectors are observational
only — no `tc`/`nft`/`taskset`/`renice`/`ionice` calls).

---

### Added — Phase 2: Network QoS Controller

First new resource domain beyond the original CPU/Memory/IO trio. Adds
per-cgroup network traffic shaping via Linux `tc` (traffic control) and
`nftables` cgroup marking.

**All new config keys default to OFF** (`ENABLE_NETWORK_QOS: false`). When
disabled, the daemon behaves identically to v0.3.x — the NetworkController
is never instantiated, no `tc`/`nft` commands are executed, and all
network QoS methods on the Actuator facade are no-ops.

- **`lib/controllers/network-controller.js`** — `NetworkController` subclass
  extending `ResourceController`. Owns:
  - `tc qdisc` — HTB root qdisc installation on a network interface
  - `tc class` — foreground (high-priority, default `1gbit`) and background
    (shaped, default `10mbit`) traffic classes
  - `tc filter` — fw-classifier filters routing packets by mark
  - `nftables` — `cgroupsv2` path matching to set packet marks (0x1 for
    foreground, 0x2 for background)
  - Capability detection: probes for `tc`/`nft` binaries and root privileges
  - Auto-detect default-route interface when `NETWORK_QOS_INTERFACE` is null
  - Idempotent setup/teardown (deletes existing qdisc/table before creating)

- **Config keys** (all default OFF/null, all hot-reloadable):
  - `ENABLE_NETWORK_QOS: false` — master switch
  - `NETWORK_QOS_INTERFACE: null` — auto-detect default route
  - `NETWORK_QOS_FOREGROUND_RATE: '1gbit'` / `NETWORK_QOS_FOREGROUND_CEIL: '1gbit'`
  - `NETWORK_QOS_BACKGROUND_RATE: '10mbit'` / `NETWORK_QOS_BACKGROUND_CEIL: '50mbit'`
  - `NETWORK_QOS_USE_NFTABLES: true` — set false for HTB-only mode

- **IPC handler** `network` — returns controller status (enabled, available,
  interface, qdisc/nft state, capabilities, configured rates).

- **CLI command** `dynalloc network` — human-readable network QoS status.
  Supports `--json` flag.

- **Daemon integration**:
  - `actuator.networkSetup()` called after `setupCgroups()` in bootstrap
  - `actuator.networkStop()` called in `cleanupAndExit()` before cgroup restoration
  - NetworkController lazily instantiated only when `ENABLE_NETWORK_QOS=true`

- **`test/unit/test-network-controller.js`** — 29 unit tests covering:
  - Class hierarchy (extends ResourceController)
  - Input validation (interface names, rate strings — rejects shell metacharacters)
  - Capability gating (returns false when disabled, when tc/nft missing, when non-root)
  - DRY_RUN mode (traces commands without executing)
  - Setup/teardown idempotency
  - Actuator facade integration (no-op when disabled)
  - Status snapshot shape

- **`scripts/verify-network-qos.js`** — 37-assertion security & safety audit:
  - No shell invocation (all exec uses `execFileSync` with arg arrays)
  - Input validation regexes are strict (IFNAMSIZ-compliant, no metacharacters)
  - DRY_RUN respected in all code paths
  - Capability gating enforced
  - Idempotent setup/teardown
  - No user-configurable binary paths (prevents path traversal)
  - Actuator facade wiring correct
  - Config schema + hot-reload entries present
  - Daemon bootstrap + cleanup integration
  - CLI command + help text present

### Security

- **No shell injection surface**: every `tc`/`nft` invocation uses
  `child_process.execFileSync(binary, argArray, opts)` with hardcoded binary
  names and validated argument arrays. No template strings are interpolated
  into commands.
- **Input validation**: interface names validated against
  `^[a-zA-Z0-9_.-]{1,15}$` (IFNAMSIZ-compliant). Rate strings validated
  against `^[0-9]+(bit|kbit|mbit|gbit|tbit|Kbps|Mbps|Gbps|Tbps|bps)$`.
  Shell metacharacters (`;`, `|`, `$`, backticks, spaces) are rejected.
- **No user-configurable binary paths**: the `tc` and `nft` binary names
  are hardcoded constants, not config values. This prevents path-traversal
  / binary-substitution attacks.
- **Root privilege required**: in real (non-DRY_RUN) mode, the controller
  checks `process.geteuid() === 0` and refuses to operate otherwise.
  In DRY_RUN mode, it traces commands without executing.

### Changed

- **`actuator.js`** — added `networkSetup()`, `networkStop()`,
  `getNetworkController()`, `getNetworkStatus()` methods to the facade.
  NetworkController is instantiated lazily only when `ENABLE_NETWORK_QOS=true`.
  When false (the default), all network methods are no-ops and `_network`
  stays `null`.
- **`daemon.js`** — calls `actuator.networkSetup()` after `setupCgroups()`
  in bootstrap; calls `actuator.networkStop()` in `cleanupAndExit()`
  before cgroup restoration; registers IPC `network` handler.
- **`dynalloc-cli.js`** — added `network` command + `cmdNetwork()` function
  + help text entry.
- **`config.js`** — added 7 new config keys with schema entries and
  hot-reload registration.
- **Version bump** 0.3.0 → 0.4.0 (MINOR — first new resource domain).

### Migration notes

No action required. `ENABLE_NETWORK_QOS` defaults to `false`, so existing
deployments continue to behave identically to v0.3.x. To enable network
QoS, set `ENABLE_NETWORK_QOS: true` in the config file (requires root and
the `iproute2` package; `nftables` is optional but recommended for
cgroup-based traffic marking).

---

## [0.3.0] — Phase 1: ResourceController Refactor

### Added — Phase 1: ResourceController Refactor

Architectural refactor per ADR-0001. **No public API change.** All 451
existing tests pass unchanged, and the 35-assertion `verify-actuator-api.js`
contract test continues to pass byte-for-byte.

- **`lib/resource-controller.js`** — abstract base class for all resource
  controllers. Defines the lifecycle (`setup`/`start`/`stop`), capability
  probe (`isAvailable`), status snapshot (`getStatus`), and hot-reload
  (`setConfig`) contract that all controllers implement.

- **`lib/cgroup-manager.js`** — extracted cgroup v2 logic (path resolution,
  capability probing, subtree setup, limit application, PID assignment)
  from `actuator.js` into a shared collaborator. The Actuator and every
  controller share a single CgroupManager instance so they all agree on
  cgroup paths and available controllers.

- **`lib/controllers/cpu-controller.js`** — `CpuController` subclass.
  Owns `taskset` (CPU affinity) and `renice` (process niceness).

- **`lib/controllers/memory-controller.js`** — `MemoryController` subclass.
  Owns `/proc/<pid>/oom_score_adj` (per-process OOM score).

- **`lib/controllers/io-controller.js`** — `IoController` subclass.
  Owns `ionice` (per-process IO priority).

- **`lib/controllers/governor-controller.js`** — `GovernorController`
  adapter that wraps the existing standalone `governor.js` module to
  conform to the ResourceController interface.

- **`scripts/verify-controller-isolation.js`** — 18-assertion test
  confirming each controller can be `require()`'d and instantiated in
  isolation, that all are subclasses of `ResourceController`, and that
  lifecycle hooks / `getStatus` / `setConfig` work uniformly.

### Changed

- **`actuator.js`** rewritten as a **facade**. The class signature and
  public methods are byte-identical to v0.2.x — every existing caller
  (`daemon.js`, `scheduler.js`, `rollback.js`, `policy-engine/action-executor.js`,
  all tests, all verify scripts) continues to work unchanged. Internally,
  the Actuator now constructs a `CgroupManager` and three controller
  instances and forwards calls to them.

- **`scripts/verify-memory-cgroup.js`** updated to read source patterns
  from `lib/cgroup-manager.js` (where the cgroup logic now lives) instead
  of `actuator.js`, and to set ready-state on `actuator._cgroupManager`
  rather than directly on the facade. This is internal test maintenance,
  not a behavioral change.

- **Version bump** 0.2.2 → 0.3.0 (MINOR — architectural change, no
  functional change).

### Removed

- None. All v0.2.x code paths preserved.

### Migration notes

No action required. The `lib/` directory is internal — no public module
exports `lib/*` paths. Existing user configs, IPC clients, CLI
invocations, and plugins continue to work unchanged.

---

## [0.2.2] — Phase 0: Foundation & CI

### Added — Phase 0: Foundation & CI

This release introduces **no functional changes** to the daemon. It establishes
the CI/CD foundation and validation infrastructure required for the upcoming
"Adaptive Linux Resource Manager" transformation (Phases 1–N).

- **CI workflow** (`.github/workflows/ci.yml`): runs on push and pull-request
  against `main`/`master`. Five parallel jobs:
  - `syntax-check` — `node --check` on every `.js` file
  - `unit-tests` — matrix on Node 18 / 20 / 22 / 24, runs unit + integration tests
  - `verify-scripts` — runs all `scripts/verify-*.js` regression scripts
    (excludes `verify-cli.js` which needs a live daemon, and `verify-packaging.js`
    which needs dpkg/rpmbuild tooling)
  - `config-validation` — parses `package.json`, example configs, dry-run daemon boot
  - `regression-gate` — aggregator job that gates merge on all of the above

- **Local CI aggregator** (`scripts/ci-check.sh`): single-entry shell script that
  mirrors the GitHub Actions workflow so a developer can verify "would CI pass?"
  locally before pushing. Supports `--quiet` flag. Exit code 0 = all green.

- **package.json scripts**:
  - `npm test` — now runs the full 451-test suite (unit + integration)
  - `npm run test:unit` / `npm run test:integration` — scoped subsets
  - `npm run syntax-check` — `node --check` on every `.js` file
  - `npm run ci-check` — runs `scripts/ci-check.sh`
  - `npm run verify:all` — runs all `verify-*.js` regression scripts

- **Architecture Decision Records** (under `docs/adr/`):
  - `ADR-0001-resource-controller-abstraction.md` — lays out the plan for
    Phase 1: introduce a `ResourceController` abstract base class and refactor
    the existing monolithic `actuator.js` (CPU + Memory + IO + OOM + governor
    + cgroups setup) into focused subclasses without changing the public API.

### Changed

- **Version bump** 0.2.1 → 0.2.2 (PATCH — no behavior change, only CI/tooling).
- **package.json `description`** updated from "Dynamic Resource Allocator"
  to "Adaptive Linux Resource Manager" to reflect the project's new direction.
  The daemon banner still says `DynAlloc v2.1` for now — it will be updated
  alongside the Phase 1 refactor to avoid mid-phase inconsistency.

### Removed

- None. Phase 0 is purely additive.

### Migration notes

No action required. Existing user configs, IPC clients, CLI invocations, and
plugins continue to work unchanged. The new `npm` scripts are additive —
existing `npm start` / `npm test` commands still work (the `test` script now
explicitly enumerates test files instead of relying on `node --test` directory
auto-discovery, which was broken on some Node versions per a pre-existing issue).

---

## [0.2.1] — Audited Baseline

The "dylok-policy-engine-audited" snapshot. This is the **reference baseline**
for all phase validation gates:

- 336 unit tests pass
- 100 integration tests pass
- 15 policy integration tests pass
- **451/451 total tests pass**
- All JS files pass `node --check` syntax validation
- Daemon boots cleanly in DRY_RUN mode
- Zero open TODO/FIXME defects (only one intentional placeholder in
  `plugins/system.js`)

### Resource coverage at baseline

| Resource | Status |
|----------|--------|
| CPU (affinity / nice / cgroup cpu.weight / cpu.max / governor) | ✅ active |
| Memory (memory.max / memory.high / memory.oom.group) | ✅ active (v2.1.6) |
| IO (ionice / cgroup io.max) | ✅ active (v2.1.6) |
| OOM (oom_score_adj) | ✅ active |
| GPU (read-only utilization) | 📊 awareness only (v2.1.10) |
| Network (read-only system RX rate) | 📊 awareness only (v2.1.10) |
| PSI / Thermal / Battery | 📊 telemetry only |

### Roadmap forward

```
Phase 0  Foundation & CI              → v0.2.2 (this release)
Phase 1  ResourceController refactor  → v0.3.0 (architectural, no functional change)
Phase 2  Network QoS Controller       → v0.4.0 (first new resource domain)
Phase 3+ Additional controllers       → v0.5.0+ (TBD based on Phase 2 learnings)
```

Every phase must pass the full validation checklist (build / runtime /
functional / regression / memory / performance / logging / security / code
quality / architecture / final bug audit) before advancing.
