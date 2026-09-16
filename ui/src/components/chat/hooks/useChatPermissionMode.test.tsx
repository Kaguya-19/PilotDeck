import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatPermissionMode } from './useChatPermissionMode';
import { createGlobalPermissionModeStore, PERMISSION_PREFERENCE_CHANGED } from '../utils/globalPermissionMode';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), store: null as any }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../utils/globalPermissionMode', async (original) => ({
  ...await original<typeof import('../utils/globalPermissionMode')>(),
  get globalPermissionModeStore() { return mocks.store; },
}));
let permissions: Record<string, unknown>;
const json = (data: unknown, ok = true) => ({ ok, json: async () => data });
const ready = async (hook: ReturnType<typeof setup>) => waitFor(() => expect(hook.result.current.isPermissionModeReady).toBe(true));
const setup = () => renderHook(() => useChatPermissionMode());
beforeEach(() => {
  localStorage.clear(); mocks.fetch.mockReset();
  permissions = { skipPermissions: false, allowedTools: ['read_file'], askTools: ['bash'], disallowedTools: ['danger'] };
  mocks.fetch.mockImplementation(async (_url, options) => {
    if (options?.method === 'PUT') permissions = { ...permissions, ...JSON.parse(options.body) };
    return json({ success: true, permissions: { ...permissions } });
  });
  mocks.store = createGlobalPermissionModeStore();
});
afterEach(cleanup);
describe('global chat permission preference', () => {
  it.each([true, false])('reads persisted %s and ignores old session/browser preferences', async (skip) => {
    permissions.skipPermissions = skip;
    localStorage.setItem('permissionMode-default', skip ? 'default' : 'bypassPermissions');
    localStorage.setItem('permissionMode-old-session', skip ? 'default' : 'bypassPermissions');
    const hook = setup(); expect(hook.result.current.isPermissionModeReady).toBe(false); await ready(hook);
    expect(hook.result.current.permissionMode).toBe(skip ? 'bypassPermissions' : 'default');
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.fetch.mock.calls[0][1]).toBeUndefined();
  });
  it('shares choices across composers and app restarts, preserving all permission rules', async () => {
    const a = setup(), b = setup(); await ready(a); await ready(b);
    await act(() => a.result.current.setPermissionMode('bypassPermissions'));
    expect(b.result.current.permissionMode).toBe('bypassPermissions');
    expect(permissions).toEqual({ skipPermissions: true, allowedTools: ['read_file'], askTools: ['bash'], disallowedTools: ['danger'] });
    a.unmount(); b.unmount(); mocks.store = createGlobalPermissionModeStore();
    const reopened = setup(); await ready(reopened);
    expect(reopened.result.current.permissionMode).toBe('bypassPermissions');
    await act(() => reopened.result.current.setPermissionMode('default'));
    expect(permissions.skipPermissions).toBe(false);
  });
  it('serializes rapid choices so the last choice wins on disk and in the UI', async () => {
    const hook = setup(); await ready(hook);
    await act(async () => { await Promise.all([hook.result.current.setPermissionMode('bypassPermissions'), hook.result.current.setPermissionMode('default')]); });
    expect(permissions.skipPermissions).toBe(false); expect(hook.result.current.permissionMode).toBe('default');
    expect(mocks.fetch.mock.calls.slice(1).map((call) => JSON.parse(call[1].body))).toEqual([{ skipPermissions: true }, { skipPermissions: false }]);
  });
  it('does not let an initial read overwrite a newer manual choice', async () => {
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const hook = setup(); await act(async () => { await Promise.resolve(); });
    await act(async () => { const save = hook.result.current.setPermissionMode('bypassPermissions'); resolve(json({ permissions: { ...permissions } })); await save; });
    expect(hook.result.current.permissionMode).toBe('bypassPermissions'); expect(permissions.skipPermissions).toBe(true);
  });
  it('rolls back failed saves, blocks sending and supports retry', async () => {
    const hook = setup(); await ready(hook); mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(hook.result.current.setPermissionMode('bypassPermissions')).rejects.toThrow('offline'); });
    expect(hook.result.current.permissionMode).toBe('default'); expect(hook.result.current.isPermissionModeReady).toBe(false);
    expect(hook.result.current.permissionModeError).toBe('offline');
    await act(() => hook.result.current.reloadPermissionMode()); await ready(hook); expect(permissions.skipPermissions).toBe(false);
  });
  it('does not silently use a default after a failed read', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: 'unauthorized' }, false)); const hook = setup();
    await waitFor(() => expect(hook.result.current.permissionModeError).toBe('unauthorized'));
    expect(hook.result.current.isPermissionModeReady).toBe(false);
  });
  it('refreshes another window’s choice from the backend', async () => {
    const hook = setup(); await ready(hook); permissions.skipPermissions = true;
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: PERMISSION_PREFERENCE_CHANGED })); });
    await ready(hook); expect(hook.result.current.permissionMode).toBe('bypassPermissions');
  });
  it('never persists the per-turn plan override', async () => {
    permissions.skipPermissions = true; const hook = setup(); await ready(hook);
    await expect(hook.result.current.setPermissionMode('plan')).rejects.toThrow('Invalid global');
    expect(permissions.skipPermissions).toBe(true); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
