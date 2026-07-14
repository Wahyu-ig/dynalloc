'use strict';

/**
 * DynAlloc — Plugin SDK :: Plugin Template
 * =========================================
 *
 * A minimal plugin template that developers can copy to start
 * building a new plugin.
 *
 * Usage:
 *   1. Copy this file to your plugin directory.
 *   2. Create a manifest.json next to it.
 *   3. Implement activate() and deactivate().
 *
 * manifest.json example:
 *
 *   {
 *     "id": "com.example.my-plugin",
 *     "name": "My Plugin",
 *     "version": "1.0.0",
 *     "minDynallocVersion": "0.5.0",
 *     "apiVersion": "1.0",
 *     "permissions": ["read:config", "write:events", "log:write"],
 *     "entryPoint": "./index.js"
 *   }
 */

module.exports = {
  /**
   * Called when the plugin is activated. The context provides
   * access to the daemon's Public API.
   *
   * @param {PluginContext} context
   */
  activate(context) {
    context.log.info('My plugin activated');

    // Subscribe to events
    context.bus.on('onWorkloadDetected', (payload) => {
      context.log.debug('Workload detected:', payload.workload);
    });

    // Read daemon state
    const state = context.state;
    context.log.debug('Current stress level:', state.stressLevel);
  },

  /**
   * Called when the plugin is deactivated. Clean up resources here.
   *
   * @param {PluginContext} context
   */
  deactivate(context) {
    context.log.info('My plugin deactivated');
  },

  /**
   * Called when the plugin is cleaned up (after deactivation).
   * Release all resources, close file handles, etc.
   */
  cleanup() {
    // Nothing to clean up for this template
  },
};
