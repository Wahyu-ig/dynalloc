'use strict';

/**
 * DynAlloc — Plugin SDK :: Version Compatibility
 * ================================================
 *
 * Checks compatibility between a plugin's declared API version and the
 * daemon's SDK API version. Uses a simplified semver-like scheme:
 *
 *   - Major version must match (breaking changes between majors)
 *   - Plugin's minor version must be <= daemon's minor version
 *   - Patch version is ignored for compatibility (bug fixes are compatible)
 *
 * Example:
 *   Plugin apiVersion "1.0" + Daemon apiVersion "1.2" → compatible
 *   Plugin apiVersion "1.3" + Daemon apiVersion "1.2" → incompatible (plugin needs newer API)
 *   Plugin apiVersion "2.0" + Daemon apiVersion "1.2" → incompatible (major mismatch)
 *
 * Backward compatibility: only used when ENABLE_PLUGIN_SDK is true.
 */

/**
 * Parse an API version string "X.Y" into { major, minor }.
 * @param {string} v
 * @returns {{ major: number, minor: number }|null}
 */
function parseApiVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

/**
 * Parse a semver string "X.Y.Z" into { major, minor, patch }.
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

/**
 * Compare two semver versions.
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Check API version compatibility.
 * @param {string} pluginApiVersion - e.g. "1.0"
 * @param {string} daemonApiVersion - e.g. "1.2"
 * @returns {{ compatible: boolean, reason: string }}
 */
function checkApiCompatibility(pluginApiVersion, daemonApiVersion) {
  const plugin = parseApiVersion(pluginApiVersion);
  const daemon = parseApiVersion(daemonApiVersion);

  if (!plugin) {
    return { compatible: false, reason: `invalid plugin API version "${pluginApiVersion}"` };
  }
  if (!daemon) {
    return { compatible: false, reason: `invalid daemon API version "${daemonApiVersion}"` };
  }

  // Major must match
  if (plugin.major !== daemon.major) {
    return {
      compatible: false,
      reason: `major version mismatch: plugin=${plugin.major}, daemon=${daemon.major}`,
    };
  }

  // Plugin minor must be <= daemon minor
  if (plugin.minor > daemon.minor) {
    return {
      compatible: false,
      reason: `plugin requires API ${pluginApiVersion} but daemon provides ${daemonApiVersion}`,
    };
  }

  return { compatible: true, reason: 'ok' };
}

/**
 * Check daemon version compatibility (minDynallocVersion / maxDynallocVersion).
 * @param {string} daemonVersion - current daemon version (semver)
 * @param {string} minVersion - minimum required (semver)
 * @param {string} [maxVersion] - maximum supported (semver, optional)
 * @returns {{ compatible: boolean, reason: string }}
 */
function checkDaemonCompatibility(daemonVersion, minVersion, maxVersion) {
  if (compareSemver(daemonVersion, minVersion) < 0) {
    return {
      compatible: false,
      reason: `daemon version ${daemonVersion} < minimum required ${minVersion}`,
    };
  }
  if (maxVersion && compareSemver(daemonVersion, maxVersion) > 0) {
    return {
      compatible: false,
      reason: `daemon version ${daemonVersion} > maximum supported ${maxVersion}`,
    };
  }
  return { compatible: true, reason: 'ok' };
}

module.exports = {
  parseApiVersion,
  parseSemver,
  compareSemver,
  checkApiCompatibility,
  checkDaemonCompatibility,
};
