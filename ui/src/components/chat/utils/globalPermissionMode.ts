import { authenticatedFetch } from '../../../utils/api';
import type { PermissionMode } from '../types/types';
import { PILOTDECK_SETTINGS_KEY, getPilotDeckSettings, safeLocalStorage } from './chatStorage';

type GlobalPermissionMode = Extract<PermissionMode, 'default' | 'bypassPermissions'>;
type State = { mode: GlobalPermissionMode; loading: boolean; error: string | null };
export const PERMISSION_PREFERENCE_CHANGED = 'pilotdeck:permission-preference-changed';

/** The server preference is authoritative; session/browser legacy keys are never restored. */
export function createGlobalPermissionModeStore(request = authenticatedFetch) {
  let state: State = { mode: 'default', loading: true, error: null };
  let confirmed: GlobalPermissionMode = 'default';
  let loaded = false;
  let revision = 0;
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const perform = (mode?: GlobalPermissionMode) => {
    const currentRevision = ++revision;
    pending++;
    publish({ loading: true, error: null, ...(mode ? { mode } : {}) });
    const operation = tail.then(async () => {
      const response = await request('/api/settings/permissions', mode ? {
        method: 'PUT', body: JSON.stringify({ skipPermissions: mode === 'bypassPermissions' }),
      } : undefined);
      const data = await response.json();
      if (!response.ok || data?.success === false || typeof data?.permissions?.skipPermissions !== 'boolean') {
        throw new Error(data?.error || 'Unable to read or save the global permission preference.');
      }
      confirmed = data.permissions.skipPermissions ? 'bypassPermissions' : 'default';
      loaded = true;
      // This cache is for rule editors only; it never initializes the global preference.
      safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify({ ...getPilotDeckSettings(), ...data.permissions }));
      if (mode && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('pilotdeck-settings-changed'));
        // Other windows refresh from the server, rather than trusting this signal's value.
        safeLocalStorage.setItem(PERMISSION_PREFERENCE_CHANGED, `${Date.now()}:${currentRevision}`);
      }
      if (currentRevision === revision) publish({ mode: confirmed, error: null });
    }).catch((error: unknown) => {
      if (currentRevision === revision) {
        publish({ mode: confirmed, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }).finally(() => {
      pending--;
      if (!pending) publish({ loading: false });
    });
    tail = operation.catch(() => {});
    return operation;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: (refresh = false): Promise<void> => {
      if (pending) return tail;
      if (loaded && !refresh) return Promise.resolve();
      return perform().catch(() => {});
    },
    select: (mode: PermissionMode): Promise<void> => {
      // Plan is a per-turn override, never a persistent preference.
      if (mode !== 'default' && mode !== 'bypassPermissions') return Promise.reject(new Error('Invalid global permission mode.'));
      return perform(mode);
    },
  };
}

export const globalPermissionModeStore = createGlobalPermissionModeStore();
