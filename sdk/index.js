'use strict';

/**
 * DynAlloc — Plugin SDK :: Public API
 * =====================================
 *
 * Single import surface for the rest of the daemon and for plugin
 * developers.
 *
 * Usage (daemon side):
 *
 *   const { PluginLifecycleManager } = require('./sdk');
 *   const mgr = new PluginLifecycleManager({ config, apiVersion, daemonVersion, providers });
 *   mgr.loadFromDirectory('/path/to/plugin');
 *
 * Usage (plugin side — plugins receive a PluginContext, not this module):
 *
 *   module.exports = {
 *     activate(context) {
 *       context.log.info('Hello from my plugin!');
 *       context.bus.on('onWorkloadDetected', (payload) => {
 *         context.log.debug('Workload detected:', payload.workload);
 *       });
 *     },
 *     deactivate(context) {
 *       context.log.info('Goodbye from my plugin');
 *     },
 *   };
 */

const PluginPermissions = require('./plugin-permissions');
const { validateManifest, createManifest } = require('./plugin-manifest');
const PluginVersion = require('./plugin-version');
const PluginContext = require('./plugin-context');
const PluginLifecycleManager = require('./plugin-lifecycle-manager');

module.exports = {
  // Lifecycle
  PluginLifecycleManager,
  // API surface
  PluginContext,
  // Validation
  validateManifest,
  createManifest,
  // Permissions
  ...PluginPermissions,
  // Version
  ...PluginVersion,
  // Constants
  API_VERSION: '1.0',
};
