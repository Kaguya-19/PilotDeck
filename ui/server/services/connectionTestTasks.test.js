import { describe, it, expect, vi } from 'vitest';
import { createConnectionTestTasks } from './connectionTestTasks.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const passed = { testId: 'test-1', status: 'passed', models: [] };
const make = (overrides = {}) => createConnectionTestTasks({ prepare: () => async () => passed, persist: async () => {}, getRecord: () => ({ record: {} }), applyImage: () => passed, ...overrides });

describe('server-owned connection test tasks', () => {
  it('continues without subscribers, blocks duplicate starts through saving, and preserves results by provider', async () => {
    const probe = deferred(), save = deferred();
    const persist = vi.fn(() => save.promise);
    const manager = make({ prepare: () => () => probe.promise, persist });
    const task = manager.start('one', { providerId: 'HXAPI', apiKey: 'never-expose' });
    expect(manager.list('one')[0].status).toBe('testing');
    expect(JSON.stringify(manager.list('one'))).not.toContain('never-expose');
    expect(() => manager.start('one', { providerId: 'aicore' })).toThrow();
    expect(manager.list('two')).toEqual([]);
    expect(() => manager.cancel('two', task.id)).toThrow();
    probe.resolve(passed);
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('savingTest'));
    expect(() => manager.start('one', { providerId: 'aicore' })).toThrow();
    expect(() => manager.cancel('one', task.id)).toThrow();
    save.resolve();
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('success'));
    manager.start('one', { providerId: 'aicore' });
    expect(manager.list('one').find(t => t.providerId === 'HXAPI').status).toBe('success');
  });
  it('keeps manual confirmation through navigation and saves only after confirmation', async () => {
    const persist = vi.fn();
    const manager = make({ prepare: () => async () => ({ testId: 'test-1', manualInputRequired: true }), persist });
    const task = manager.start('one', { providerId: 'HXAPI' });
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('manual'));
    expect(persist).not.toHaveBeenCalled();
    manager.confirm('one', task.id, { models: [] });
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('success'));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(() => manager.confirm('one', task.id, {})).toThrow();
  });
  it('retries failed saves without probing again', async () => {
    const prepare = vi.fn(() => async () => passed);
    const persist = vi.fn().mockRejectedValueOnce(new Error('Disk busy')).mockResolvedValue(undefined);
    const manager = make({ prepare, persist });
    const task = manager.start('one', { providerId: 'HXAPI' });
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('saveError'));
    manager.retry('one', task.id);
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('success'));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
  });
  it('holds the slot until cancellation settles and never saves cancelled results', async () => {
    const work = deferred(); let signal;
    const persist = vi.fn();
    const manager = make({ prepare: () => s => { signal = s; return work.promise; }, persist });
    const task = manager.start('one', { providerId: 'HXAPI' });
    manager.cancel('one', task.id);
    expect(signal.aborted).toBe(true);
    expect(manager.list('one')[0].status).toBe('cancelling');
    expect(() => manager.start('one', { providerId: 'aicore' })).toThrow();
    work.resolve(passed);
    await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('cancelled'));
    expect(persist).not.toHaveBeenCalled();
  });
});

it('keeps single-model tests separate and never persists their draft capability results', async () => {
  const persist = vi.fn();
  const manager = make({persist, prepare: body => async () => ({...passed, models: body.models.map(modelId => ({modelId, textInput:'supported',imageInput:'unknown'})), status:'manual_input_required', manualInputRequired:true})});
  manager.start('one',{providerId:'HXAPI',models:['a']},{modelId:'a'});
  await vi.waitFor(() => expect(manager.list('one')[0].status).toBe('success'));
  manager.start('one',{providerId:'HXAPI',models:['b']},{modelId:'b'});
  await vi.waitFor(() => expect(manager.list('one')).toHaveLength(2));
  expect(manager.list('one').map(t => t.modelId)).toEqual(['a','b']);
  manager.acknowledge('one', manager.list('one')[0].id);
  expect(manager.list('one')[0].acknowledged).toBe(true);
  expect(manager.list('two')).toEqual([]);
  expect(persist).not.toHaveBeenCalled();
});
it('rejects a completed single-model result if the connection changed', async () => {
  const manager = make({isCurrent: () => false});
  manager.start('one',{providerId:'HXAPI',models:['a']},{modelId:'a'});
  await vi.waitFor(() => expect(manager.list('one')[0]).toMatchObject({status:'error',result:null,code:'CONFIGURATION_MISMATCH'}));
});
