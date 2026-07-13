# Profile Manager

## Overview

The Profile Manager is the decision layer between the Detector Layer
(Phase 1) and the Resource Controller Layer (Phase 2). It subscribes
to detector events on the bus, evaluates which profile should be
active based on a deterministic priority system, and instructs the
ResourceControllerManager to apply the winning profile's resource
settings.

## Architecture

```
  User Events
       ↓
  Detector Layer (Phase 1)        ← observes system state, emits events
       ↓
  Event Bus
       ↓
  Profile Manager (Phase 3)       ← decides which profile wins
       ↓
  Resource Controller (Phase 2)   ← applies resource settings
       ↓
  Operating System
```

The Profile Manager is **event-driven** (no polling). It subscribes
to `onWorkloadDetected`, `onPowerStateChanged`, and
`onIdleStateChanged` events. Profile changes occur only when relevant
events are received.

## Module Map

| Module | Role |
|---|---|
| `profiles/base-profile.js` | Abstract `Profile` class (validation, lifecycle, versioning) |
| `profiles/profile-registry.js` | Load/validate/inherit profiles from JSON/YAML/code |
| `profiles/profile-manager.js` | Orchestrator: subscribe to events, conflict resolution, activation |
| `profiles/builtin-profiles.js` | 9 built-in profile definitions |
| `profiles/index.js` | Public API surface |

## Profile Lifecycle

```
   Definition (JSON/YAML/code)
        ↓
   ProfileRegistry.register()
        ↓
   Validation (id, version, priority, inherits, settings)
        ↓
   Inheritance resolution (deep-merge parent settings)
        ↓
   ProfileManager.demand(source, profileId)
        ↓
   Conflict resolution (highest priority wins)
        ↓
   Profile.onActivate(context)    ← lifecycle hook (may veto)
        ↓
   ResourceControllerManager.applySettings()
        ↓
   Profile active
        ↓
   (new demand or event) ...
        ↓
   Profile.onDeactivate(context)  ← lifecycle hook
        ↓
   Next profile activated (or 'balanced' default)
```

## Configuration Format

Profiles can be defined in code (built-in) or loaded from a JSON/YAML
file (`PROFILE_FILE_PATH`).

### JSON Format

```json
{
  "profiles": [
    {
      "id": "my-custom-profile",
      "version": "1.0.0",
      "description": "Custom profile for my workload",
      "priority": 350,
      "inherits": ["balanced"],
      "settings": {
        "thermal": { "profile": "cool" },
        "power": { "profile": "performance" }
      },
      "metadata": {
        "author": "me",
        "tags": ["custom"]
      }
    }
  ]
}
```

### YAML Format

```yaml
profiles:
  - id: my-custom-profile
    version: "1.0.0"
    description: Custom profile for my workload
    priority: 350
    inherits:
      - balanced
    settings:
      thermal:
        profile: cool
      power:
        profile: performance
    metadata:
      author: me
      tags:
        - custom
```

### Array Format

The file may also be a bare array:

```json
[
  { "id": "profile-a", "version": "1.0.0" },
  { "id": "profile-b", "version": "1.0.0" }
]
```

## Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Unique identifier (kebab-case, max 64 chars) |
| `version` | string | ✅ | Semver version (X.Y.Z) |
| `description` | string | ❌ | Human-readable description |
| `priority` | integer | ❌ | Priority 0-1000 (default 100, higher = wins conflicts) |
| `inherits` | string[] | ❌ | Parent profile IDs to inherit settings from |
| `overrides` | object | ❌ | Per-domain overrides (takes precedence over inherited + own settings) |
| `settings` | object | ❌ | Resource settings to apply |
| `metadata` | object | ❌ | Free-form metadata |

### Settings Shape

The `settings` object can contain:

```json
{
  "thermal": { "profile": "balanced" | "cool" | "silent" },
  "power": { "profile": "balanced" | "power-saver" | "performance", "ppdProfile": "power-saver" | "balanced" | "performance" },
  "governor": { "governor": "performance" | "powersave" | ..., "cores": "foreground" | "background" | "all" }
}
```

## Validation Rules

The registry rejects profiles with:

- **Missing or invalid `id`** — must be kebab-case, max 64 chars
- **Missing or invalid `version`** — must be semver X.Y.Z
- **Invalid `priority`** — must be an integer 0-1000
- **Duplicate `id` + same `version`** — rejected (different version replaces)
- **Circular inheritance** — detected and rejected (falls back to raw settings)
- **Invalid `inherits` entries** — must be array of valid profile IDs
- **Non-object `settings`/`overrides`/`metadata`** — rejected

Invalid profiles never crash the daemon — they are skipped with a warning.

## Priority Rules

Higher priority wins conflicts. Default priority is 100.

### Built-in Profile Priorities

```
gaming           500   (highest)
battery-saver    450
rendering        400
development      300
streaming        250
performance      200
powersave        150
balanced         100   (default)
idle              50   (lowest)
```

### Conflict Examples

| Scenario | Winner | Reason |
|---|---|---|
| gaming (500) vs development (300) | gaming | higher priority |
| rendering (400) vs balanced (100) | rendering | higher priority |
| battery-saver (450) vs performance (200) | battery-saver | higher priority |
| idle (50) vs any active profile | any active | idle is lowest |
| idle (50) with empty demand set | idle | only candidate |
| two profiles same priority | first registered | tie-break by registration order |

## Inheritance

A profile may declare `inherits: ['parent-id', ...]`. The registry
resolves inheritance by deep-merging parent settings first, then the
child's own settings on top.

```json
{
  "id": "gaming",
  "version": "1.0.0",
  "priority": 500,
  "inherits": ["performance"],
  "overrides": {
    "thermal": { "profile": "cool" }
  }
}
```

In this example, `gaming` inherits all settings from `performance`,
then overrides the thermal profile to `cool`.

### Override Precedence

1. Parent settings (resolved recursively)
2. Child's own `settings`
3. Child's `overrides` (highest precedence)

### Circular Inheritance Detection

The registry detects circular inheritance chains (e.g. A inherits B,
B inherits A) and rejects them with a warning. The profile falls back
to its raw settings (no inheritance applied).

## Conflict Resolution

The ProfileManager maintains a **demand set** — a map of
`source → { profileId, priority, timestamp }`.

- Each detector can demand one profile at a time via its source name.
- When a detector withdraws its demand (e.g. idle ends), the entry
  is removed.
- The active profile is always the highest-priority entry in the
  demand set, or `balanced` (the default) if the set is empty.
- Ties are broken by earliest timestamp (first demanded wins).

### Event → Demand Mapping

| Event | Source | Profile Demanded |
|---|---|---|
| `onWorkloadDetected` with `workload: 'GAME'` | `workload` | `gaming` |
| `onWorkloadDetected` with `workload: 'IDE'` | `workload` | `development` |
| `onWorkloadDetected` with `workload: 'RENDERER'` | `workload` | `rendering` |
| `onWorkloadDetected` with `workload: 'MULTIMEDIA'` | `workload` | `streaming` |
| `onWorkloadDetected` with `workload: 'NONE'` | `workload` | (withdraw) |
| `onPowerStateChanged` with `to: 'BATTERY_LOW'` | `power` | `battery-saver` |
| `onPowerStateChanged` with `to: 'BATTERY_CRITICAL'` | `power` | `battery-saver` |
| `onPowerStateChanged` with `to: 'AC'` | `power` | (withdraw) |
| `onIdleStateChanged` with `to: 'IDLE'` (after timeout) | `idle` | `idle` |
| `onIdleStateChanged` with `to: 'ACTIVE'` | `idle` | (withdraw) |

## Idle Timeout

When the IdleStateDetector emits `onIdle`, the manager waits
`PROFILE_IDLE_TIMEOUT_MS` (default 300000 = 5 min) before activating
the `idle` profile. This prevents flicker on brief idle moments.

When `onIdleEnd` is received (user became active again), the timeout
is cancelled and the `idle` demand is withdrawn.

## Built-in Profiles (Examples)

### balanced

```json
{
  "id": "balanced",
  "version": "1.0.0",
  "description": "Balanced profile — factory defaults",
  "priority": 100,
  "settings": {
    "thermal": { "profile": "balanced" },
    "power": { "profile": "balanced" }
  }
}
```

### performance

```json
{
  "id": "performance",
  "version": "1.0.0",
  "description": "Performance profile — high foreground CPU weight",
  "priority": 200,
  "settings": {
    "thermal": { "profile": "balanced" },
    "power": { "profile": "performance" }
  }
}
```

### powersave

```json
{
  "id": "powersave",
  "version": "1.0.0",
  "description": "Powersave profile — conservative CPU weights",
  "priority": 150,
  "settings": {
    "thermal": { "profile": "balanced" },
    "power": { "profile": "power-saver" }
  }
}
```

### gaming

```json
{
  "id": "gaming",
  "version": "1.0.0",
  "description": "Gaming profile — performance + cool thermal",
  "priority": 500,
  "inherits": ["performance"],
  "overrides": {
    "thermal": { "profile": "cool" }
  }
}
```

### development

```json
{
  "id": "development",
  "version": "1.0.0",
  "description": "Development profile — IDE/compiler workloads",
  "priority": 300,
  "inherits": ["balanced"]
}
```

### rendering

```json
{
  "id": "rendering",
  "version": "1.0.0",
  "description": "Rendering profile — OBS/Blender/ffmpeg",
  "priority": 400,
  "inherits": ["performance"]
}
```

### streaming

```json
{
  "id": "streaming",
  "version": "1.0.0",
  "description": "Streaming profile — media playback",
  "priority": 250,
  "inherits": ["balanced"]
}
```

### battery-saver

```json
{
  "id": "battery-saver",
  "version": "1.0.0",
  "description": "Battery saver profile — powersave + silent thermal",
  "priority": 450,
  "inherits": ["powersave"],
  "overrides": {
    "thermal": { "profile": "silent" }
  }
}
```

### idle

```json
{
  "id": "idle",
  "version": "1.0.0",
  "description": "Idle profile — minimal resource usage",
  "priority": 50,
  "settings": {
    "thermal": { "profile": "balanced" },
    "power": { "profile": "power-saver" }
  }
}
```

## IPC Access

```bash
# Human-readable status
dynalloc profiles

# JSON output
dynalloc profiles --json
```

### Status Shape

```json
{
  "enabled": true,
  "running": true,
  "profileCount": 9,
  "activeProfileId": "gaming",
  "activeProfile": { "id": "gaming", "version": "1.0.0", ... },
  "demandSet": [
    { "source": "workload", "profileId": "gaming", "priority": 500 }
  ],
  "switchCount": 3,
  "lastSwitchAt": "2026-07-12T04:13:32.000Z",
  "profiles": [ { "id": "balanced", ... }, ... ]
}
```

## Hot-Reload

When the profile file changes (and `HOT_RELOAD=true`), the registry
re-reads the file, clears all profiles, re-registers them, and the
manager re-evaluates the active profile in case the currently-active
profile's settings changed.

## Backward Compatibility

When `ENABLE_PROFILE_MANAGER=false` (default):
- No ProfileManager is constructed.
- The PE's existing `applyProfile` action continues to work
  independently (it calls the RCM directly).
- Zero behavior change from Phase 2.

When `ENABLE_PROFILE_MANAGER=true`:
- The manager subscribes to detector events.
- Profiles are activated/deactivated automatically based on demand.
- The PE's `applyProfile` action still works (it bypasses the manager
  and calls the RCM directly — both can coexist).
