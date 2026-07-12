# ADR-0001: Resource Controller Abstraction

**Status:** Accepted (2026-07-12)
**Phase:** 0 (decision) → 1 (implementation)
**Supersedes:** none
**Superseded by:** none

## Context

Dynalloc v0.2.1 manages three resource domains — **CPU**, **Memory**, and **IO** —
plus several auxiliary concerns (OOM score adjustment, CPU governor switching,
cgroup setup, desktop notifications). All of these concerns live in a single
monolithic module, `actuator.js` (~477 lines), with a flat public API:

```js
// Current flat API (paraphrased)
actuator.applyToProcess(pid, { schedClass, nice, ioClass, ... });
actuator.setupCgroups();
actuator.cgroupBasePath;
actuator.dryRun;
actuator.rollbackRegistry;
// ... plus ~15 public methods
```

The upcoming transformation (Phases 2+) will add **Network QoS**, **Swap**,
**PID limits**, **GPU control**, **Accounting feedback**, and possibly more.
Continuing to add these as additional flat methods on `actuator.js` would:

1. Push the file past 1000+ lines, making review difficult.
2. Couple unrelated concerns — a Network QoS bug could regress CPU pinning.
3. Make per-controller feature flags (`ENABLE_NETWORK_QOS`, etc.) awkward
   to implement cleanly.
4. Make testing harder — every new controller would need to instantiate
   the full actuator with all its dependencies.
5. Violate the project's stated Architecture Validation rule:
   > "Controllers remain independent."

## Decision

Introduce a `ResourceController` abstract base class in Phase 1, then refactor
the existing CPU/Memory/IO logic in `actuator.js` into concrete subclasses.
New controllers (Phase 2+) implement the same interface.

### Proposed interface

```js
// lib/resource-controller.js (new file, Phase 1)
class ResourceController {
  constructor(name, deps) {
    this.name = name;              // 'cpu' | 'memory' | 'io' | 'network' | ...
    this.deps = deps;              // { config, logger, cgroupBasePath, dryRun, ... }
  }

  // Lifecycle — called by daemon bootstrap, in dependency order
  async setup() {}                 // one-time init (e.g. cgroup subtree creation)
  async start() {}                 // begin periodic work (if any)
  async stop() {}                  // graceful shutdown, restore originals

  // Per-process policy application — called by scheduler
  async applyToProcess(pid, classification, opts) {}

  // Capability probe — called by self-check
  isAvailable() { return true; }   // false → controller disabled, daemon degrades

  // Rollback / recovery — called by RollbackManager on crash recovery
  async recoverState(savedState) {}
  async buildStateSnapshot() { return {}; }

  // Status — surfaced via IPC `status` command
  getStatus() { return { name: this.name, available: this.isAvailable() }; }
}
```

### Subclass plan (Phase 1)

| Subclass | Source of original logic | New file |
|----------|--------------------------|----------|
| `CpuController` | `actuator.js` affinity + nice + cgroup `cpu.weight` + `cpu.max` | `lib/controllers/cpu-controller.js` |
| `MemoryController` | `actuator.js` `memory.max` + `memory.high` + `memory.oom.group` + `oom_score_adj` | `lib/controllers/memory-controller.js` |
| `IoController` | `actuator.js` `ionice` + cgroup `io.max` | `lib/controllers/io-controller.js` |
| `GovernorController` | `governor.js` (already a separate module, just wrap) | `lib/controllers/governor-controller.js` |
| `CgroupManager` | `actuator.js` `setupCgroups` + cgroup path resolution | `lib/cgroup-manager.js` (shared util) |
| `Actuator` (facade) | Backward-compat shim — delegates to the above | `actuator.js` (rewritten, same public API) |

### Backward compatibility contract

**The public `actuator.js` API MUST NOT change in Phase 1.** Every existing
caller (`daemon.js`, `scheduler.js`, `rollback.js`, `policy-engine/action-executor.js`,
tests, scripts) must continue to work without code changes.

Concretely, after Phase 1:

```js
const actuator = require('./actuator');
// All of these still work identically:
actuator.applyToProcess(pid, opts);
actuator.setupCgroups();
actuator.cgroupBasePath;
actuator.dryRun;
actuator.getModifiedPids();
actuator.restoreAll();
// ...
```

Internally, `actuator.js` becomes a thin facade that instantiates the
controller subclasses and forwards calls. Existing tests (which use the
public API) serve as the regression gate.

### New directory layout

```
dylok/
├── actuator.js                          # facade (rewritten, same exports)
├── lib/
│   ├── resource-controller.js           # abstract base class
│   ├── cgroup-manager.js                # shared cgroup path/setup utility
│   └── controllers/
│       ├── cpu-controller.js
│       ├── memory-controller.js
│       ├── io-controller.js
│       └── governor-controller.js
├── policy-engine/                       # unchanged
├── plugins/                             # unchanged
└── ...
```

## Alternatives Considered

### A. Parallel modules (no refactor)

Add new controllers as standalone modules alongside `actuator.js` without
refactoring. New code calls the new modules; existing code keeps calling
`actuator.js`.

**Rejected because:**
- Duplicates cgroup setup logic in every new controller.
- `actuator.js` keeps growing with each new resource domain.
- Per-controller feature flags become inconsistent.
- Violates the Architecture Validation rule "controllers remain independent."

### B. Refactor everything into a plugin system

Reframe resource controllers as a special class of plugin loaded via
`plugin-manager.js`.

**Rejected because:**
- Plugin API is detection-oriented (`detect(procs, ctx) → actions[]`),
  not control-oriented. Forcing controllers into it would distort both.
- Plugins are best-effort and isolated; controllers are core and required.
- Conflating two different abstractions increases cognitive load.

### C. Wait until Phase 2 forces the refactor

Defer the abstraction until the second new resource domain (Phase 3) makes
the duplication painful.

**Rejected because:**
- The first new controller (Network QoS, Phase 2) would be implemented
  ad-hoc, then retroactively refactored in Phase 3. That's two rewrites
  instead of one.
- The protocol explicitly states "Never sacrifice stability for new features"
  — but it also requires "Modular architecture preserved." Doing the
  refactor before adding new code is more stable than refactoring
  under load.

## Consequences

### Positive

- Each controller has a single responsibility and a bounded LOC budget.
- New controllers (Phase 2+) follow a known pattern — reduced cognitive load.
- Per-controller feature flags become trivial (`config.ENABLE_NETWORK_QOS`).
- Testing becomes per-controller — easier to isolate failures.
- `actuator.js` shrinks to a facade, easier to review.
- Sets a clean extension point for community-contributed controllers.

### Negative

- Phase 1 is pure refactor with no user-visible feature — costs engineering
  time without delivering new capability. Acceptable per the project charter
  ("Stability > Features").
- Introduces a new `lib/` directory — slight increase in project surface area.
- The facade must be carefully written to preserve exact semantics (timing,
  error handling, log message ordering). Tests are the safety net.

### Risk mitigation

- Run the full 451-test suite after every refactor step, not just at the end.
- Keep `actuator.js`'s log messages byte-identical (some tests assert on log text).
- Use `git mv` to preserve file history when extracting code.
- No new dependencies introduced — pure JavaScript refactor.

## Validation Plan (Phase 1)

Before Phase 1 is declared complete, ALL of the following must hold:

1. **Build:** `npm run syntax-check` passes on every `.js` file.
2. **Tests:** All 451 existing tests pass unchanged (no test edits).
3. **Functional:** Daemon boots in DRY_RUN, completes self-check, shuts down cleanly.
4. **API:** A dedicated `scripts/verify-actuator-api.js` confirms every public
   method on the old `actuator.js` is still present and callable on the new
   facade.
5. **No perf regression:** Cold-start time and idle CPU/RAM match baseline ±5%.
6. **No memory leak:** 60-second dry-run soak shows RSS growth < 1 MB.
7. **Architecture review:** Each controller can be `require()`-ed in isolation
   without pulling in unrelated controllers.

## References

- Project charter: "Stability > Features. Reliability > Speed. Maintainability
  > Complexity. Correctness > Quantity."
- Architecture Validation rule: "Controllers remain independent. Policy Engine
  remains modular. Plugin API is not broken. Scheduler remains isolated. Event
  system remains extensible."
- Baseline test count: 451 (336 unit + 100 integration + 15 policy integration)
