import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../../../utils/api';

export type ConnectionTestTask = {
  id: string;
  providerId: string;
  modelId?: string;
  acknowledged?: boolean;
  status: 'testing' | 'savingTest' | 'manual' | 'success' | 'error' | 'saveError' | 'cancelling' | 'cancelled';
  message?: string;
  code?: string;
  result?: { models?: Array<{ modelId: string; textInput: string; imageInput: string; error?: { message?: string } }> };
};
export const isTestTaskBusy = (task?: ConnectionTestTask) => !!task && ['testing', 'savingTest', 'manual', 'cancelling'].includes(task.status);
const endpoint = '/api/config/connection-test-tasks';

// The server owns execution and saving. Mounting, navigation and refresh only
// change the subscription, so no component closure can save a stale config.
export function useConnectionTestTasks() {
  const [tasks, setTasks] = useState<ConnectionTestTask[]>([]);
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState('');
  const mounted = useRef(false);
  const version = useRef(0);
  const pendingRef = useRef(false);

  const refresh = useCallback(async (signal: AbortSignal) => {
    if (pendingRef.current) return;
    const current = version.current;
    try {
      const response = await authenticatedFetch(endpoint, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Status unavailable');
      const data = await response.json();
      if (mounted.current && current === version.current) {
        const next: ConnectionTestTask[] = data.tasks || [];
        setTasks(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setChecking(false); setErrorCode('');
      }
    } catch {
      if (mounted.current && current === version.current && (!signal.aborted || signal.reason?.name === 'TimeoutError')) {
        setChecking(true); setErrorCode('STATUS_UNAVAILABLE');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Status timeout', 'TimeoutError')), 10_000);
      await refresh(controller.signal);
      clearTimeout(timeout);
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { active = false; mounted.current = false; version.current++; clearTimeout(timer); controller?.abort(); };
  }, [refresh]);

  const action = async (path: string, body?: unknown, method = 'POST') => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    version.current++;
    setPending(true); setErrorCode('');
    try {
      const response = await authenticatedFetch(endpoint + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (Array.isArray(data.tasks)) { setTasks(data.tasks); setChecking(false); }
      if (!response.ok) setErrorCode(data.code || 'TEST_FAILED');
    } catch {
      if (mounted.current) { setChecking(true); setErrorCode('STATUS_UNAVAILABLE'); }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return {
    tasks, checking, pending, errorCode,
    start: (providerId: string, modelId?: string) => action('', { providerId, ...(modelId ? { modelId } : {}) }),
    retry: (id: string) => action(`/${encodeURIComponent(id)}/retry`),
    acknowledge: (id: string) => action(`/${encodeURIComponent(id)}/acknowledge`),
    cancel: (id: string) => action(`/${encodeURIComponent(id)}/cancel`),
    confirm: (id: string, values: Record<string, boolean>) => action(`/${encodeURIComponent(id)}/image-capabilities`, {
      models: Object.entries(values).map(([modelId, supported]) => ({ modelId, imageInput: supported ? 'supported' : 'unsupported' })),
    }, 'PUT'),
  };
}
