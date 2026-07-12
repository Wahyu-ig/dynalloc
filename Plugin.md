# Plugin System

## Plugin Interface Specification

Every plugin must export a JavaScript object conforming to this interface:

```javascript
module.exports = {
  // Required fields
  name: string,            // Unique plugin identifier (e.g. 'spotify')
  version: string,         // Semver version string (e.g. '1.0.0')
  description: string,     // Human-readable description
  detect: function,        // Core detection function (required)

  // Optional lifecycle hooks
  init: function,          // Called once on daemon startup with (config)
  destroy: function,       // Called once on daemon shutdown
};
```

### `detect(procs, context)` → `Array<{ pid, action, reason }>`

Called on every slowTick when `ENABLE_PLUGINS` is `true` and the scheduler stress level is not `NORMAL`.

**Parameters:**

- `procs` — `Array<{ pid: number, ppid: number, pcpu: number, comm: string }>` — the current process list.
- `context` — `Object` with:
  - `mediaPids` — `Set<number>` — PIDs detected as actively playing media.
  - `foregroundPid` — `number | null` — current foreground window PID.
  - `gameModeActive` — `boolean` — whether Feral GameMode is active.

**Return value:** An array of detection result objects. Each object must have:

| Field | Type | Description |
|---|---|---|
| `pid` | number | The process ID being detected (must be > 0). |
| `action` | string | Suggested action: `"BOOST"`, `"PROTECT"`, or `"MONITOR"`. |
| `reason` | string | Human-readable reason for the detection. |

Results with invalid or missing PIDs are silently discarded. Plugin errors are caught and logged as warnings — they never crash the daemon.

### `init(config)`

Called once during daemon bootstrap, after all plugins are registered. Receives the full merged config object. Use this to initialize expensive resources or validate prerequisites.

### `destroy()`

Called once during daemon shutdown. Use this to clean up resources (close handles, kill child processes, etc.).

## Built-in Plugins

All built-in plugins are located in the `plugins/` directory and are auto-loaded when `ENABLE_PLUGINS` is `true`.

| Plugin | File | Description |
|---|---|---|
| **spotify** | `plugins/spotify.js` | Protects Spotify from throttling when it is in the media PIDs set (actively playing music). |
| **game** | `plugins/game.js` | Detects game processes (SteamApp, UnityPlayer, Godot, Wine, Proton) and suggests boosting them. |
| **discord** | `plugins/discord.js` | Protects Discord from throttling when voice activity is detected (via media PIDs). |
| **browser** | `plugins/browser.js` | Protects browser main processes (Chrome, Firefox, Brave, etc.) when they are playing media. |
| **obs** | `plugins/obs.js` | Protects OBS Studio during recording/streaming (media PIDs). Also monitors OBS when CPU > 5%. |
| **steam** | `plugins/steam.js` | Monitors the Steam client. Boosts Steam games when GameMode is active and the game is foreground. |
| **multimedia** | `plugins/multimedia.js` | Name-based multimedia protection for processes not already caught by PipeWire/PulseAudio detection. |
| **wallpaper** | `plugins/wallpaper.js` | Protects video wallpaper processes (mpvpaper, swww, hyprpaper, wpaperd, etc.) from throttling. |
| **system** | `plugins/system.js` | Placeholder for future system health monitoring. Returns empty detections. |

## Plugin Actions

The plugin system defines three action types, though the daemon currently uses the detection results for informational and metric purposes. The core scheduling logic in `scheduler.js` handles actual throttle/boost decisions independently:

| Action | Intent |
|---|---|
| `"BOOST"` | The process should receive elevated priority (e.g., a game). |
| `"PROTECT"` | The process should be exempt from throttling (e.g., media playback). |
| `"MONITOR"` | The process is noteworthy but doesn't need action yet (e.g., Steam client idle). |

## Plugin Loading Mechanism

1. **Built-in loading**: `PluginManager.loadBuiltinPlugins()` scans the `plugins/` directory (relative to the main script) for all `.js` files.
2. **Custom loading**: If `PLUGIN_DIR` is set in config, `loadCustomPlugins()` scans that directory using the same mechanism.
3. **Registration**: Each file is `require()`'d and checked for a valid plugin interface (`name` string + `detect` function).
4. **Deduplication**: If a plugin with the same `name` is already registered, the new one is skipped with a warning.
5. **Initialization**: After all plugins are loaded, `initAll(config)` is called for every plugin that has an `init` method.
6. **Execution**: On each slowTick (when stress is not NORMAL), `runDetection(procs, context)` calls every plugin's `detect()` and aggregates results into a `Map<pid, { actions: string[], reasons: string[], plugins: string[] }>`.
7. **Shutdown**: `destroyAll()` calls `destroy()` on every plugin with that method, then clears the registry.

## Plugin Directory Configuration

Set `PLUGIN_DIR` to the absolute path of a directory containing custom `.js` plugin files:

```json
{
  "PLUGIN_DIR": "/home/user/.config/dynalloc/plugins"
}
```

**Note:** `PLUGIN_DIR` is **not** hot-reloadable. Changing it requires a daemon restart.

## Writing a Custom Plugin

Create a `.js` file in your plugin directory (or add to the built-in `plugins/` directory):

```javascript
'use strict';

/**
 * Plugin: My Custom Detector
 *
 * Example: boost any process with 'myapp' in the name.
 */

module.exports = {
  name: 'myapp',
  version: '1.0.0',
  description: 'Boosts myapp processes when they are active',

  // Optional: called once on startup
  init(config) {
    // Access config values if needed
    // e.g., config.FOREGROUND_CORE_RESERVE
  },

  // Required: called on every slowTick
  detect(procs, context) {
    const results = [];

    for (const proc of procs) {
      if (!/myapp/i.test(proc.comm)) continue;

      // Only boost if CPU usage is significant
      if (proc.pcpu > 2) {
        results.push({
          pid: proc.pid,
          action: 'BOOST',
          reason: `myapp process active (CPU: ${proc.pcpu}%)`,
        });
      }
    }

    return results;
  },

  // Optional: called once on shutdown
  destroy() {
    // Clean up resources
  },
};
```

### Best Practices

1. **Keep `detect()` fast** — it runs on every slowTick (default 3 seconds). Avoid expensive syscalls, network calls, or file I/O inside `detect()`.
2. **Use `context.mediaPids`** — check if a PID is already media-protected before adding duplicate protection logic.
3. **Use `context.foregroundPid`** — avoid boosting the foreground process (the daemon already handles this).
4. **Handle missing data gracefully** — `proc.pcpu` may be `undefined` or `NaN` in edge cases. Guard with `typeof` checks.
5. **Return an empty array** when there's nothing to detect — never return `null` or `undefined`.
6. **Make `name` unique** — if two plugins share a name, the second one is silently skipped.
---

## Policy Engine Integration (v2.2)

When the Policy Engine is enabled (`ENABLE_POLICY_ENGINE: true`),
plugins can subscribe to the engine's EventBus and emit custom events.
This enables powerful patterns like:

- A wallpaper plugin emitting `onWallpaperChanged` so a palette
  plugin can react.
- A custom plugin listening for `onBatteryLow` to trigger cleanup.
- A plugin emitting a custom event that other plugins or rules
  react to.

### Accessing the EventBus

The daemon injects the policy engine instance into the plugin
`init()` config under `config.__policyEngine` (only set when the
engine is enabled):

```js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',

  init(config) {
    this._engine = config.__policyEngine;
    this._listenerIds = [];

    if (this._engine) {
      // Subscribe to standard events
      this._listenerIds.push(
        this._engine.bus.on('onWallpaperChanged', (payload) => {
          this._onWallpaperChanged(payload);
        })
      );

      // Subscribe to ALL events (wildcard) for debugging
      this._listenerIds.push(
        this._engine.bus.on('*', (eventName, payload) => {
          console.log(`[my-plugin] event: ${eventName}`);
        }, { priority: 100 })  // higher priority = fires first
      );
    }
  },

  destroy() {
    if (this._engine) {
      for (const id of this._listenerIds) {
        this._engine.bus.off(id);
      }
    }
  },

  detect(procs, ctx) { return []; },

  _onWallpaperChanged(payload) {
    // React to wallpaper change
  },
};
```

### Standard Events

See [PolicyEngine.md](PolicyEngine.md#event-bus) for the full list
of standard events. The most useful for plugins:

| Event | When |
|---|---|
| `onWallpaperChanged` | Wallpaper changed (manual emit or refreshPalette action) |
| `onForegroundChanged` | Active window PID changed |
| `onProcessStarted` | New process name detected |
| `onPluginLoaded` | Another plugin was registered |
| `onProfileChanged` | A policy profile was applied |

### Emitting Custom Events

A plugin can emit any event name — rules can match on it:

```js
// In a plugin
this._engine.bus.emit('onMyCustomEvent', { foo: 'bar', count: 42 });
```

```json
// In policies.json
{
  "rules": [
    {
      "id": "react-to-custom",
      "when": { "event": "onMyCustomEvent" },
      "match": { "foo": "bar" },
      "action": { "type": "log", "message": "Custom event received" }
    }
  ]
}
```

### Best Practices

1. **Always clean up listeners in `destroy()`.** Failing to do so
   leaks closures and prevents the plugin from being garbage
   collected.
2. **Use specific event names** (e.g. `onPaletteExtracted`) rather
   than overloading standard names.
3. **Don't emit events from `detect()`.** The daemon calls `detect()`
   synchronously during slowTick — emitting events there can cause
   re-entrancy issues. Emit from `init()`, async callbacks, or
   external watchers instead.
4. **Be a good citizen.** If your plugin's listener throws, the bus
   catches it and logs a warning — but other listeners in the same
   dispatch still fire. Don't rely on exceptions for flow control.
