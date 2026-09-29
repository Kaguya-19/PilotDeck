import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { createPublishRuntimeObserver, type PublishRuntimeObserver } from './publish-runtime-observer';

const Context = createContext<PublishRuntimeObserver | undefined>(undefined);
export function usePublishRuntimeObserver() { return useContext(Context); }
export function usePublishRuntimeSnapshot() {
  const observer = usePublishRuntimeObserver();
  if (!observer) throw new Error('Publish runtime status requires its mounted module context.');
  return useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);
}

export function PublishRuntimeProvider({ children }: { children: ReactNode }) {
  const observer = useMemo(createPublishRuntimeObserver, []);
  useEffect(() => {
    observer.activate();
    const controller = new AbortController();
    void authenticatedFetch('/api/modules/sop/management', { signal: controller.signal, suppressServerErrorToast: true })
      .then(async response => {
        if (!response.ok) throw new Error('Runtime metadata unavailable');
        const body = await response.json();
        if (!controller.signal.aborted) observer.acceptBootstrap(body);
      }).catch(() => { if (!controller.signal.aborted) observer.fail(); });
    return () => { controller.abort(); observer.dispose(); };
  }, [observer]);
  return <Context.Provider value={observer}>{children}</Context.Provider>;
}
