import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatModelSelection } from './useChatModelSelection';
import { createGlobalModelSelectionStore, GLOBAL_MODEL_SELECTION_KEY, readSessionModelSelection } from '../utils/globalModelSelection';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), store: null as any }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../utils/globalModelSelection', async (original) => ({
  ...await original<typeof import('../utils/globalModelSelection')>(),
  get globalModelSelectionStore() { return mocks.store; },
}));
const A = { mode: 'model' as const, provider: 'HXAPI', model: 'first' };
const B = { mode: 'model' as const, provider: 'Other', model: 'second', reasoning: .8, temperature: .3, speed: 1 };
const AUTO = { mode: 'auto' as const };
const items = [A, B].map(s => ({ id: `${s.provider}/${s.model}`, ...s, displayName: s.model, available: true, capabilities: {} }));
const catalog = { items: [{ id: 'router/auto', provider: 'router', model: 'auto', displayName: 'Auto', available: true, capabilities: {} }, ...items], defaultSelection: B };
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const saved = () => JSON.parse(localStorage.getItem(GLOBAL_MODEL_SELECTION_KEY) || 'null');
const mount = (projectKey = '/a', sessionId = '') => renderHook((props: { projectKey: string; sessionId: string }) => useChatModelSelection(props), { initialProps: { projectKey, sessionId } });
const ready = async (hook: ReturnType<typeof mount>) => waitFor(() => expect(hook.result.current.isModelSelectionReady).toBe(true));
function track(runId: string, selection = A as typeof A | typeof B | typeof AUTO, projectKey = '/a', sessionId?: string) {
  mocks.store.trackMessage({ type: 'pilotdeck-command', options: { runId, modelSelection: selection, projectPath: projectKey, sessionId } });
}
function accept(runId: string, sessionId: string) { act(() => mocks.store.receiveMessage({ type: 'model-selection-saved', runId, sessionId })); }
function send(runId: string, sessionId: string, selection = A as typeof A | typeof B | typeof AUTO, project = '/a') { track(runId, selection, project, sessionId); accept(runId, sessionId); }
beforeEach(() => {
  localStorage.clear(); mocks.fetch.mockReset();
  mocks.fetch.mockImplementation((url: string) => Promise.resolve(json(url.startsWith('/api/models?') ? catalog : {})));
  mocks.store = createGlobalModelSelectionStore();
});
afterEach(cleanup);

describe('conversation model memory', () => {
  it('uses the configured default without recording it or trusting the legacy click preference', async () => {
    localStorage.setItem('composer-model-global', JSON.stringify(A));
    const hook = mount(); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(B);
    expect(saved()).toBeNull();
  });
  it('keeps clicks local and discards an unsent choice when navigating away', async () => {
    const first = mount(), second = mount('/b'); await ready(first); await ready(second);
    act(() => first.result.current.setModelSelection(A));
    expect(first.result.current.modelSelection).toEqual(A);
    expect(second.result.current.modelSelection).toEqual(B);
    expect(saved()).toBeNull();
    first.rerender({ projectKey: '/b', sessionId: '' });
    await ready(first); expect(first.result.current.modelSelection).toEqual(B);
  });
  it('remembers project and general sessions independently, while a new conversation uses the last global send', async () => {
    send('a', 'web:a', A); send('b', 'web:b', B, '/b'); send('c', 'web:c', AUTO, '/general');
    const hook = mount('/a', 'web:a'); await ready(hook); expect(hook.result.current.modelSelection).toEqual(A);
    hook.rerender({ projectKey: '/b', sessionId: 'web:b' }); await ready(hook); expect(hook.result.current.modelSelection).toEqual(B);
    hook.rerender({ projectKey: '/general', sessionId: 'web:c' }); await ready(hook); expect(hook.result.current.modelSelection).toEqual(AUTO);
    hook.rerender({ projectKey: '/new-project', sessionId: '' }); await ready(hook); expect(hook.result.current.modelSelection).toEqual(AUTO);
    expect(saved()).toEqual(AUTO);
  });
  it('records the first accepted send even without a manual change and keeps the captured parameters', async () => {
    const hook = mount(); await ready(hook); track('new', B);
    act(() => hook.result.current.setModelSelection(A));
    expect(saved()).toBeNull(); accept('new', 'web:created');
    expect(saved()).toEqual(B);
    expect(readSessionModelSelection('/a', 'web:created')).toEqual(B);
    expect(hook.result.current.modelSelection).toEqual(A);
  });
  it('does not record unacknowledged sends, failed queue submissions, or unrelated operation results', () => {
    track('unsent');
    mocks.store.trackMessage({ type: 'queue-input', requestId: 'q', sessionId: 'web:a', item: { options: { projectPath: '/a', modelSelection: B } } });
    act(() => mocks.store.receiveMessage({ type: 'input-queue-operation-result', requestId: 'q', sessionId: 'web:a', ok: false }));
    act(() => mocks.store.receiveMessage({ type: 'input-queue-operation-result', requestId: 'delete', sessionId: 'web:a', ok: true }));
    expect(saved()).toBeNull(); expect(readSessionModelSelection('/a', 'web:a')).toBeNull();
  });
  it('remembers a queue submission as soon as the server accepts it, including while the composer is unmounted', () => {
    mocks.store.trackMessage({ type: 'queue-input', requestId: 'q', sessionId: 'web:a', item: { options: { projectPath: '/a', modelSelection: AUTO } } });
    act(() => mocks.store.receiveMessage({ type: 'input-queue-operation-result', requestId: 'q', sessionId: 'web:a', ok: true }));
    expect(saved()).toEqual(AUTO); expect(readSessionModelSelection('/a', 'web:a')).toEqual(AUTO);
  });
  it('does not overwrite a later successful send with an earlier acknowledgement, replay, or actual Auto route', () => {
    track('old', A, '/a', 'web:a'); track('new', B, '/a', 'web:a'); accept('new', 'web:a'); accept('old', 'web:a');
    expect(saved()).toEqual(B); expect(readSessionModelSelection('/a', 'web:a')).toEqual(B);
    accept('old', 'web:a'); accept('replay', 'web:replay');
    send('auto', 'web:auto', AUTO);
    act(() => mocks.store.receiveMessage({ type: 'model-selection-changed', sessionId: 'web:auto', model: 'resolved', modelProvider: 'HXAPI' }));
    expect(saved()).toEqual(AUTO);
  });
  it('allows an earlier send to update its own session without replacing the later global choice', () => {
    track('a', A, '/a', 'web:a'); send('b', 'web:b', B, '/b'); accept('a', 'web:a');
    expect(saved()).toEqual(B); expect(readSessionModelSelection('/a', 'web:a')).toEqual(A);
  });
  it('restores persisted preferences across a full reload without changing provider casing', async () => {
    send('a', 'web:a', A); send('b', 'web:b', B, '/b'); mocks.store = createGlobalModelSelectionStore();
    const hook = mount('/a', 'web:a'); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(A); expect(saved()).toEqual(B);
  });
  it('recovers an old conversation from recorded server selection, including Auto, without changing the global preference', async () => {
    send('a', 'web:a', A);
    mocks.fetch.mockImplementation((url: string) => Promise.resolve(json(url.startsWith('/api/models?') ? catalog : { saved: AUTO, effective: { provider: 'concrete', model: 'routed' } })));
    const hook = mount('/old', 'web:old'); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(AUTO); expect(saved()).toEqual(A);
  });
  it('falls back to the global last send only when the old session has no record', async () => {
    send('a', 'web:a', A); const hook = mount('/old', 'web:old'); await ready(hook);
    expect(hook.result.current.modelSelection).toEqual(A); expect(readSessionModelSelection('/old', 'web:old')).toBeNull();
  });
  it('does not confuse a restoration failure with an empty record, and permits explicit selection to recover', async () => {
    mocks.fetch.mockImplementation((url: string) => Promise.resolve(json(url.startsWith('/api/models?') ? catalog : { error: { message: 'Offline' } }, url.startsWith('/api/models?') ? 200 : 503)));
    const hook = mount('/a', 'web:old'); await waitFor(() => expect(hook.result.current.modelCatalogError).toBe('Offline'));
    expect(hook.result.current.isModelSelectionReady).toBe(false);
    act(() => hook.result.current.setModelSelection(A)); expect(hook.result.current.isModelSelectionReady).toBe(true); expect(saved()).toBeNull();
  });
  it('ignores a slow history response after switching conversations and preserves a click made during restoration', async () => {
    const pending = deferred<ReturnType<typeof json>>(); mocks.fetch.mockImplementation((url: string) => url.includes('web%3Aslow') ? pending.promise : Promise.resolve(json(url.startsWith('/api/models?') ? catalog : { saved: B })));
    const hook = mount('/a', 'web:slow'); hook.rerender({ projectKey: '/b', sessionId: 'web:fast' }); await ready(hook);
    act(() => hook.result.current.setModelSelection(A)); await act(() => pending.resolve(json({ saved: AUTO })));
    expect(hook.result.current.modelSelection).toEqual(A);
  });
  it('keeps a removed historical model visible but blocks sending until explicitly replaced', async () => {
    send('a', 'web:a', A); mocks.fetch.mockImplementation((url: string) => Promise.resolve(json(url.startsWith('/api/models?') ? { ...catalog, items: [] } : {})));
    const hook = mount('/a', 'web:a'); await waitFor(() => expect(hook.result.current.isModelCatalogLoading).toBe(false));
    expect(hook.result.current.modelSelection).toEqual(A); expect(hook.result.current.isModelSelectionReady).toBe(false); expect(hook.result.current.modelCatalogError).toBeNull();
    mocks.fetch.mockResolvedValue(json({ ...catalog, items: items.filter(x=>x.model===B.model) })); act(()=>mocks.store.invalidate());
    await waitFor(()=>expect(hook.result.current.modelCatalogError).toContain('HXAPI/first'));
    act(()=>hook.result.current.setModelSelection(B)); await ready(hook); expect(readSessionModelSelection('/a','web:a')).toEqual(A);
  });
  it('synchronizes global accepted sends from another tab without replacing a history or a local draft', async () => {
    send('a','web:a',A); const history=mount('/a','web:a'), fresh=mount('/b'); await ready(history); await ready(fresh);
    localStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(B)); act(()=>window.dispatchEvent(new StorageEvent('storage',{ key:GLOBAL_MODEL_SELECTION_KEY,storageArea:localStorage })));
    expect(history.result.current.modelSelection).toEqual(A); expect(fresh.result.current.modelSelection).toEqual(B);
  });
  it('refreshes the catalog on reconnect without replacing draft or sent choices', async () => {
    const hook=mount(); await ready(hook); act(()=>hook.result.current.setModelSelection(A));
    mocks.fetch.mockResolvedValue(json({ ...catalog, items: items.filter(x=>x.model===B.model) })); act(()=>mocks.store.invalidate());
    await waitFor(()=>expect(hook.result.current.modelCatalogError).toContain('HXAPI/first')); expect(saved()).toBeNull();
  });
});
