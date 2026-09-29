// @vitest-environment node
import express from 'express';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createModuleRuntimeRouter } from './modules.js';
import { encodeHostCapabilityStream } from '../pilotdeck-host-capability-gateway.mjs';

const servers = [];
let nextPort = 16600;
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); });
async function fixture(gateway, user = 'local') {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: user }; next(); });
  app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ webui: { staffdeckCopy: {
    enabled: true, contract: 'staffdeck.enterprise-copy/v1', pilotDeckUserId: 'local', tenantId: 'tenant', actorUserId: 'actor', targetAgentId: 'target',
  } } }), getGateway: async () => gateway }));
  const server = http.createServer(app); servers.push(server);
  await new Promise(resolve => server.listen(nextPort++, '127.0.0.1', resolve));
  return (operation, input = {}, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/modules/host-capabilities/${options.callback ? 'callback' : 'call'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }), signal: options.signal,
  });
}

it('projects the same Gateway model and skill catalogs without constructing another provider', async () => {
  const modelCatalogList = vi.fn(async () => ({ items: [{ id: 'pd-model-id', displayName: 'PD model', provider: 'p', model: 'm', available: true }], defaultSelection: { provider: 'p', model: 'm' } }));
  const skillsList = vi.fn(async () => ({ items: [{ slug: 'pd-skill', name: 'PD skill', scope: 'user', readonly: false }] }));
  const call = await fixture({ modelCatalogList, skillsList });
  expect(await (await call('list_model_catalog')).json()).toEqual({ data: [{ id: 'pd-model-id', displayName: 'PD model', provider: 'p', model: 'm', available: true, name: 'PD model', enabled: true, is_default: true }] });
  expect(await (await call('list_general_skills')).json()).toEqual({ data: [{ id: 'pd-skill', slug: 'pd-skill', name: 'PD skill', scope: 'user', readonly: false }] });
  expect(modelCatalogList).toHaveBeenCalledTimes(1); expect(skillsList).toHaveBeenCalledTimes(1);
  expect((await call('create_tool', { body: {} })).status).toBe(501);
});

it('consumes declared host Port once, retaining descriptor schema, raw errors, identity and cancellation', async () => {
  const calls = [];
  const port = { operations: ['list_tools', 'probe_unsaved_tool'], call: async (operation, input, context) => {
    calls.push({ operation, input, context });
    if (operation === 'probe_unsaved_tool') return { status: 422, body: 'original', rawBody: '{"detail":"original schema"}', headers: { 'content-type': 'application/json', 'x-request-id': 'pd-request' } };
    return { status: 200, body: { data: [{ id: 'tool', name: 'native', input_schema: { type: 'object', required: ['exact'] } }] } };
  } };
  const fallback = vi.fn();
  const call = await fixture({ moduleHostCapabilities: port, modelCatalogList: fallback });
  expect(await (await call('list_tools')).json()).toEqual({ data: [{ id: 'tool', name: 'native', input_schema: { type: 'object', required: ['exact'] } }] });
  const error = await call('probe_unsaved_tool', { body: { input: { exact: 'value' } } });
  expect(error.status).toBe(422); expect(await error.text()).toBe('{"detail":"original schema"}');
  expect(error.headers.get('x-request-id')).toBe('pd-request');
  expect(calls[1].input).toEqual({ body: { input: { exact: 'value' } } });
  expect(calls[0].context.principal).toEqual({ pilotDeckUserId: 'local', tenantId: 'tenant', actorUserId: 'actor', agentId: 'target' });
  expect(calls[0].context.signal).toBeInstanceOf(AbortSignal);
  expect((await call('list_model_catalog')).status).toBe(409);
  expect(fallback).not.toHaveBeenCalled();
  expect((await call('list_tools', { tenantId: 'other' })).status).toBe(400);
  const forbidden = await fixture({ moduleHostCapabilities: port }, 'other');
  expect((await forbidden('list_tools')).status).toBe(403); expect(calls).toHaveLength(2);
});

it('forwards real model callback event bytes and aborts iterator without task cancellation', async () => {
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const calls = [];
  const port = { operations: ['model_stream', 'task_cancel'], call: async (operation, input, { signal }) => {
    calls.push({ operation, input });
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () {
      try {
        yield 'id: original\nevent: model\ndata: {"text":"真实"}\n\n';
        await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      } finally { closed(); }
    })() };
  } };
  const call = await fixture({ moduleHostCapabilities: port });
  expect((await call('model_stream', {})).status).toBe(400);
  const controller = new AbortController();
  const response = await call('model_stream', { request: { model: 'pd-model-id' } }, { callback: true, signal: controller.signal });
  const first = await response.body.getReader().read();
  expect(new TextDecoder().decode(first.value)).toBe('id: original\nevent: model\ndata: {"text":"真实"}\n\n');
  controller.abort(); await closedPromise;
  expect(calls).toEqual([{ operation: 'model_stream', input: { request: { model: 'pd-model-id' } } }]);
}, 10000);

it('frames actual canonical NDJSON events and preserves existing bytes without double encoding', async () => {
  const events = [{ type: 'text.delta', text: '真实\n内容' }, { type: 'completed', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 2 } }];
  let disposed = false;
  const call = await fixture({ moduleHostCapabilities: {
    operations: ['model_stream'],
    call: async () => ({ status: 200, headers: { 'content-type': 'application/x-ndjson', 'x-pilotdeck-model-id': 'configured-model', 'x-pilotdeck-provider-id': 'configured-provider' }, body: (async function* () {
      try { yield events[0]; yield new TextEncoder().encode(JSON.stringify(events[1]) + '\n'); } finally { disposed = true; }
    })() }),
  } });
  const response = await call('model_stream', { request: {} }, { callback: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  expect(response.headers.get('x-pilotdeck-model-id')).toBe('configured-model');
  expect(response.headers.get('x-pilotdeck-provider-id')).toBe('configured-provider');
  expect(await response.text()).toBe(events.map(event => JSON.stringify(event) + '\n').join(''));
  expect(disposed).toBe(true);
});

it('does not invent SSE framing for objects and releases invalid stream iterators', async () => {
  let disposed = false;
  async function* events() { try { yield { type: 'text.delta', text: 'unframed' }; } finally { disposed = true; } }
  const consume = async () => { for await (const chunk of encodeHostCapabilityStream(events(), 'text/event-stream')) void chunk; };
  await expect(consume()).rejects.toMatchObject({ status: 502, code: 'PILOTDECK_HOST_RESPONSE_INVALID' });
  expect(disposed).toBe(true);
});
