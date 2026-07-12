# Policy Engine (v2.2)

The Policy Engine is an **optional, event-driven rule system** that runs
alongside the existing DynAlloc scheduler. It lets you express
cross-cutting behaviors (e.g. "if battery < 20% AND Steam running THEN
switch to powersave governor") in a single declarative config file
instead of scattering conditional logic across the daemon.

> **Backward compatibility:** The Policy Engine is disabled by default
> (`ENABLE_POLICY_ENGINE: false`). When disabled, no policy-engine code
> is loaded — zero behavior change, zero memory overhead, zero CPU
> overhead. Existing deployments continue to work exactly as before.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [Event Bus](#event-bus)
4. [Rule Schema](#rule-schema)
5. [Matchers and Conditions](#matchers-and-conditions)
6. [Actions](#actions)
7. [Profiles](#profiles)
8. [Self-Healing](#self-healing)
9. [Logging and Audit](#logging-and-audit)
10. [Hot Reload](#hot-reload)
11. [Performance](#performance)
12. [Plugin Integration](#plugin-integration)
13. [Configuration Reference](#configuration-reference)

---

## Quick Start

1. **Enable the engine** in your `config.json`:

   ```json
   {
     "ENABLE_POLICY_ENGINE": true,
     "POLICY_LOG_FILE_PATH": "/var/log/dynalloc-policy.log"
   }
   ```

2. **Create a policy file** at `~/.config/dynalloc/policies.json`
   (or `/etc/dynalloc/policies.json` for system-wide):

   ```json
   {
     "profiles": {
       "gaming":    { "governor": "performance", "schedulerMode": "aggressive" },
       "powersave": { "governor": "powersave",   "schedulerMode": "conservative" }
     },
     "rules": [
       {
         "id": "steam-gaming",
         "when": { "event": "onProcessStarted" },
         "match": { "comm": "matches ^steam$" },
         "condition": {
           "AND": [
             { "battery.capacity": ">40" },
             { "thermal.temp": "<85" }
           ]
         },
         "action": { "type": "applyProfile", "profile": "gaming" },
         "priority": 100,
         "cooldown": 5000
       },
       {
         "id": "battery-low-powersave",
         "when": { "event": "onBatteryLow" },
         "action": { "type": "applyProfile", "profile": "powersave" },
         "priority": 200,
         "cooldown": 30000
       }
     ]
   }
   ```

3. **Restart the daemon.** The policy file is hot-reloaded on save, so
   you can iterate without restarting.

4. **Inspect the audit log** at `/var/log/dynalloc-policy.log` (or
   whatever path you configured) to see every rule firing.

---

## Architecture

```
                          ┌─────────────────────────────────────┐
                          │            daemon.js                │
                          │   fastTick / slowTick / handleFg    │
                          └────────────┬────────────────────────┘
                                       │ updateBattery()
                                       │ updateThermal()
                                       │ updatePressure()
                                       │ updateForeground()
                                       │ updateProcesses()
                                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                    policy-engine/                            │
   │                                                              │
   │  ┌─────────────┐    emit()    ┌──────────────────────┐      │
   │  │ EventSources├─────────────►│      EventBus        │      │
   │  └─────────────┘              │  (synchronous pub/sub)│      │
   │                               └──────────┬───────────┘      │
   │                                          │ '*' wildcard     │
   │                                          ▼                  │
   │                               ┌──────────────────────┐      │
   │                               │   StateStore         │      │
   │                               │  (current readings)  │      │
   │                               └──────────┬───────────┘      │
   │                                          │                  │
   │  ┌─────────────┐    load()    ┌──────────▼───────────┐      │
   │  │ PolicyLoader├─────────────►│     RuleEngine       │      │
   │  │ (file watch)│              │  (priority, cooldown,│      │
   │  └─────────────┘              │   once, delay, AND/  │      │
   │                               │   OR/NOT matchers)   │      │
   │                               └──────────┬───────────┘      │
   │                                          │ matches          │
   │                                          ▼                  │
   │                               ┌──────────────────────┐      │
   │                               │  ActionExecutor      │      │
   │                               │  (wraps actuator/    │      │
   │                               │   governor/scheduler)│      │
   │                               └──────────┬───────────┘      │
   │                                          │ audit record      │
   │                                          ▼                  │
   │                               ┌──────────────────────┐      │
   │                               │   PolicyLogger       │      │
   │                               │ (ring buffer + file) │      │
   │                               └──────────────────────┘      │
   └──────────────────────────────────────────────────────────────┘
```

### Module Inventory

| Module | LOC | Role |
|---|---|---|
| `event-bus.js` | 280 | Synchronous pub/sub with wildcard, priority, re-entrancy safety |
| `state-store.js` | 200 | Dot-path key/value cache of current system readings |
| `event-sources.js` | 250 | Bridges daemon sensor reads → bus events (with hysteresis) |
| `matcher.js` | 220 | Condition evaluator: AND/OR/NOT + 11 operators |
| `rule-engine.js` | 240 | Rule normalization, priority sort, cooldown/once/delay |
| `action-executor.js` | 340 | Translates action objects → actuator/governor/scheduler calls |
| `policy-logger.js` | 200 | Audit trail: ring buffer + rotating JSON-lines file |
| `policy-loader.js` | 310 | JSON/YAML parser, validator, hot-reload watcher |
| `policy-engine.js` | 320 | Main orchestrator — wires everything together |
| `index.js` | 50 | Public API surface |

### Design Principles

1. **Pure observer + action dispatcher.** The engine never modifies
   scheduler/actuator state directly. Every change goes through the
   ActionExecutor, which calls the same public APIs the daemon uses.
2. **Self-healing by construction.** Every action is wrapped in
   try/catch. Failures trigger snapshot rollback. The engine never
   propagates exceptions to the daemon.
3. **Event-driven, not polling.** The engine has no timers of its own.
   It reacts to events emitted by the daemon's existing tick loops.
4. **Composition over inheritance.** Every module is a standalone
   class with explicit dependencies injected via the constructor.
   No module extends another.
5. **Backward compatibility is sacred.** Every public function in the
   existing modules keeps its signature. The daemon's changes are
   strictly additive (4 new `require` calls, 6 new optional hook
   invocations guarded by `if (policySources)`).

---

## Event Bus

The EventBus is a synchronous, in-process publish/subscribe channel.
It does NOT use Node's EventEmitter — we control error isolation and
dispatch semantics directly.

### Standard Events

| Event | Emitted When | Payload |
|---|---|---|
| `onBatteryLow` | Battery capacity crosses below 20% (configurable) while on battery | `{ level, threshold }` |
| `onBatteryCharging` | Transition from on-battery → plugged | `{ capacity }` |
| `onBatteryDischarging` | Transition from plugged → on-battery | `{ capacity }` |
| `onAcPlugged` | AC adapter plugged in | `{ capacity }` |
| `onAcUnplugged` | AC adapter unplugged | `{ capacity }` |
| `onSuspend` | System preparing to suspend | `{ timestamp }` |
| `onResume` | System resumed from suspend | `{ timestamp }` |
| `onIdle` | User went idle | `{ timestamp }` |
| `onIdleEnd` | User returned from idle | `{ timestamp }` |
| `onCpuHigh` | CPU PSI avg10 crosses WARN threshold (rising) | `{ pressure, threshold }` |
| `onCpuNormal` | CPU PSI avg10 returns below WARN threshold (falling) | `{ pressure }` |
| `onMemoryPressure` | Memory PSI avg10 crosses WARN threshold (rising) | `{ pressure, threshold }` |
| `onMemoryNormal` | Memory PSI avg10 returns below WARN threshold (falling) | `{ pressure }` |
| `onThermalHigh` | Thermal temp crosses 75°C (configurable) | `{ temp, threshold }` |
| `onForegroundChanged` | Active window PID changed | `{ pid, prevPid, name, comm }` |
| `onWallpaperChanged` | Wallpaper changed (manual emit or plugin-triggered) | `{ target }` |
| `onProcessStarted` | New process name detected (post-startup) | `{ pid, comm }` |
| `onProcessExited` | Previously-seen process name no longer present | `{ comm }` |
| `onStressChanged` | Scheduler stress level transition | `{ from, to }` |
| `onProfileChanged` | A profile was applied (emitted by `applyProfile` action) | `{ profile, foregroundBoost }` |
| `onPluginLoaded` | A plugin was registered | `{ name }` |
| `onPluginUnloaded` | A plugin was unregistered | `{ name }` |
| `onPolicyEngineStarted` | Engine finished bootstrap | `{ rules, timestamp }` |
| `onPolicyEngineStopped` | Engine received stop signal | `{ timestamp }` |
| `onPolicyEngineReloaded` | Policy file was hot-reloaded | `{ rules, timestamp }` |

### Subscribing from a Plugin

Plugins can subscribe to bus events without modifying daemon core:

```js
// my-plugin.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Subscribes to policy engine events',

  init(config) {
    // The daemon passes the policy engine instance via config.__policyEngine
    // (only set when ENABLE_POLICY_ENGINE is true)
    const engine = config.__policyEngine;
    if (engine) {
      this._listenerId = engine.bus.on('onWallpaperChanged', (payload) => {
        // React to wallpaper change
        extractPalette(payload.target);
      });
    }
  },

  destroy() {
    const engine = /* ... */;
    if (engine && this._listenerId) {
      engine.bus.off(this._listenerId);
    }
  },

  detect(procs, ctx) { return []; },
};
```

### Bus Semantics

- **Synchronous dispatch.** Listeners run inline during `emit()`. The
  producer blocks until all listeners return. This makes ordering
  predictable.
- **Error isolation.** A throw in one listener is caught and logged.
  It never propagates to the producer or sibling listeners.
- **Priority ordering.** Listeners with higher `priority` fire first.
  Default priority is 0. The engine's own wildcard listener uses
  `-100` so user listeners always fire first.
- **Re-entrant safe.** A listener may emit another event; the bus
  tracks dispatch depth and defers listener removal until the
  outermost dispatch completes.
- **`once()` support.** Auto-removed after first invocation.
- **Wildcard subscription.** `bus.on('*', fn)` receives every event.
  The callback receives `(eventName, payload)`.

---

## Rule Schema

A rule is a JSON object with the following fields. Only `id` and
`action` are required.

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | *required* | Unique rule identifier. Duplicate ids log a warning; last one wins. |
| `description` | string | `''` | Human-readable description (shown in audit log) |
| `when` | object \| string | `null` | Event filter. If `null`, the rule matches every event. String form: `"onBatteryLow"`. Object form: `{ "event": "onBatteryLow" }`. |
| `match` | object | `null` | Short-form leaf condition. Each key is a field path, each value is either a plain value (implicit `==`) or a comparison string like `">40"`. Multiple keys are AND-ed. |
| `condition` | object | `null` | Structured condition supporting `AND` / `OR` / `NOT` combinators and the same leaf shape as `match`. |
| `action` | object | *required* | The action to execute when the rule matches. See [Actions](#actions). |
| `priority` | number | `0` | Higher priority rules fire first when multiple rules match the same event. |
| `cooldown` | number (ms) | `POLICY_DEFAULT_COOLDOWN_MS` (1000) | Minimum time between successive firings of this rule. |
| `delay` | number (ms) | `0` | Wait this long before executing the action. Cooldown starts at scheduling time, not execution time. |
| `once` | boolean | `false` | If true, the rule fires at most once per daemon run. Reset only on hot-reload. |
| `enabled` | boolean | `true` | If false, the rule is skipped. |

### Rule Evaluation Order

For each incoming event:

1. Filter by `enabled` (skip disabled rules).
2. Filter by `when.event` (skip rules that don't match this event).
3. Check `once` (skip if already fired).
4. Check `cooldown` (skip if fired too recently).
5. Evaluate `match` (skip if any key fails).
6. Evaluate `condition` (skip if compound evaluates false).
7. **Match** — record `lastFired` timestamp, add `once` set if
   applicable, return match to the engine.

Matches are returned in **priority order, highest first**. The engine
executes them sequentially (not in parallel) so audit records are
ordered and side effects are predictable.

---

## Matchers and Conditions

### Field Resolution

When a matcher needs the value of a field (e.g. `battery.capacity`),
it checks:

1. The event payload directly (flat key or dot-path walk).
2. The StateStore (always up-to-date with the latest sensor readings).

If neither has the field, the comparison evaluates to `false` (safe
default — never trigger on unknown state).

### Operators

The matcher supports 11 operators. They can be used in two forms:

**Short-form** (string value with operator prefix):

```json
{ "battery.capacity": "<20" }
{ "comm": "matches ^steam$" }
{ "processes.count": ">=10" }
```

**Explicit-form** (recommended for clarity in compound conditions):

```json
{ "field": "battery.capacity", "op": "<", "value": 20 }
```

| Operator | Value Type | Description |
|---|---|---|
| `<` | number | Less than |
| `<=` | number | Less than or equal |
| `>` | number | Greater than |
| `>=` | number | Greater than or equal |
| `==` | any | Strict equality (with numeric coercion) |
| `!=` | any | Strict inequality (with numeric coercion) |
| `contains` | string \| array | Substring (string) or element (array) check |
| `startsWith` | string | String prefix check |
| `endsWith` | string | String suffix check |
| `matches` | string (regex) | RegExp test against the field value |
| `in` | array | Field value is in the provided list |
| `exists` | boolean | True if field has a value (use `{ "field": "exists" }` or `{ "field": true }`) |

### Compound Conditions

Compound conditions use the reserved keys `AND`, `OR`, `NOT`:

```json
{
  "AND": [
    { "OR": [
      { "battery.capacity": ">40" },
      { "battery.onBattery": false }
    ]},
    { "NOT": { "thermal.temp": ">=85" } }
  ]
}
```

A leaf without combinators is treated as a single comparison. An
empty object `{}` evaluates to `true` (useful for "always match"
rules combined with `NOT`).

### Multi-Key Leaf

A leaf with multiple keys is equivalent to AND-ing each key:

```json
{ "app": "steam", "battery.capacity": ">40" }
```

is the same as:

```json
{ "AND": [ { "app": "steam" }, { "battery.capacity": ">40" } ] }
```

---

## Actions

### `applyProfile`

Apply a named profile (see [Profiles](#profiles)). Sub-steps are
applied in order: `schedulerMode` first, then `governor`, then
`foregroundBoost`. If any sub-step fails, previously applied
sub-steps are rolled back atomically.

```json
{ "type": "applyProfile", "profile": "gaming" }
```

### `setGovernor`

Set the CPU frequency governor on a set of cores. Uses the existing
`GovernorManager` — original governors are captured and restored on
daemon shutdown.

```json
{
  "type": "setGovernor",
  "governor": "performance",
  "cores": "foreground"   // "foreground" | "background" | "all" | [0,1,2]
}
```

Valid governors: `performance`, `powersave`, `ondemand`,
`conservative`, `schedutil`, `userspace`.

### `setSchedulerMode`

Adjust PSI thresholds at runtime to make the scheduler more or less
aggressive. This mutates `CONFIG.PSI_CPU_WARN` and
`CONFIG.PSI_CPU_CRITICAL`. The snapshot/rollback mechanism restores
them on failure.

```json
{ "type": "setSchedulerMode", "mode": "aggressive" }
```

| Mode | Effect |
|---|---|
| `aggressive` | Halves thresholds → faster throttling response |
| `conservative` | 1.5× thresholds → slower throttling response |
| `balanced` | Restores to original config defaults |

### `boostProcess`

Apply foreground boost parameters (cgroup/nice/io/oom) to a specific
PID. Uses `scheduler.generateForegroundBoost()` internally.

```json
{ "type": "boostProcess", "pid": 12345 }
```

### `throttleProcess`

Apply background throttle parameters to a specific PID.

```json
{ "type": "throttleProcess", "pid": 12345 }
```

### `restoreProcess`

Restore a process to neutral state (all cores, nice 0, default ioprio,
oom 0). Equivalent to `actuator.restoreProcess()`.

```json
{ "type": "restoreProcess", "pid": 12345 }
```

### `refreshPalette`

Emit the `onWallpaperChanged` event so palette-extractor plugins can
react. This is the canonical way to trigger a wallpaper palette
refresh from a rule.

```json
{ "type": "refreshPalette", "target": "wallpaper" }
```

### `notify`

Send a desktop notification via `notify-send` (uses the existing
`actuator.notify()`).

```json
{
  "type": "notify",
  "summary": "DynAlloc Policy",
  "body": "Switched to gaming profile"
}
```

### `emitEvent`

Emit a custom event on the bus. Useful for rule chaining — one rule
can trigger an event that other rules react to.

```json
{
  "type": "emitEvent",
  "event": "onCustomEvent",
  "payload": { "foo": "bar" }
}
```

### `log`

Write a log entry at the requested level via the main daemon logger.
The message is prefixed with `[policy]` for easy filtering.

```json
{
  "type": "log",
  "level": "info",
  "message": "Profile changed to gaming"
}
```

Valid levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

---

## Profiles

A profile is a named bundle of action settings. Profiles are declared
in the top-level `profiles` object of the policy file and referenced
by name from rules.

```json
{
  "profiles": {
    "gaming": {
      "schedulerMode": "aggressive",
      "governor": "performance",
      "governorCores": "foreground",
      "foregroundBoost": true
    },
    "powersave": {
      "schedulerMode": "conservative",
      "governor": "powersave",
      "governorCores": "all",
      "foregroundBoost": false
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `schedulerMode` | string | One of `aggressive`, `conservative`, `balanced` |
| `governor` | string | CPU governor name |
| `governorCores` | string | `foreground` (default), `background`, or `all` |
| `foregroundBoost` | boolean | If true, emits `onProfileChanged` event with `foregroundBoost: true` |

Profiles are applied atomically — if any sub-step fails, all
previously applied sub-steps are rolled back. The audit log records
the rollback.

---

## Self-Healing

Every action execution is wrapped in three layers of protection:

### Layer 1: Action-level try/catch

The `ActionExecutor.execute()` method wraps every action call in
try/catch. A throw is caught and reported as a failure — it never
propagates to the engine.

### Layer 2: Snapshot-based rollback

Before executing an action, the executor captures a snapshot of the
state it might modify:

| Action | Snapshot |
|---|---|
| `setGovernor` | Original governors (per-core) from `GovernorManager.getOriginalGovernors()` |
| `setSchedulerMode` | Previous `PSI_CPU_WARN` and `PSI_CPU_CRITICAL` values |
| `applyProfile` | Per-sub-step snapshots (composite rollback) |

If the action fails, the executor calls `_restoreSnapshot(snapshot)`.
The audit record's `rollbackApplied` field indicates whether rollback
was performed.

### Layer 3: Engine-level defense-in-depth

The engine wraps every `executor.execute()` call in its own
try/catch. Even if the executor's internal error handling fails, the
engine continues processing other rules.

### What this means in practice

- A `setGovernor` action that fails because `cpupower` is missing
  will be logged and skipped. The next rule's action still fires.
- A `applyProfile` action where the governor sub-step fails after
  the schedulerMode sub-step succeeded will roll back the
  schedulerMode change. The audit log shows `rollbackApplied: true`.
- A rule with a malformed action object is rejected at evaluation
  time — the engine logs the error and moves on.

---

## Logging and Audit

Every policy execution produces exactly one audit record. Records are
written to:

1. **In-memory ring buffer** (default 500 entries, configurable).
   Accessible via `engine.policyLogger.recentEntries(count)` for
   programmatic inspection.
2. **Optional JSON-lines file** with rotation (configurable via
   `POLICY_LOG_FILE_PATH`). Each line is a self-contained JSON object.
3. **Daemon log** at debug level (for live monitoring via
   `journalctl`).

### Audit Record Format

```json
{
  "timestamp": "2026-07-11T00:00:00.000Z",
  "trigger": "onProcessStarted",
  "triggerPayload": { "pid": 12345, "comm": "steam" },
  "ruleId": "steam-gaming",
  "matchedFields": {
    "comm": "steam",
    "battery.capacity": 75,
    "thermal.temp": 60
  },
  "action": { "type": "applyProfile", "profile": "gaming" },
  "executionTimeMs": 12.345,
  "success": true,
  "error": null,
  "rollbackApplied": false
}
```

### Metrics Counters

The engine registers the following counters in the main metrics
registry (when `ENABLE_METRICS` is true):

| Counter | Description |
|---|---|
| `policy_evaluations` | Total rule evaluations (cumulative) |
| `policy_matches` | Total matched rules |
| `policy_actions_executed` | Total actions attempted |
| `policy_actions_succeeded` | Actions that succeeded |
| `policy_actions_failed` | Actions that failed |
| `policy_rollbacks` | Self-healing rollbacks performed |

Plus gauges:

| Gauge | Description |
|---|---|
| `policy_rule_count` | Current rule count |
| `policy_uptime_seconds` | Engine uptime in seconds |

---

## Hot Reload

The Policy Engine supports two independent hot-reload mechanisms:

### Policy file hot-reload

When `POLICY_HOT_RELOAD: true` (default), the `PolicyLoader` watches
the resolved policy file with `fs.watch()`. On change:

1. 300ms debounce timer fires.
2. The file is re-read and re-parsed.
3. Validation warnings are logged (but do not abort the reload).
4. If parsing fails entirely, the previous valid rules stay in
   effect and a warning is logged.
5. On success, the new rules replace the old ones atomically. All
   cooldowns and `once` flags are reset.

### Main config hot-reload

The daemon's existing `setupHotReload()` now also propagates
hot-reloadable policy config keys (`POLICY_DEFAULT_COOLDOWN_MS`,
`POLICY_MAX_RULES`, etc.) to the engine via
`engine.executor.setConfig(CONFIG)`. This happens transparently —
no special action is needed.

### What is NOT hot-reloadable

`ENABLE_POLICY_ENGINE` itself requires a daemon restart, because it
controls whether the policy-engine module is loaded at all.

---

## Performance

The Policy Engine is designed to add **negligible overhead** when
enabled and **zero overhead** when disabled.

### When disabled

- No `require('./policy-engine')` call ever executes.
- No EventBus instance is created.
- No file watchers are created.
- No audit log file is opened.
- The daemon's hot path has 4 optional `if (policySources)` checks
  that short-circuit immediately when the engine is not loaded.

### When enabled

- The engine adds **one wildcard listener** to its own bus. The
  daemon emits ~5 events per fastTick (battery/thermal/pressure) and
  ~1-2 per slowTick (foreground/processes). Each emit triggers one
  `RuleEngine.evaluateEvent()` call.
- Rule evaluation is O(rules) per event. With the default
  `POLICY_MAX_RULES: 200` and ~10 events/sec, that's ~2000
  evaluations/sec — sub-millisecond total CPU.
- The bus dispatches synchronously, so there are **no timer wakeups**
  and **no microtask scheduling**. Producers see listener completion
  before they continue.
- Delayed rules use `setTimeout().unref()` so they don't keep the
  event loop alive on shutdown.
- The audit ring buffer is bounded (default 500 entries). The audit
  file rotates at 5MB by default.

### Memory

- EventBus: ~100 bytes per listener. Default config = ~10 listeners
  = 1KB.
- StateStore: ~200 bytes per top-level key. Bounded at 256 keys = ~50KB max.
- RuleEngine: ~200 bytes per rule. Bounded at `POLICY_MAX_RULES`.
- PolicyLogger ring buffer: ~1KB per entry. Default 500 entries = ~500KB.
- ActionExecutor: stateless except for the profiles map (small).

Total typical memory footprint: **under 1MB**.

---

## Plugin Integration

Plugins can subscribe to bus events and emit custom events without
modifying daemon core. The daemon exposes the policy engine instance
via the plugin `init()` config:

```js
// A plugin that reacts to policy events
module.exports = {
  name: 'palette-extractor',
  version: '1.0.0',
  description: 'Extracts color palette from wallpaper on change',

  init(config) {
    // config.__policyEngine is set by the daemon when the policy
    // engine is enabled. When disabled, it's undefined.
    const engine = config.__policyEngine;
    if (engine) {
      this._listenerId = engine.bus.on('onWallpaperChanged', (payload) => {
        this._extractPalette(payload.target);
      });
    }
  },

  destroy() {
    const engine = this._engine;
    if (engine && this._listenerId != null) {
      engine.bus.off(this._listenerId);
    }
  },

  detect(procs, ctx) {
    // Standard detection — return palette-relevant processes
    return [];
  },

  _extractPalette(target) {
    // Custom palette extraction logic
  },
};
```

### Custom Plugin Events

A plugin can also emit events on the bus for other plugins or rules
to react to:

```js
const engine = config.__policyEngine;
engine.bus.emit('onCustomPluginEvent', { foo: 'bar' });
```

Rules can then match on these custom events:

```json
{
  "id": "react-to-custom-event",
  "when": { "event": "onCustomPluginEvent" },
  "match": { "foo": "bar" },
  "action": { "type": "log", "message": "Custom event received" }
}
```

---

## Configuration Reference

All configuration is in the main `config.json`. New keys (v2.2):

| Key | Type | Default | Description |
|---|---|---|---|
| `ENABLE_POLICY_ENGINE` | boolean | `false` | Master switch. When false, no policy-engine code is loaded. NOT hot-reloadable. |
| `POLICY_FILE_PATH` | string \| null | `null` | Explicit policy file path. If null, auto-detects `~/.config/dynalloc/policies.{json,yaml}` or `/etc/dynalloc/policies.{json,yaml}`. NOT hot-reloadable (path is resolved once at startup). |
| `POLICY_HOT_RELOAD` | boolean | `true` | Watch the policy file for changes and reload automatically. |
| `POLICY_LOG_FILE_PATH` | string \| null | `null` | If set, write audit records to this file (JSON-lines, with rotation). If null, audit records are still kept in the in-memory ring buffer. |
| `POLICY_LOG_MAX_SIZE_MB` | number | `5` | Max audit log file size before rotation. |
| `POLICY_LOG_MAX_FILES` | number | `3` | Max rotated audit log files to keep. |
| `POLICY_DEFAULT_COOLDOWN_MS` | number | `1000` | Default cooldown for rules that don't specify one. |
| `POLICY_MAX_RULES` | number | `200` | Hard cap on rule count. Extra rules are dropped with a warning. |
| `POLICY_EXECUTION_TIMEOUT_MS` | number | `5000` | Advisory per-action timeout (currently not enforced — actions are awaited but not race-timed). |

### Environment Variables

| Variable | Description |
|---|---|
| `DYNALLOC_POLICY_PATH` | Override the policy file path. Takes highest priority over config. |

---

## See Also

- [Architecture.md](Architecture.md) — Overall daemon architecture
- [Configuration.md](Configuration.md) — Full config reference
- [Plugin.md](Plugin.md) — Plugin development guide
- [policies.example.json](policies.example.json) — Example policy file (JSON)
- [policies.example.yaml](policies.example.yaml) — Example policy file (YAML)
