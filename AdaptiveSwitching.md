# Adaptive Switching

## Overview

The Adaptive Switching Engine wraps the Profile Manager with
production-grade stability guarantees: debouncing, cooldowns,
oscillation detection, rollback on failure, and user overrides.

## Architecture

```
  User Events / Detector Layer / PE / Plugins
       ↓
  Event Bus
       ↓
  Adaptive Engine (Phase 4)        ← debounce, cooldown, rollback, override
       ↓
  Profile Manager (Phase 3)        ← demand set + conflict resolution
       ↓
  Resource Controller (Phase 2)    ← applies settings
       ↓
  Operating System
```

The engine is **event-driven** (no polling). It subscribes to
`onWorkloadDetected`, `onPowerStateChanged`, and `onIdleStateChanged`
bus events. When the engine is active, the Profile Manager's own bus
subscriptions are stopped — the engine is the sole event handler and
forwards validated transitions to the PM.

## Module Map

| Module | Role |
|---|---|
| `adaptive/transition-manager.js` | Debounce, cooldown, oscillation detection, history, rollback coordination |
| `adaptive/adaptive-engine.js` | Event-driven switching engine + user override + rollback |
| `adaptive/index.js` | Public API surface |

## Transition Lifecycle

```
   Bus Event
       ↓
   AdaptiveEngine._handleEvent()
       ↓
   _predictProfileForEvent()        ← what profile would this activate?
       ↓
   TransitionManager.evaluateTransition()
       ├─ same-profile? → suppress (no-op)
       ├─ rollback? → allow (bypass cooldown)
       ├─ user-override? → allow (bypass cooldown)
       ├─ cooldown active? → suppress
       └─ oscillation detected? → suppress
       ↓ (allowed)
   TransitionManager.debounceTransition()
       ↓ (after debounce delay)
   _executeTransition()
       ├─ _forwardToPM() → PM updates demand set + activates profile
       ├─ success? → record + emit onProfileTransitionSucceeded
       └─ failure? → _rollback() + emit onProfileTransitionFailed
       ↓
   TransitionManager.recordTransition()
       ├─ add to history (ring buffer)
       ├─ update cooldown timestamp
       └─ update oscillation window
```

## Stability Guarantees

| Guarantee | Mechanism |
|---|---|
| No oscillation | Oscillation detector: N transitions in window → suppress |
| No rapid flicker | Cooldown: minimum dwell time per profile |
| No event storms | Debounce: coalesce rapid events into one transition |
| No duplicate processing | Same-profile transitions suppressed as no-op |
| No recursive transitions | AE is sole event handler (PM subscriptions stopped) |
| No infinite loops | Oscillation detection + bounded history |
| Safe rollback | Failed activation → restore previous profile |
| User override | demandUserOverride() bypasses cooldown, wins all conflicts |

## Configuration

| Key | Default | Description |
|---|---|---|
| `ENABLE_ADAPTIVE_SWITCHING` | `false` | Master switch |
| `ADAPTIVE_DEBOUNCE_MS` | `200` | Coalesce rapid events |
| `ADAPTIVE_COOLDOWN_MS` | `1000` | Minimum dwell time per profile |
| `ADAPTIVE_USER_OVERRIDE_PRIORITY` | `1000` | User override priority |
| `ADAPTIVE_MAX_HISTORY` | `100` | History ring buffer size |
| `ADAPTIVE_OSCILLATION_WINDOW_MS` | `10000` | Oscillation detection window |
| `ADAPTIVE_OSCILLATION_THRESHOLD` | `5` | Transitions in window before flag |

## Event Flow

### Gaming Detected

```
  Detector: workload = GAME
       ↓
  Bus: onWorkloadDetected { workload: 'GAME' }
       ↓
  AE: _predictProfileForEvent → 'gaming'
       ↓
  TM: evaluateTransition → allowed (no cooldown, no oscillation)
       ↓
  TM: debounceTransition (200ms)
       ↓
  AE: _forwardToPM → PM.demand('workload', 'gaming')
       ↓
  PM: conflict resolution → gaming (priority 500) wins
       ↓
  PM: _activateProfile('gaming') → RCM.applySettings()
       ↓
  AE: recordTransition (success) → emit onProfileTransitionSucceeded
```

### Battery Critical Overrides Gaming

```
  Detector: power = BATTERY_CRITICAL
       ↓
  Bus: onPowerStateChanged { to: 'BATTERY_CRITICAL' }
       ↓
  AE: _predictProfileForEvent → 'battery-saver'
       ↓
  TM: evaluateTransition → allowed
       ↓
  AE: _forwardToPM → PM.demand('power', 'battery-saver')
       ↓
  PM: conflict resolution → battery-saver (450) > gaming (500)?
       ↓ No! gaming (500) > battery-saver (450)
       ↓
  PM: active profile stays 'gaming'
       ↓
  AE: no transition (same profile) → suppressed as no-op
```

Note: In the current priority scheme, gaming (500) wins over
battery-saver (450). To make battery-saver override gaming, either:
- Increase battery-saver priority above gaming
- Use a user override: `demandUserOverride('battery-saver')`

### Rendering Finishes → Restore Previous

```
  Detector: workload = NONE (rendering finished)
       ↓
  Bus: onWorkloadDetected { workload: 'NONE' }
       ↓
  AE: _predictProfileForEvent → null (withdraw demand)
       ↓
  AE: _forwardToPM → PM.demand('workload', null)
       ↓
  PM: demand set loses 'workload' entry
       ↓
  PM: conflict resolution → next-highest demand wins (or 'balanced')
       ↓
  PM: _activateProfile(next) → RCM.applySettings()
```

### Idle Timeout

```
  Detector: idle = IDLE
       ↓
  Bus: onIdleStateChanged { to: 'IDLE' }
       ↓
  AE: _predictProfileForEvent → 'idle'
       ↓
  TM: evaluateTransition → allowed
       ↓
  TM: debounceTransition (200ms)
       ↓ (after debounce)
  AE: _forwardToPM → PM._handleIdleState({ to: 'IDLE' })
       ↓
  PM: starts idle timer (PROFILE_IDLE_TIMEOUT_MS = 300000)
       ↓ (after 5 min)
  PM: demand('idle', 'idle') → activates idle profile
```

### User Override

```
  User: demandUserOverride('performance')
       ↓
  AE: validate profile exists
       ↓
  AE: PM._demand.set('__user_override__', { profileId: 'performance', priority: 1000, timestamp: 0 })
       ↓
  PM: _reevaluate() → performance (1000) wins all conflicts
       ↓
  PM: _activateProfile('performance')
       ↓
  AE: recordTransition (user-override)
       ↓
  (later) User: releaseUserOverride()
       ↓
  AE: PM._demand.delete('__user_override__')
       ↓
  PM: _reevaluate() → falls back to next-highest demand
```

## Rollback Behavior

When a profile activation fails (e.g. RCM throws):

```
  AE: _executeTransition()
       ↓
  PM: _activateProfile('gaming') → _applySettings() → THROWS
       ↓
  AE: catch (err)
       ↓
  AE: _rollback('balanced', 'gaming', error)
       ↓
  AE: PM._demand.set('__rollback__', { profileId: 'balanced', priority: 100, timestamp: 0 })
       ↓
  PM: _reevaluate() → activates 'balanced' (rollback)
       ↓
  AE: emit onProfileTransitionFailed { from: 'balanced', to: 'gaming', error }
       ↓
  AE: recordTransition({ success: false }) → TM sets _rollbackPending = true
       ↓
  (next transition) TM: isRollback → bypasses cooldown
```

The daemon NEVER terminates because of a failed transition. The
rollback restores the previous profile and the engine continues
processing events.

## Transition History

The TransitionManager maintains a bounded ring buffer of recent
transitions (default: 100 entries). Each entry records:

```json
{
  "timestamp": 1783830482672,
  "from": "balanced",
  "to": "gaming",
  "success": true,
  "durationMs": 12,
  "error": null,
  "reason": "onWorkloadDetected"
}
```

Access via `tm.getHistory(count)` or the IPC `adaptive` handler.

## IPC Access

```bash
# Status
dynalloc adaptive
dynalloc adaptive --json

# User override
echo '{"cmd":"adaptive-override","args":{"action":"demand","profile":"performance"}}' | dynalloc-ipc
echo '{"cmd":"adaptive-override","args":{"action":"release"}}' | dynalloc-ipc
```

## Events Emitted

| Event | Payload | When |
|---|---|---|
| `onProfileTransitionSucceeded` | `{ from, to, durationMs, reason }` | Profile activation succeeded |
| `onProfileTransitionFailed` | `{ from, to, error, durationMs, reason }` | Profile activation failed + rollback |

## Backward Compatibility

When `ENABLE_ADAPTIVE_SWITCHING=false` (default):
- No AdaptiveEngine is constructed.
- The Profile Manager receives events directly (Phase 3 behavior).
- Zero behavior change from Phase 3.

When `ENABLE_ADAPTIVE_SWITCHING=true`:
- The engine subscribes to detector events.
- The PM's bus subscriptions are stopped (engine is sole handler).
- The PM's demand set, conflict resolution, and profile activation
  all continue to work — events are forwarded via `_forwardToPM()`.
