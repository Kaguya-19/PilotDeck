import { useEffect, useSyncExternalStore } from 'react';
import { globalPermissionModeStore, PERMISSION_PREFERENCE_CHANGED } from '../utils/globalPermissionMode';

export function useChatPermissionMode() {
  const state = useSyncExternalStore(globalPermissionModeStore.subscribe, globalPermissionModeStore.getSnapshot);
  useEffect(() => {
    void globalPermissionModeStore.load(true);
    const refresh = () => { void globalPermissionModeStore.load(true); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PERMISSION_PREFERENCE_CHANGED || event.key === null) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return {
    permissionMode: state.mode,
    isPermissionModeReady: !state.loading && !state.error,
    permissionModeError: state.error,
    setPermissionMode: globalPermissionModeStore.select,
    reloadPermissionMode: () => globalPermissionModeStore.load(true),
  };
}
