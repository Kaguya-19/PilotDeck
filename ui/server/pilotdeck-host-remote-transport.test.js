// @vitest-environment node
import express from 'express';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { createRuntimeHostCapabilityProvider } from '../../src/composition/publicHostRuntimeAdapter.js';
import { createRemoteHostCapabilities } from './pilotdeck-host-remote-transport.mjs';
import { createModuleRuntimeRouter } from './routes/modules.js';

const closes = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const principal = { pilotDeckUserId: 'local', tenantId: 'tenant', actorUserId: 'actor', agentId: 'target' };
let nextPort = 16615;
async function runtime(resolve) {
  const server = await startGatewayServer({ gateway: {}, token: 'server-only', port: nextPort++, publicHostCapabilities: resolve });
  closes.push(() => server.close());
  return server;
}
async function consumer(runtimeServer) {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'local' }; next(); });
  app.use('/api/modules', createModuleRuntimeRouter({
    loadConfig: () => ({ webui: { staffdeckCopy: { enabled: true, contract: 'staffdeck.enterprise-copy/v1', ...principal, targetAgentId: 'target' } } }),
    getGateway: async () => ({}),
    getHostCapabilities: ({ principal: boundPrincipal, signal }) => createRemoteHostCapabilities({ url: runtimeServer.wsUrl, token: 'server-only', principal: boundPrincipal, signal }),
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(nextPort++, '127.0.0.1', resolve));
  closes.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (operation, input = {}, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/modules/host-capabilities/${options.callback ? 'callback' : 'call'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }), signal: options.signal,
  });
}

it('runs selected real-method adapter through authenticated runtime HTTP and production-shaped module gateway', async () => {
  let reads = 0;
  const provider = createRuntimeHostCapabilityProvider({
    profile: { id: 'active' }, tools: {}, model: {},
    skills: { list: async () => { reads++; return { items: [{ slug: 'source', id: 'source', readonly: true }], nextCursor: null }; } },
    context: { forTool: () => { throw new Error('not advertised'); } },
  });
  const server = await runtime(requestPrincipal => { expect(requestPrincipal).toEqual(principal); return provider; });
  const call = await consumer(server);
  const response = await call('list_general_skills');
  expect(response.status).toBe(200);
  expect((await response.json()).data).toEqual([{ slug: 'source', id: 'source', readonly: true }]);
  expect(reads).toBe(1);
  expect((await call('create_tool', { body: {} })).status).toBe(409);
  expect(reads).toBe(1);
  const forbidden = await fetch(new URL('/api/module-host/describe', server.url), { method: 'POST', body: '{}' });
  expect(forbidden.status).toBe(401);
  const mismatch = await call('list_general_skills', { agent_id: 'other' });
  expect(mismatch.status).toBe(400); expect(reads).toBe(1);
});

it('preserves original status/raw error/ETag and carries declared NDJSON through both HTTP hops', async () => {
  const server = await runtime(() => ({ operations: ['test_tool', 'model_stream', 'model_prepare'], call: async (operation, input) => operation === 'model_prepare'
    ? { status: 200, body: (async function* () { yield { type: 'unframed' }; })() }
    : input.toolId === 'plain'
    ? { status: 422, body: 'original non-JSON error', headers: { 'content-type': 'text/plain' } }
    : operation === 'test_tool'
    ? { status: 412, body: { detail: 'original' }, rawBody: '{ "detail": "original" }', headers: { 'content-type': 'application/json', etag: 'original-etag' } }
    : { status: 206, headers: { 'content-type': 'application/x-ndjson', 'x-pilotdeck-model-id': 'configured' }, body: (async function* () { yield { type: 'text.delta', text: '真实' }; yield { type: 'completed', finishReason: 'stop' }; })() }
  }));
  const call = await consumer(server);
  const error = await call('test_tool', { toolId: 'original', body: {} });
  expect(error.status).toBe(412); expect(error.headers.get('etag')).toBe('original-etag');
  expect(await error.text()).toBe('{ "detail": "original" }');
  const plain = await call('test_tool', { toolId: 'plain', body: {} });
  expect(plain.status).toBe(422); expect(await plain.text()).toBe('original non-JSON error');
  const unframed = await call('model_prepare', {}, { callback: true });
  expect(unframed.status).toBe(502); expect((await unframed.json()).code).toBe('PILOTDECK_HOST_RESPONSE_INVALID');
  const stream = await call('model_stream', { request: {} }, { callback: true });
  expect(stream.status).toBe(206);
  expect(stream.headers.get('x-pilotdeck-model-id')).toBe('configured');
  expect(await stream.text()).toBe('{"type":"text.delta","text":"真实"}\n{"type":"completed","finishReason":"stop"}\n');
});

it('propagates disconnect to the original stream signal and disposes without remote cancellation', async () => {
  let closed; const done = new Promise(resolve => { closed = resolve; }); let cancels = 0;
  const server = await runtime(() => ({ operations: ['model_stream', 'task_cancel'], call: async (operation, _input, { signal }) => {
    if (operation === 'task_cancel') { cancels++; return { status: 200, body: {} }; }
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () {
      try { yield 'id: cursor\nevent: model\ndata: {"text":"真实"}\n\n'; await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })); }
      finally { closed(); }
    })() };
  } }));
  const call = await consumer(server);
  const controller = new AbortController();
  const response = await call('model_stream', {}, { callback: true, signal: controller.signal });
  const chunk = await response.body.getReader().read();
  expect(new TextDecoder().decode(chunk.value)).toContain('id: cursor');
  controller.abort(); await done; expect(cancels).toBe(0);
}, 10000);
