import { describe, expect, it, vi } from 'vitest';
import { TerminalSessionRegistry } from './terminalSessionRegistry.js';

function createPty() {
  return {
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  };
}

function createSocket() {
  return { readyState: 1 };
}

function createTimers() {
  const callbacks = new Map();
  let nextId = 0;
  const setTimeoutFn = vi.fn((callback, delay) => {
    const id = ++nextId;
    callbacks.set(id, { callback, delay });
    return id;
  });
  const clearTimeoutFn = vi.fn((id) => callbacks.delete(id));
  return {
    callbacks,
    setTimeoutFn,
    clearTimeoutFn,
    run(id) {
      const timer = callbacks.get(id);
      if (!timer) return;
      callbacks.delete(id);
      timer.callback();
    },
  };
}

describe('TerminalSessionRegistry', () => {
  it('replays buffered output and clears the detached timeout on reconnect', () => {
    const timers = createTimers();
    const registry = new TerminalSessionRegistry({
      timeoutMs: 99,
      maxBufferEntries: 2,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const pty = createPty();
    const firstSocket = createSocket();
    const secondSocket = createSocket();

    registry.register('terminal-1', { pty, ws: firstSocket, projectPath: '/work', sessionId: 's1' });
    registry.appendOutput('terminal-1', pty, 'old');
    registry.appendOutput('terminal-1', pty, 'middle');
    registry.appendOutput('terminal-1', pty, 'new');
    registry.detach('terminal-1', pty, firstSocket);

    const [timerId, timer] = [...timers.callbacks.entries()][0];
    expect(timer.delay).toBe(99);

    const reconnected = registry.reconnect('terminal-1', pty, secondSocket);
    expect(reconnected).toMatchObject({ ws: secondSocket, buffer: ['middle', 'new'] });
    expect(timers.clearTimeoutFn).toHaveBeenCalledWith(timerId);
    expect(timers.callbacks.size).toBe(0);
  });

  it('fences late socket close, input, and resize from a superseded binding', () => {
    const registry = new TerminalSessionRegistry();
    const pty = createPty();
    const staleSocket = createSocket();
    const currentSocket = createSocket();

    registry.register('terminal-1', { pty, ws: staleSocket });
    registry.detach('terminal-1', pty, staleSocket);
    registry.reconnect('terminal-1', pty, currentSocket);

    expect(registry.detach('terminal-1', pty, staleSocket)).toBeNull();
    expect(registry.write('terminal-1', pty, staleSocket, 'stale')).toBe(false);
    expect(registry.resize('terminal-1', pty, staleSocket, 100, 40)).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();

    expect(registry.write('terminal-1', pty, currentSocket, 'current')).toBe(true);
    expect(registry.resize('terminal-1', pty, currentSocket, 100, 40)).toBe(true);
    expect(pty.write).toHaveBeenCalledWith('current');
    expect(pty.resize).toHaveBeenCalledWith(100, 40);
  });

  it('does not let a replaced PTY exit delete the replacement session', () => {
    const registry = new TerminalSessionRegistry();
    const oldPty = createPty();
    const newPty = createPty();
    const socket = createSocket();

    registry.register('terminal-1', { pty: oldPty, ws: socket });
    expect(registry.replace('terminal-1')).toBe(true);
    registry.register('terminal-1', { pty: newPty, ws: socket });

    expect(registry.complete('terminal-1', oldPty)).toBeNull();
    expect(registry.get('terminal-1')).toMatchObject({ pty: newPty, ws: socket });
    expect(registry.complete('terminal-1', newPty)).toMatchObject({ pty: newPty });
    expect(registry.get('terminal-1')).toBeNull();
  });

  it('kills only the exact detached PTY on timeout', () => {
    const timers = createTimers();
    const registry = new TerminalSessionRegistry({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const pty = createPty();
    const socket = createSocket();

    registry.register('terminal-1', { pty, ws: socket });
    registry.detach('terminal-1', pty, socket);
    const [timerId] = timers.callbacks.keys();
    timers.run(timerId);

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(registry.get('terminal-1')).toBeNull();
  });

  it('does not let an already-queued old timeout kill a replacement PTY', () => {
    const timers = createTimers();
    const registry = new TerminalSessionRegistry({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const oldPty = createPty();
    const replacementPty = createPty();
    const socket = createSocket();

    registry.register('terminal-1', { pty: oldPty, ws: socket });
    registry.detach('terminal-1', oldPty, socket);
    const [{ callback }] = timers.callbacks.values();

    registry.replace('terminal-1');
    registry.register('terminal-1', { pty: replacementPty, ws: socket });
    callback();

    expect(oldPty.kill).toHaveBeenCalledTimes(1);
    expect(replacementPty.kill).not.toHaveBeenCalled();
    expect(registry.get('terminal-1')).toMatchObject({ pty: replacementPty });
  });

  it('keeps a new socket binding independent when the same socket detaches an older session', () => {
    const timers = createTimers();
    const registry = new TerminalSessionRegistry({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const oldPty = createPty();
    const newPty = createPty();
    const socket = createSocket();

    registry.register('old', { pty: oldPty, ws: socket });
    registry.detach('old', oldPty, socket);
    registry.register('new', { pty: newPty, ws: socket });
    const [oldTimeout] = timers.callbacks.keys();
    timers.run(oldTimeout);

    expect(oldPty.kill).toHaveBeenCalledTimes(1);
    expect(registry.get('new')).toMatchObject({ pty: newPty, ws: socket });
    expect(newPty.kill).not.toHaveBeenCalled();
  });

  it('disposes all remaining sessions exactly once', () => {
    const timers = createTimers();
    const registry = new TerminalSessionRegistry({ setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
    const firstPty = createPty();
    const secondPty = createPty();
    const firstSocket = createSocket();
    const secondSocket = createSocket();

    registry.register('first', { pty: firstPty, ws: firstSocket });
    registry.register('second', { pty: secondPty, ws: secondSocket });
    registry.detach('second', secondPty, secondSocket);
    registry.dispose();
    registry.dispose();

    expect(firstPty.kill).toHaveBeenCalledTimes(1);
    expect(secondPty.kill).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(timers.callbacks.size).toBe(0);
  });
});
