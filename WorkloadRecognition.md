# Workload Recognition

## Overview

The Workload Recognition Engine identifies workload categories (gaming,
development, rendering, etc.) using deterministic rules and heuristics,
then maps them to optimization strategies and demands the corresponding
profile from the Profile Manager.

## Architecture

```
  User Events
       ↓
  Detector Layer (Phase 1)           ← observes system state
       ↓
  Workload Recognition Engine (Phase 5)  ← confidence + multi-source
       ↓
  Profile Manager (Phase 3)          ← demand set + conflict resolution
       ↓
  Adaptive Switching Engine (Phase 4) ← debounce + cooldown + rollback
       ↓
  Resource Controller (Phase 2)      ← applies settings
       ↓
  Operating System
```

The engine is **event-driven** (no polling). It subscribes to detector
events and runs recognition with a debounce timer.

## Detection Flow

```
   Detector: workload = GAME, comm = UnityPlayer
       ↓
   Bus: onWorkloadDetected { workload: 'GAME', comm: 'UnityPlayer' }
       ↓
   RecognitionEngine._handleWorkload()
       ↓
   Build recognition context (foregroundComm, workloadClassification, ...)
       ↓
   Debounce (RECOGNITION_DEBOUNCE_MS = 300ms)
       ↓
   WorkloadRecognizer.recognize(context)
       ↓
   For each rule:
     ├─ rule.match(context) → does this rule apply?
     └─ rule.confidence(context) → 0.0-1.0
       ↓
   Filter by confidence threshold (≥ 0.60)
       ↓
   Sort by confidence descending
       ↓
   Top detection → PM.demand('recognition', profile)
       ↓
   Emit onWorkloadRecognized { workload, profile, confidence, source }
```

## 14 Workload Categories

| Category | Profile | Description |
|---|---|---|
| gaming | gaming | Low latency, high performance, aggressive CPU |
| development | development | Balanced CPU, fast filesystem |
| web-browsing | balanced | Lightweight, responsive |
| office-productivity | balanced | Stable, low overhead |
| video-editing | rendering | Maximum sustained performance |
| audio-production | streaming | Low-latency audio |
| 3d-rendering | rendering | GPU-heavy, thermal-aware |
| streaming | streaming | Multimedia protection |
| virtual-machines | balanced | Memory-heavy |
| containers | balanced | IO-aware |
| ai-ml | performance | GPU-heavy compute |
| file-compression | balanced | CPU-burst |
| idle | idle | Minimal resource usage |
| background-tasks | balanced | Low priority, does not override |

## Confidence Model

Each detection includes a confidence score (0.0-1.0) computed from
multiple sources:

| Source | Weight | Description |
|---|---|---|
| Process name match | 0.50 | Strong signal from classifier.js |
| CPU pattern match | 0.20 | e.g. >50% CPU for compiler |
| GPU pattern match | 0.15 | e.g. >80% GPU for gaming/rendering |
| Memory pattern match | 0.10 | e.g. high RSS for VM |
| I/O pattern match | 0.05 | e.g. high IO for compression |

### Confidence Threshold

When confidence < `RECOGNITION_CONFIDENCE_THRESHOLD` (default 0.60),
the engine does NOT switch profiles — it maintains the current profile
until confidence improves. This prevents false positives and profile
oscillation.

### Detection Shape

```json
{
  "workload": "gaming",
  "profile": "gaming",
  "confidence": 0.80,
  "source": "gaming-name",
  "ruleId": "gaming-name",
  "timestamp": 1783830482672,
  "reason": "gaming-name comm=UnityPlayer class=GAME gpu=85% cpu=15%",
  "context": {
    "foregroundComm": "UnityPlayer",
    "workloadClassification": "GAME",
    "cpuPressure": 15,
    "gpuUtilization": 85,
    "memoryUsage": 0,
    "processCount": 0,
    "idleState": "ACTIVE"
  }
}
```

## Optimization Strategy Mapping

Each workload category maps to an optimization strategy that defines
resource priorities:

```json
{
  "workload": "gaming",
  "profile": "gaming",
  "description": "Low latency, high performance, aggressive CPU policy, optimized I/O",
  "priorities": {
    "cpu": "high",
    "gpu": "high",
    "io": "high",
    "memory": "medium",
    "thermal": "aggressive",
    "power": "performance"
  }
}
```

## Conflict Resolution

When multiple workloads are detected simultaneously (e.g. Gaming +
Streaming), the engine demands only the TOP-confidence workload's
profile. The PM's priority system + the Adaptive Engine's
cooldown/oscillation detection handle the rest.

**Examples:**
- Gaming (0.80) + Streaming (0.60) → Gaming wins (higher confidence)
- Development (0.65) + Virtual Machine (0.60) → Development wins
- Rendering (0.85) + Battery Saver (demand from power detector) →
  PM conflict resolution picks the higher-priority profile

## Plugin Extension Guide

Plugins can register custom recognition rules:

```js
const { WorkloadRecognizer } = require('./recognition');

// Access the engine's recognizer (via daemon state or direct reference)
engine.recognizer.registerRule({
  id: 'my-plugin-rule',           // unique ID
  workload: 'custom-workload',    // workload category
  profile: 'my-profile',          // profile to activate
  match: (ctx) => {               // does this rule apply?
    return ctx.foregroundComm === 'my-app';
  },
  confidence: (ctx) => {          // 0.0-1.0
    return 0.80;
  },
});

// Unregister when done
engine.recognizer.unregisterRule('my-plugin-rule');
```

### Rule Interface

```typescript
interface RecognitionRule {
  id: string;                    // unique kebab-case ID
  workload: string;              // workload category
  profile: string;               // profile to activate
  match: (context: RecognitionContext) => boolean;
  confidence: (context: RecognitionContext) => number;
}
```

### Recognition Context

```typescript
interface RecognitionContext {
  foregroundComm: string;        // e.g. 'firefox'
  foregroundPid: number | null;
  workloadClassification: string; // GAME, IDE, BROWSER, etc.
  cpuPressure: number;           // PSI avg10
  memPressure: number;           // PSI avg10
  gpuUtilization: number | null; // 0-100
  memoryUsage: number;           // percentage
  processCount: number;
  mediaPidsCount: number;
  idleState: 'ACTIVE' | 'IDLE';
  onBattery: boolean;
  batteryCapacity: number;       // 0-100
}
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `ENABLE_WORKLOAD_RECOGNITION` | `false` | Master switch |
| `RECOGNITION_CONFIDENCE_THRESHOLD` | `0.60` | Minimum confidence to switch |
| `RECOGNITION_DEBOUNCE_MS` | `300` | Debounce for recognition events |

## IPC Access

```bash
# Status
dynalloc recognition
dynalloc recognition --json
```

## Events Emitted

| Event | Payload | When |
|---|---|---|
| `onWorkloadRecognized` | `{ workload, profile, confidence, source, reason }` | High-confidence workload recognized + profile demanded |

## Backward Compatibility

When `ENABLE_WORKLOAD_RECOGNITION=false` (default):
- No RecognitionEngine is constructed.
- The Phase 4 AdaptiveEngine continues to receive detector events.
- Zero behavior change from Phase 4.

When `ENABLE_WORKLOAD_RECOGNITION=true`:
- The engine adds a `'recognition'` demand source to the PM.
- The PM's conflict resolution handles the new demand alongside
  existing demands (workload, power, idle).
- The AdaptiveEngine's debounce/cooldown/oscillation detection still
  applies to all profile transitions.
