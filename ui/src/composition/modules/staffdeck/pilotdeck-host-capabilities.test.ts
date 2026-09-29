import { expect, it, vi } from 'vitest';
import { callPublicHost } from './public-host-mapping';
import type { PilotDeckHostCapabilityPort } from './pilotdeck-host-capabilities';
it('uses only the injected PD binding, preserves signal/schema and keeps mounted catalogs independent', async () => {
  const signal = new AbortController().signal;
  const rows = [{ id: 'tool', name: 'Actual', input_schema: { extensions: true }, extension: { preserved: true } }];
  const call = vi.fn().mockResolvedValue({ status: 200, body: { data: rows } });
  const port: PilotDeckHostCapabilityPort = { call };
  expect(await callPublicHost({ operation: 'list_tools', input: {}, collection: true }, { kind: 'agent', agentId: 'target' }, signal, port)).toBe(rows);
  expect(call).toHaveBeenCalledWith('list_tools', {}, { signal });
  const second = { call: vi.fn().mockResolvedValue({ status: 200, body: { data: [] } }) };
  expect(await callPublicHost({ operation: 'list_tools', input: {}, collection: true }, { kind: 'agent', agentId: 'target' }, undefined, second)).toEqual([]);
  expect(call).toHaveBeenCalledTimes(1);
});
it('does not fall back to SD on missing/failed host capability and keeps the original error body', async () => {
  await expect(callPublicHost({ operation: 'list_model_catalog', input: {}, collection: true }, { kind: 'agent', agentId: 'target' })).rejects.toMatchObject({ code: 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE' });
  const call = vi.fn().mockResolvedValue({ status: 503, body: { code: 'HOST_MODEL_UNAVAILABLE', message: 'Unavailable' } });
  await expect(callPublicHost({ operation: 'list_model_catalog', input: {}, collection: true }, { kind: 'agent', agentId: 'target' }, undefined, { call })).rejects.toMatchObject({ status: 503, code: 'HOST_MODEL_UNAVAILABLE' });
  expect(call).toHaveBeenCalledTimes(1);
});
