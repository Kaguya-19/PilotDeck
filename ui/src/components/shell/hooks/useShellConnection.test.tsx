import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useRef } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Project, ProjectSession } from '../../../types/app';
import { useShellConnection } from './useShellConnection';

const socketUtils = vi.hoisted(() => ({
  getShellWebSocketUrl: vi.fn(() => 'ws://pilotdeck.test/shell'),
  sendSocketMessage: vi.fn(),
}));

vi.mock('../utils/socket', () => ({
  getShellWebSocketUrl: socketUtils.getShellWebSocketUrl,
  parseShellMessage: (payload: string) => {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  },
  sendSocketMessage: socketUtils.sendSocketMessage,
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }
}

type ShellHarnessCallbacks = {
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  writeTerminal: (data: string) => void;
};

function useShellConnectionHarness(callbacks: ShellHarnessCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>({ write: callbacks.writeTerminal } as unknown as Terminal);
  const fitAddonRef = useRef<FitAddon | null>({ fit: vi.fn() } as unknown as FitAddon);
  const selectedProjectRef = useRef<Project | null>({ fullPath: '/work', path: '/work' } as Project);
  const selectedSessionRef = useRef<ProjectSession | null>(null);
  const initialCommandRef = useRef<string | null>(null);
  const isPlainShellRef = useRef(false);
  const onProcessCompleteRef = useRef<((exitCode: number) => void) | null>(null);
  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    wsRef.current = null;
    activeSocket?.close();
  }, []);

  const connection = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    isInitialized: true,
    autoConnect: false,
    closeSocket,
    clearTerminalScreen: callbacks.clearTerminalScreen,
    setAuthUrl: callbacks.setAuthUrl,
  });

  return { connection, wsRef };
}

describe('useShellConnection', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it('fences stale close/message/init work after a replacement socket is active', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const callbacks: ShellHarnessCallbacks = {
      clearTerminalScreen: vi.fn(),
      setAuthUrl: vi.fn(),
      writeTerminal: vi.fn(),
    };
    const { result } = renderHook(() => useShellConnectionHarness(callbacks));

    act(() => {
      result.current.connection.connectToShell();
    });
    const firstSocket = FakeWebSocket.instances[0];
    act(() => {
      firstSocket.open();
    });
    act(() => {
      result.current.connection.disconnectFromShell();
    });
    act(() => {
      result.current.connection.connectToShell();
    });

    const secondSocket = FakeWebSocket.instances[1];
    act(() => {
      secondSocket.open();
      vi.advanceTimersByTime(100);
    });

    expect(socketUtils.sendSocketMessage).toHaveBeenCalledTimes(1);
    expect(socketUtils.sendSocketMessage).toHaveBeenCalledWith(
      secondSocket,
      expect.objectContaining({ type: 'init', projectPath: '/work' }),
    );

    act(() => {
      firstSocket.emitMessage(JSON.stringify({ type: 'output', data: 'stale output' }));
      firstSocket.close();
    });

    expect(callbacks.writeTerminal).not.toHaveBeenCalled();
    expect(result.current.connection.isConnected).toBe(true);
    expect(callbacks.clearTerminalScreen).toHaveBeenCalledTimes(1);
  });
});
