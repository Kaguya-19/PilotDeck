import { useEffect, useRef } from 'react';

type UseSessionWatchArgs = {
  sessionId: string | null | undefined;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
};

function normalizeSessionId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function useSessionWatch({ sessionId, ws, sendMessage }: UseSessionWatchArgs) {
  const watchedSessionRef = useRef<string | null>(null);
  const watchedSocketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const nextSessionId = normalizeSessionId(sessionId);
    const previousSessionId = watchedSessionRef.current;
    const socketChanged = watchedSocketRef.current !== ws;

    if (previousSessionId && previousSessionId !== nextSessionId) {
      sendMessage({ type: 'unwatch-session', sessionId: previousSessionId });
    }

    if (nextSessionId && ws?.readyState === WebSocket.OPEN) {
      if (socketChanged || previousSessionId !== nextSessionId) {
        sendMessage({ type: 'watch-session', sessionId: nextSessionId });
      }
    }

    watchedSessionRef.current = nextSessionId;
    watchedSocketRef.current = ws;
  }, [sessionId, ws, sendMessage]);

  useEffect(() => () => {
    const sessionToUnwatch = watchedSessionRef.current;
    if (sessionToUnwatch) {
      sendMessage({ type: 'unwatch-session', sessionId: sessionToUnwatch });
    }
  }, [sendMessage]);
}
