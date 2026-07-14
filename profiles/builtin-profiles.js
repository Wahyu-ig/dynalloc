'use strict';

/**
 * DynAlloc — Profile Layer :: Built-in Profiles
 * ==============================================
 *
 * The 9 default profiles that ship with Dynalloc. These are DEFINITIONS
 * ONLY — they do not aggressively tune the OS. Each profile declares
 * resource settings that the ResourceControllerManager can apply.
 *
 * Built-in profiles (in registration order):
 *
 *   1. balanced       — factory defaults, no aggressive tuning
 *   2. performance    — high foreground priority, governor on
 *   3. powersave      — conservative, governor off
 *   4. gaming         — inherits performance + cool thermal
 *   5. development    — inherits balanced + IDE-friendly scheduler
 *   6. rendering      — inherits performance + high IO priority
 *   7. streaming      — inherits balanced + multimedia protection
 *   8. battery-saver  — inherits powersave + aggressive thermal
 *   9. idle           — lowest priority, minimal resource usage
 *
 * Priority system (higher = wins conflicts):
 *
 *   gaming           500   (gaming > everything except battery-critical)
 *   rendering        400   (rendering > balanced)
 *   development      300   (development > balanced)
 *   streaming        250   (streaming > balanced)
 *   battery-saver    450   (battery-saver > performance, but < gaming)
 *   performance      200
 *   balanced         100   (default)
 *   powersave        150   (powersave > balanced when explicitly demanded)
 *   idle              50   (lowest — only wins when nothing else is active)
 *
 * Conflict examples:
 *
 *   gaming (500) > development (300)     → gaming wins
 *   rendering (400) > balanced (100)     → rendering wins
 *   battery-saver (450) > performance (200) → battery-saver wins
 *   idle (50) < any active profile       → idle only wins when demand set is empty
 *
 * Inheritance:
 *
 *   gaming inherits performance (gets all performance settings + cool thermal)
 *   battery-saver inherits powersave (gets all powersave settings + silent thermal)
 *
 * Backward compatibility: only loaded when ENABLE_PROFILE_MANAGER is true.
 */

// ── Built-in profile definitions ─────────────────────────────────────

const BUILTIN_DEFINITIONS = [
  // 1. Balanced — factory defaults
  {
    id: 'balanced',
    version: '1.0.0',
    description: 'Balanced profile — factory defaults, no aggressive tuning',
    priority: 100,
    settings: {
      thermal: { profile: 'balanced' },
      power: { profile: 'balanced' },
    },
    metadata: { author: 'dynalloc', tags: ['default'] },
  },

  // 2. Performance — high foreground priority
  {
    id: 'performance',
    version: '1.0.0',
    description: 'Performance profile — high foreground CPU weight, governor on',
    priority: 200,
    settings: {
      thermal: { profile: 'balanced' },
      power: { profile: 'performance' },
    },
    metadata: { author: 'dynalloc', tags: ['performance'] },
  },

  // 3. Powersave — conservative
  {
    id: 'powersave',
    version: '1.0.0',
    description: 'Powersave profile — conservative CPU weights, governor off',
    priority: 150,
    settings: {
      thermal: { profile: 'balanced' },
      power: { profile: 'power-saver' },
    },
    metadata: { author: 'dynalloc', tags: ['powersave'] },
  },

  // 4. Gaming — inherits performance + cool thermal
  {
    id: 'gaming',
    version: '1.0.0',
    description: 'Gaming profile — performance settings + aggressive thermal protection',
    priority: 500,
    inherits: ['performance'],
    overrides: {
      thermal: { profile: 'cool' },
    },
    metadata: { author: 'dynalloc', tags: ['game', 'interactive'] },
  },

  // 5. Development — inherits balanced (no aggressive tuning, just metadata)
  {
    id: 'development',
    version: '1.0.0',
    description: 'Development profile — balanced settings for IDE/compiler workloads',
    priority: 300,
    inherits: ['balanced'],
    metadata: { author: 'dynalloc', tags: ['ide', 'compiler'] },
  },

  // 6. Rendering — inherits performance
  {
    id: 'rendering',
    version: '1.0.0',
    description: 'Rendering profile — performance settings for OBS/Blender/ffmpeg',
    priority: 400,
    inherits: ['performance'],
    metadata: { author: 'dynalloc', tags: ['render', 'streaming'] },
  },

  // 7. Streaming — inherits balanced (multimedia-friendly)
  {
    id: 'streaming',
    version: '1.0.0',
    description: 'Streaming profile — balanced settings for media playback',
    priority: 250,
    inherits: ['balanced'],
    metadata: { author: 'dynalloc', tags: ['multimedia', 'playback'] },
  },

  // 8. Battery Saver — inherits powersave + silent thermal
  {
    id: 'battery-saver',
    version: '1.0.0',
    description: 'Battery saver profile — powersave settings + maximum thermal protection',
    priority: 450,
    inherits: ['powersave'],
    overrides: {
      thermal: { profile: 'silent' },
    },
    metadata: { author: 'dynalloc', tags: ['battery', 'critical'] },
  },

  // 9. Idle — lowest priority, minimal resource usage
  {
    id: 'idle',
    version: '1.0.0',
    description: 'Idle profile — minimal resource usage after idle timeout',
    priority: 50,
    settings: {
      thermal: { profile: 'balanced' },
      power: { profile: 'power-saver' },
    },
    metadata: { author: 'dynalloc', tags: ['idle'] },
  },
];

/**
 * Create instances of all 9 built-in profiles.
 * @returns {Array<object>} array of raw profile definitions
 */
function createBuiltinProfiles() {
  // Return a deep copy so callers can't mutate the originals.
  return BUILTIN_DEFINITIONS.map((def) => JSON.parse(JSON.stringify(def)));
}

module.exports = {
  createBuiltinProfiles,
  BUILTIN_DEFINITIONS,
};
