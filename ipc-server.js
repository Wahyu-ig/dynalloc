'use strict';

/**
 * DynAlloc — IPC Server
 * =====================
 *
 * Unix domain socket server that allows the `dynalloc` CLI tool (and
 * any other external client) to query daemon state and issue commands.
 *
 * Protocol: line-delimited JSON (one request per line, one response
 * per line). Each request is a JSON object:
 *
 *   {"cmd": "status", "args": {}}
 *   {"cmd": "boost",  "args": {"pid": 12345}}
 *
 * Each response is a JSON object:
 *
 *   {"ok": true, "data": {...}}
 *   {"ok": false, "error": "explanation"}
 *
 * Socket path resolution:
 *   1. CONFIG.IPC_SOCKET_PATH (if set)
 *   2. $XDG_RUNTIME_DIR/dynalloc.sock (typically /run/user/<uid>/)
 *   3. /tmp/dynalloc-<uid>.sock (fallback)
 *
 * Security:
 *   - Socket file mode is 0600 (only owner can read/write).
 *   - The daemon and CLI are expected to run as the same user.
 *   - For system-wide daemons (root), set IPC_SOCKET_PATH explicitly
 *     and arrange group permissions manually.
 *
 * Commands implemented (registered by daemon.js):
 *   ping          — health check, returns "pong"
 *   status        — quick state overview
 *   stats         — full metrics dump
 *   metrics       — raw metrics as JSON
 *   boost         — manually boost a PID
 *   throttle      — manually throttle a PID
 *   restore       — restore a PID to default state
 *   doctor        — run health diagnostics
 *   throttled     — list currently throttled PIDs
 *   shutdown      — gracefully shut down the daemon (with auth)
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { info, warn, error, debug } = logger;

class IpcServer {
  /**
   * @param {object} opts
   * @param {string} [opts.socketPath] - explicit socket path
   * @param {object} [opts.daemon] - daemon module reference (for handler registration)
   */
  constructor(opts = {}) {
    this._socketPath = opts.socketPath || this._defaultSocketPath();
    this._server = null;
    this._connectedClients = new Set();
    this._handlers = new Map();
    this._started = false;
  }

  /**
   * Resolve the default socket path.
   * Resolution order:
   *   1. $DYNALLOC_IPC_SOCKET (env var, also honored by the CLI)
   *   2. $XDG_RUNTIME_DIR/dynalloc.sock (systemd user sessions)
   *   3. /tmp/dynalloc-<uid>.sock (fallback)
   */
  _defaultSocketPath() {
    if (process.env.DYNALLOC_IPC_SOCKET) {
      return process.env.DYNALLOC_IPC_SOCKET;
    }
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime) {
      try {
        fs.mkdirSync(xdgRuntime, { recursive: true });
        return path.join(xdgRuntime, 'dynalloc.sock');
      } catch (_) { /* fall through */ }
    }
    const uid = (process.getuid && process.getuid()) || 0;
    return `/tmp/dynalloc-${uid}.sock`;
  }

  /**
   * Register a command handler.
   * @param {string} cmd - command name (case-insensitive)
   * @param {Function} handler - async (args, request) => any
   */
  registerHandler(cmd, handler) {
    if (typeof cmd !== 'string' || typeof handler !== 'function') return;
    this._handlers.set(cmd.toLowerCase(), handler);
    debug(`IPC handler registered: ${cmd}`);
  }

  /**
   * Start listening on the socket. Returns a Promise<boolean>.
   */
  start() {
    if (this._started) return Promise.resolve(true);
    this._started = true;

    // Remove stale socket from a previous crash
    try {
      if (fs.existsSync(this._socketPath)) {
        fs.unlinkSync(this._socketPath);
      }
    } catch (err) {
      warn(`IPC: cannot remove stale socket ${this._socketPath}: ${err.message}`);
      this._started = false;
      return Promise.resolve(false);
    }

    // Ensure parent directory exists
    const dir = path.dirname(this._socketPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) { /* may already exist */ }

    return new Promise((resolve) => {
      this._server = net.createServer((socket) => this._handleConnection(socket));

      this._server.once('listening', () => {
        // Restrict to owner-only access
        try { fs.chmodSync(this._socketPath, 0o600); } catch (_) { /* best-effort */ }
        info(`IPC server listening on ${this._socketPath}`);
        resolve(true);
      });

      this._server.once('error', (err) => {
        error(`IPC server error: ${err.message}`);
        this._started = false;
        this._server = null;
        resolve(false);
      });

      try {
        this._server.listen(this._socketPath);
      } catch (err) {
        error(`IPC server listen failed: ${err.message}`);
        this._started = false;
        this._server = null;
        resolve(false);
      }
    });
  }

  /**
   * Stop the server and clean up the socket file.
   */
  stop() {
    if (!this._server) return;
    // Close all connected clients
    for (const client of this._connectedClients) {
      try { client.destroy(); } catch (_) { /* noop */ }
    }
    this._connectedClients.clear();

    try { this._server.close(); } catch (_) { /* noop */ }
    this._server = null;
    this._started = false;

    try {
      if (fs.existsSync(this._socketPath)) {
        fs.unlinkSync(this._socketPath);
        debug(`IPC socket removed: ${this._socketPath}`);
      }
    } catch (_) { /* best-effort */ }
  }

  /**
   * Get the current socket path (useful for logging on startup).
   */
  get socketPath() {
    return this._socketPath;
  }

  get isRunning() {
    return this._started && this._server !== null;
  }

  // ── Internal ──────────────────────────────────────────────────────

  _handleConnection(socket) {
    this._connectedClients.add(socket);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Process complete lines (newline-delimited JSON)
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          this._handleRequest(socket, line).catch((err) => {
            // Should never happen — _handleRequest catches internally
            debug(`IPC unhandled error: ${err.message}`);
          });
        }
      }
    });

    socket.on('error', () => { /* client disconnected abruptly — ignore */ });
    socket.on('close', () => {
      this._connectedClients.delete(socket);
    });

    // Safety: close idle connections after 30s
    socket.setTimeout(30000);
    socket.on('timeout', () => {
      try { socket.end(); } catch (_) { /* noop */ }
    });
  }

  async _handleRequest(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      this._sendResponse(socket, { ok: false, error: `invalid JSON: ${err.message}` });
      return;
    }

    if (!request || typeof request !== 'object') {
      this._sendResponse(socket, { ok: false, error: 'request must be a JSON object' });
      return;
    }

    const cmd = (request.cmd || '').toString().toLowerCase();
    if (!cmd) {
      this._sendResponse(socket, { ok: false, error: 'missing "cmd" field' });
      return;
    }

    const handler = this._handlers.get(cmd);
    if (!handler) {
      this._sendResponse(socket, { ok: false, error: `unknown command: "${cmd}"` });
      return;
    }

    try {
      const args = (request.args && typeof request.args === 'object') ? request.args : {};
      const data = await handler(args, request);
      this._sendResponse(socket, { ok: true, data: data === undefined ? null : data });
    } catch (err) {
      this._sendResponse(socket, {
        ok: false,
        error: (err && err.message) ? err.message : String(err),
      });
    }
  }

  _sendResponse(socket, obj) {
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch (_) { /* socket already closed */ }
  }
}

module.exports = { IpcServer };
