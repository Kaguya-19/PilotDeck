import { createContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export const SessionViewReadyContext = createContext<(sessionId: string | null) => void>(() => {});
type ReadRecord = {runId: string; unread: boolean};
type Activity = {sessionId: string; processing: boolean; completedRunId?: string};

export function createSessionIndicatorStore(storageKey: string, storage: Storage | undefined) {
  let records: Record<string, ReadRecord> = Object.create(null);
  let processing = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot = {processingSessions: processing, unreadSessionIds: new Set<string>()};
  const publish = () => {
    snapshot = {processingSessions: new Set(processing), unreadSessionIds: new Set(Object.keys(records).filter(id => records[id].unread))};
    listeners.forEach(listener => listener());
  };
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify(records)); } catch { /* Private mode/storage quota. */ } };
  const restore = () => {
    try {
      const value = JSON.parse(storage?.getItem(storageKey) || '{}');
      records = Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([, record]) => record && typeof record === 'object' &&
        typeof (record as ReadRecord).runId === 'string' && typeof (record as ReadRecord).unread === 'boolean'))) as Record<string, ReadRecord>;
    } catch { records = Object.create(null); }
    publish();
  };
  restore();
  const receive = (message: any, viewedSessionId: string | null) => {
    const fullSnapshot = message?.type === 'session-activity-snapshot';
    const activities: Activity[] = fullSnapshot ? message.activities : message?.type === 'session-activity' ? [message.activity] : [];
    if (!Array.isArray(activities)) return;
    let changed = fullSnapshot && processing.size > 0;
    let recordsChanged = false;
    if (fullSnapshot) processing = new Set();
    for (const activity of activities) {
      if (!activity || typeof activity.sessionId !== 'string') continue;
      const id = activity.sessionId;
      if (Boolean(activity.processing) !== processing.has(id)) changed = true;
      if (activity.processing) processing.add(id); else processing.delete(id);
      const completed = activity.completedRunId;
      if (typeof completed === 'string' && records[id]?.runId !== completed) {
        records[id] = {runId: completed, unread: id !== viewedSessionId};
        recordsChanged = changed = true;
      } else if (id === viewedSessionId && records[id]?.unread) {
        records[id] = {...records[id], unread: false};
        recordsChanged = changed = true;
      }
    }
    if (recordsChanged) persist();
    if (changed) publish();
  };
  const markRead = (id: string | null) => {
    if (!id || !records[id]?.unread) return;
    records[id] = {...records[id], unread: false};
    persist(); publish();
  };
  return {receive, markRead, restore, getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }};
}

export function useSessionIndicators({scope, viewedSessionId, subscribe, sendMessage, isConnected}: {
  scope: string;
  viewedSessionId: string | null;
  subscribe: (handler: (message: any) => void) => () => void;
  sendMessage: (message: any) => unknown;
  isConnected: boolean;
}) {
  const key = `pilotdeck-session-read-v1:${scope}`;
  const store = useMemo(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Unavailable storage must not break chat. */ }
    return createSessionIndicatorStore(key, storage);
  }, [key]);
  const viewRef = useRef(viewedSessionId);
  viewRef.current = viewedSessionId;
  const foregroundView = () => document.visibilityState === 'visible' && document.hasFocus() ? viewRef.current : null;
  useEffect(() => subscribe(message => store.receive(message, foregroundView())), [store, subscribe]);
  useEffect(() => {
    if (isConnected) sendMessage({type: 'get-session-activity'});
  }, [isConnected, sendMessage, store]);
  useEffect(() => {
    const read = () => store.markRead(foregroundView());
    const restored = (event: StorageEvent) => { if (event.key === key) { store.restore(); read(); } };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    window.addEventListener('storage', restored);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
      window.removeEventListener('storage', restored);
    };
  }, [store, viewedSessionId, key]);
  return {...useSyncExternalStore(store.subscribe, store.getSnapshot), markRead: store.markRead};
}
