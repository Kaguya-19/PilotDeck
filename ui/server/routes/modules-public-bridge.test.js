import express from 'express';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createModuleRuntimeRouter } from './modules.js';

const ownedServers = [];
let nextPort = 16660;
afterEach(async () => {
  await Promise.all(ownedServers.splice(0).map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

async function listen(app) {
  for (; nextPort < 16680;) {
    const port = nextPort++;
    const server = http.createServer(app);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      ownedServers.push(server);
      return `http://127.0.0.1:${port}`;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free owned test port in 16660–16679');
}

async function fixture(onCreate, onList = (_req, res) => res.json({ data: [] }), options = {}) {
  const key = 'sdak_bridge_test_account_123456789';
  const native = express();
  native.use(express.json());
  native.get('/api/auth/me', options.onIdentity ?? ((_req, res) => res.json({ id: 'actor', tenant_id: 'tenant' })));
  native.get('/api/enterprise/agents', options.onDirectory ?? ((_req, res) => res.json([{ id: 'agent', tenant_id: 'tenant', is_overall: false }])));
  if (options.onKnowledge) native.post('/v2/module/call', options.onKnowledge);
  native.get('/api/auth/me/api-credentials', (_req, res) => res.json([{ id: 'owned', user_id: 'actor',
    key_prefix: key.slice(0, 20) + '…', access: 'user_full_access', status: 'active', scopes: ['sops:read', 'sops:write', 'sops:publish'] }]));
  native.post('/api/v1/agents/agent/sops', onCreate);
  native.get('/api/v1/agents/agent/sops', onList);
  if (options.onPublish) native.post(/^\/api\/v1\/sops\/selected:publish$/, options.onPublish);
  const origin = await listen(native);
  const config = {
    webui: { staffdeckCopy: { enabled: true, contract: 'staffdeck.enterprise-copy/v1', endpoint: origin,
      tenantId: 'tenant', actorUserId: 'actor', targetAgentId: 'agent', pilotDeckUserId: 'local', userTokenEnv: 'BRIDGE_TEST_LOGIN_TOKEN', methods: ['list_agents'] } },
    modules: { sop: { enabled: true, ...options.binding, management: { enabled: true, endpoint: origin + '/api/v1', apiKeyEnv: 'BRIDGE_TEST_ACCOUNT_KEY',
      credentialId: 'owned', agentId: 'agent', methods: ['create', 'list', 'publish'] } } },
  };
  if (options.onKnowledge) config.modules.knowledge = { enabled: true, endpoint: origin,
    tenantId: 'tenant', actorUserId: 'actor', agentId: 'agent', methods: ['list_bases'] };
  if (options.binding) config.modules.sop.discoveryEndpoint = origin + '/api/v1';
  const previous = process.env.BRIDGE_TEST_LOGIN_TOKEN;
  const previousKey = process.env.BRIDGE_TEST_ACCOUNT_KEY;
  process.env.BRIDGE_TEST_ACCOUNT_KEY = key;
  process.env.BRIDGE_TEST_LOGIN_TOKEN = 'test-login';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'local' }; next(); });
  app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => config, ...(options.getGateway ? { getGateway: options.getGateway } : {}) }));
  const local = await listen(app);
  return {
    read: () => fetch(local + '/api/modules/sop/management'),
    copy: (signal) => fetch(local + '/api/modules/staffdeck-copy/call', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list_agents', input: {} }), signal,
    }),
    knowledge: () => fetch(local + '/api/modules/knowledge/call', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list_bases', input: {} }),
    }),
    call: (operation, input, signal) => fetch(local + '/api/modules/sop/management/call', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }), signal,
    }),
    restore: () => { if (previousKey === undefined) delete process.env.BRIDGE_TEST_ACCOUNT_KEY; else process.env.BRIDGE_TEST_ACCOUNT_KEY = previousKey; if (previous === undefined) delete process.env.BRIDGE_TEST_LOGIN_TOKEN; else process.env.BRIDGE_TEST_LOGIN_TOKEN = previous; },
  };
}

it('creates the selected SOP content once and returns the original create ETag', async () => {
  const writes = [];
  const content = { name: 'Complex', version: '1.2.3', nodes: [{ node_id: 'n', config: { extra: true } }], edges: [], extension: ['kept'] };
  const f = await fixture((req, res) => {
    writes.push(req.body);
    res.setHeader('ETag', 'first-draft-etag');
    res.status(201).json({ id: 'actual-draft', sop_id: 'selected', content: req.body.content, version: '1.2.3' });
  });
  try {
    const response = await f.call('create', { sopId: 'selected', content });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ result: { id: 'actual-draft', sop_id: 'selected', etag: 'first-draft-etag', content: { ...content, skill_id: 'selected' } } });
    expect(writes).toEqual([{ content: { ...content, skill_id: 'selected' } }]);
    expect((await f.call('create', { sopId: 'selected', content: { ...content, skill_id: 'other' } })).status).toBe(400);
    expect(writes).toHaveLength(1);
  } finally { f.restore(); }
});

it('aborts the real upstream request when the browser disconnects', async () => {
  let resolveStarted;
  let resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const f = await fixture((_req, res) => res.json({}), (_req, res) => {
    res.once('close', () => resolveClosed(res.writableFinished));
    resolveStarted();
  });
  try {
    const controller = new AbortController();
    const pending = f.call('list', undefined, controller.signal).catch(error => error);
    await Promise.race([started, pending.then(async response => { if (response instanceof Error) throw response; throw new Error('Upstream not started: ' + response.status + ' ' + await response.text()); })]);
    controller.abort();
    expect((await pending).name).toBe('AbortError');
    expect(await closed).toBe(false);
  } finally { f.restore(); }
}, 10000);


it('normal publish route performs one owner publish, persists runtime receipt and returns unverified refresh state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publish-route-http-'));
  const path = join(dir, 'definitions.yaml');
  await writeFile(path, JSON.stringify({ sops: [{ id: 'selected', version: '1', content: { skill_id: 'selected', version: '1' } }] }));
  let publications = 0;
  const refreshes = [];
  const f = await fixture((_req, res) => res.json({}), undefined, {
    binding: { definitionsPath: path, defaultSopId: 'selected', discoveryAgentId: 'agent' },
    onPublish: (_req, res) => { publications++; res.json({ sop: { id: 'owner-row', skill_id: 'selected', version: '2', status: 'published', content: { skill_id: 'selected', version: '2', nodes: [], edges: [] } } }); },
    getGateway: async () => ({ reloadExtensions: async request => { refreshes.push(request); return { reloaded: true }; } }),
  });
  try {
    const response = await f.call('publish', { sopId: 'selected', draftId: 'draft' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { sop: { id: 'owner-row', skill_id: 'selected' } }, runtime: { ownerPublished: true, snapshotWritten: true, refreshRequested: true, receiptPersisted: true, effective: false, status: 'awaiting-runtime-observation' } });
    expect(publications).toBe(1);
    expect(refreshes).toEqual([{ changedPaths: [path] }]);
    const metadata = await (await f.read()).json();
    expect(metadata).toMatchObject({ tenantId: 'tenant', actorUserId: 'actor', agentId: 'agent' });
    expect(metadata).not.toHaveProperty('credentialId');
    expect(metadata.runtime.receipts).toEqual([expect.objectContaining({ sopId: 'selected', version: '2', effective: false, receiptPersisted: true })]);
  } finally { f.restore(); await rm(dir, { recursive: true, force: true }); }
});

it('authenticates every SOP request before management reads or writes', async () => {
  let accepted = true;
  let checks = 0;
  let reads = 0;
  let writes = 0;
  const f = await fixture((_req, res) => { writes++; res.json({}); }, (_req, res) => { reads++; res.json({ data: [] }); }, {
    onIdentity: (_req, res) => { checks++; res.json({ id: 'actor', tenant_id: accepted ? 'tenant' : 'other' }); },
  });
  try {
    expect((await f.call('list')).status).toBe(200);
    accepted = false;
    expect((await f.call('list')).status).toBe(403);
    expect((await f.call('create', { sopId: 'selected', content: { skill_id: 'selected' } })).status).toBe(403);
    expect((await f.read()).status).toBe(403);
    expect({ checks, reads, writes }).toEqual({ checks: 4, reads: 1, writes: 0 });
  } finally { f.restore(); }
});

it('authenticates every Knowledge read before the module transport is called', async () => {
  let accepted = true;
  let checks = 0;
  let calls = 0;
  const f = await fixture((_req, res) => res.json({}), undefined, {
    onIdentity: (_req, res) => { checks++; res.json({ id: accepted ? 'actor' : 'other', tenant_id: 'tenant' }); },
    onKnowledge: (req, res) => { calls++; res.json({ kind: 'response', inReplyTo: req.body.messageId, ok: true, payload: { result: [] } }); },
  });
  try {
    expect((await f.knowledge()).status).toBe(200);
    accepted = false;
    expect((await f.knowledge()).status).toBe(403);
    expect({ checks, calls }).toEqual({ checks: 2, calls: 1 });
  } finally { f.restore(); }
});

it('aborts the formal copy identity directory request when its browser disconnects', async () => {
  let resolveStarted;
  let resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const f = await fixture((_req, res) => res.json({}), undefined, {
    onDirectory: (_req, res) => { res.once('close', () => resolveClosed(res.writableFinished)); resolveStarted(); },
  });
  try {
    const controller = new AbortController();
    const pending = f.copy(controller.signal).catch(error => error);
    await Promise.race([started, pending.then(async response => { if (response instanceof Error) throw response; throw new Error('Directory not started: ' + response.status + ' ' + await response.text()); })]);
    controller.abort();
    expect((await pending).name).toBe('AbortError');
    expect(await closed).toBe(false);
  } finally { f.restore(); }
}, 10000);
