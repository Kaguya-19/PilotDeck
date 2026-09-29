export const DEFAULT_TERMINAL_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TERMINAL_BUFFER_ENTRIES = 5000;

/**
 * Owns the live PTY-to-WebSocket binding for the desktop terminal.
 *
 * A terminal session is identified by the UI's existing session key. PTY and
 * socket identity are both fenced: a late exit or close from a replaced owner
 * cannot remove the currently published session.
 */
export class TerminalSessionRegistry {
  #sessions = new Map();
  #disposed = false;
  #timeoutMs;
  #maxBufferEntries;
  #setTimeout;
  #clearTimeout;

  constructor({
    timeoutMs = DEFAULT_TERMINAL_SESSION_TIMEOUT_MS,
    maxBufferEntries = DEFAULT_TERMINAL_BUFFER_ENTRIES,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('Terminal session timeout must be a non-negative finite number.');
    }
    if (!Number.isInteger(maxBufferEntries) || maxBufferEntries < 1) {
      throw new TypeError('Terminal session buffer limit must be a positive integer.');
    }
    this.#timeoutMs = timeoutMs;
    this.#maxBufferEntries = maxBufferEntries;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
  }

  get size() {
    return this.#sessions.size;
  }

  get(key) {
    const session = this.#sessions.get(key);
    return session ? this.#snapshot(key, session) : null;
  }

  register(key, { pty, ws, projectPath, sessionId }) {
    this.#assertKey(key);
    if (!pty) throw new TypeError('Terminal session requires a PTY.');
    if (this.#disposed) {
      killPty(pty);
      return null;
    }

    const prior = this.#sessions.get(key);
    if (prior) this.#stop(key, prior);

    const session = {
      pty,
      ws: ws ?? null,
      buffer: [],
      timeoutId: null,
      projectPath,
      sessionId,
    };
    this.#sessions.set(key, session);
    return this.#snapshot(key, session);
  }

  /** Stop the current PTY before a login command replaces it. */
  replace(key) {
    const session = this.#sessions.get(key);
    if (!session) return false;
    this.#stop(key, session);
    return true;
  }

  reconnect(key, pty, ws) {
    const session = this.#current(key, pty);
    if (!session || this.#disposed) return null;
    this.#cancelTimeout(session);
    session.ws = ws;
    return this.#snapshot(key, session);
  }

  appendOutput(key, pty, chunk) {
    const session = this.#current(key, pty);
    if (!session) return null;
    if (session.buffer.length >= this.#maxBufferEntries) session.buffer.shift();
    session.buffer.push(chunk);
    return this.#snapshot(key, session);
  }

  complete(key, pty) {
    const session = this.#current(key, pty);
    if (!session) return null;
    const snapshot = this.#snapshot(key, session);
    this.#remove(key, session);
    return snapshot;
  }

  write(key, pty, ws, data) {
    const session = this.#current(key, pty);
    if (!session || session.ws !== ws || typeof session.pty?.write !== 'function') return false;
    session.pty.write(data);
    return true;
  }

  resize(key, pty, ws, columns, rows) {
    const session = this.#current(key, pty);
    if (!session || session.ws !== ws || typeof session.pty?.resize !== 'function') return false;
    session.pty.resize(columns, rows);
    return true;
  }

  detach(key, pty, ws) {
    const session = this.#current(key, pty);
    if (!session || session.ws !== ws) return null;
    session.ws = null;
    this.#cancelTimeout(session);
    session.timeoutId = this.#setTimeout(() => {
      const timedOut = this.#current(key, pty);
      if (!timedOut || timedOut.ws) return;
      this.#stop(key, timedOut);
    }, this.#timeoutMs);
    return this.#snapshot(key, session);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [key, session] of this.#sessions) this.#stop(key, session);
  }

  #current(key, pty) {
    const session = this.#sessions.get(key);
    return session?.pty === pty ? session : null;
  }

  #stop(key, session) {
    this.#remove(key, session);
    killPty(session.pty);
  }

  #remove(key, session) {
    this.#cancelTimeout(session);
    if (this.#sessions.get(key) === session) this.#sessions.delete(key);
  }

  #cancelTimeout(session) {
    if (session.timeoutId === null) return;
    this.#clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }

  #snapshot(key, session) {
    return {
      key,
      pty: session.pty,
      ws: session.ws,
      buffer: [...session.buffer],
      projectPath: session.projectPath,
      sessionId: session.sessionId,
    };
  }

  #assertKey(key) {
    if (typeof key !== 'string' || !key) throw new TypeError('Terminal session key must be a non-empty string.');
  }
}

function killPty(pty) {
  try {
    pty?.kill?.();
  } catch {
    // PTY exit is asynchronous and may race replacement or server shutdown.
  }
}
