// @vitest-environment node
import express from 'express';
import http from 'node:http';
import multer from 'multer';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createModuleRuntimeRouter } from './modules.js';

const servers = [];
const restorations = [];
let nextPort = 16680;
afterEach(async () => {
  restorations.splice(0).forEach(restore => restore());
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});
async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(nextPort++, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(handle, { scopes = ['sops:read', 'sops:write', 'sops:publish', 'sops:cancel', 'tools:read', 'skills:read', 'knowledge:read'], identity, binding, getGateway } = {}) {
  const key = 'sdak_sdk_owned_account_123456789';
  const native = express();
  native.disable('etag');
  native.use(express.json());
  let checks = 0;
  native.get('/api/auth/me', identity ?? ((_req, res) => { checks++; res.json({ id: 'actor', tenant_id: 'tenant' }); }));
  native.get('/api/auth/me/api-credentials', (_req, res) => res.json([{ id: 'owned', user_id: 'actor',
    key_prefix: key.slice(0, 20) + '…', access: 'user_full_access', status: 'active', scopes }]));
  native.use('/api/v1', handle);
  const origin = await listen(native);
  for (const [name, value] of Object.entries({ SDK_TEST_LOGIN: 'login', SDK_TEST_KEY: key })) {
    const previous = process.env[name]; process.env[name] = value;
    restorations.push(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const config = {
    webui: { staffdeckCopy: { enabled: true, contract: 'staffdeck.enterprise-copy/v1', endpoint: origin,
      tenantId: 'tenant', actorUserId: 'actor', targetAgentId: 'target', pilotDeckUserId: 'local', userTokenEnv: 'SDK_TEST_LOGIN' } },
    modules: { sop: { enabled: true, ...binding, ...(binding ? { discoveryEndpoint: origin + '/api/v1/' } : {}), management: { enabled: true, endpoint: origin + '/api/v1/',
      apiKeyEnv: 'SDK_TEST_KEY', credentialId: 'owned', agentId: 'target', methods: ['list'] } } },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'local' }; next(); });
  app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => config, ...(getGateway ? { getGateway } : {}) }));
  const local = await listen(app);
  return {
    checks: () => checks,
    management: () => fetch(local + '/api/modules/sop/management'),
    call: (operation, input = {}, scope, signal) => fetch(local + '/api/modules/staffdeck-sdk/call', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input, scope }), signal,
    }),
    file: form => fetch(local + '/api/modules/staffdeck-sdk/file', { method: 'POST', body: form }),
    events: (query, headers = {}, signal) => fetch(local + '/api/modules/staffdeck-sdk/events?' + query, { headers, signal }),
  };
}

it('preserves real target 202/JSON/ETag and rejects excluded scopes before business transport', async () => {
  const requests = [];
  const f = await fixture((req, res) => {
    requests.push({ url: req.url, body: req.body, auth: req.get('authorization') });
    if (req.url === '/agents/non-target/tools') return res.status(403).type('text').send('original agent denial');
    res.status(202).set('ETag', 'owner-etag').type('json').send('{ "job_id": "preview" }');
  });
  const response = await f.call('preview_generate_sop', { body: { title: 'title', raw_content: 'dirty' } }, { kind: 'agent', agentId: 'target' });
  expect(response.status).toBe(202);
  expect(response.headers.get('etag')).toBe('owner-etag');
  expect(await response.text()).toBe('{ "job_id": "preview" }');
  const denied = await f.call('list_knowledge_bases', {}, { kind: 'agent', agentId: 'non-target' });
  expect(denied.status).toBe(403);
  expect(denied.headers.get('etag')).not.toBe('owner-etag');
  expect(await denied.json()).toMatchObject({ error: { code: 'PUBLIC_FIXED_TARGET_SCOPE_MISMATCH' } });
  expect(requests.map(r => r.url)).toEqual(['/agents/target/sops:preview-generate']);
  expect(requests[0].body).toEqual({ title: 'title', raw_content: 'dirty' });
  expect(requests.every(r => r.auth.startsWith('Bearer sdak_'))).toBe(true);
  expect(f.checks()).toBe(2);
});

it('rejects unknown operations, scope overrides and missing cancel scope before business fetch', async () => {
  let businessCalls = 0;
  const f = await fixture((_req, res) => { businessCalls++; res.json({}); }, { scopes: ['sops:read', 'sops:write', 'sops:publish'] });
  expect((await f.call('arbitrary_proxy', { url: 'https://example.invalid' })).status).toBe(400);
  expect((await f.call('list_knowledge_bases', { tenantId: 'other' })).status).toBe(400);
  const denied = await f.call('cancel_job', { jobId: 'job' });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: { code: 'PUBLIC_SCOPE_FORBIDDEN' } });
  expect(businessCalls).toBe(0);
});

it('passes explicit cancellation once and dirty preview unchanged without saving', async () => {
  const calls = [];
  const f = await fixture((req, res) => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    if (req.url.endsWith(':cancel')) return res.json({ id: 'job', status: 'cancel_requested' });
    res.status(202).json({ job_id: 'transient' });
  });
  expect(await (await f.call('cancel_job', { jobId: 'job' })).json()).toEqual({ id: 'job', status: 'cancel_requested' });
  const body = { current_skill: { skill_id: 'sop', nodes: [{ node_id: 'dirty' }] }, instruction: 'change', conversation: [{ role: 'user', content: 'keep' }] };
  expect((await f.call('preview_rewrite_sop', { sopId: 'sop', body }, { kind: 'agent', agentId: 'target' })).status).toBe(202);
  expect(calls).toEqual([
    { method: 'POST', url: '/jobs/job:cancel', body: {} },
    { method: 'POST', url: '/agents/target/sops/sop:preview-rewrite', body },
  ]);
});

it('preserves raw SSE bytes and keeps APIJob cursor separate from preview sequence', async () => {
  const calls = [];
  const raw = ': heartbeat\r\nid: 7\r\nevent: token\r\ndata: {"text":"中文","seq":9}\r\n\r\n';
  const f = await fixture((req, res) => {
    calls.push({ url: req.url, cursor: req.get('Last-Event-ID') });
    res.type('text/event-stream').write(Buffer.from(raw).subarray(0, 51));
    res.end(Buffer.from(raw).subarray(51));
  });
  const events = await f.events('operation=job_events&jobId=api&lastEventId=2', { 'Last-Event-ID': '7' });
  expect(events.status).toBe(200); expect(await events.text()).toBe(raw);
  const preview = await f.events('operation=preview_job_events&jobId=preview&scope=agent&agentId=target&afterSeq=9', { 'Last-Event-ID': '999' });
  expect(await preview.text()).toBe(raw);
  expect(calls).toEqual([{ url: '/jobs/api/events', cursor: '7' }, { url: '/agents/target/sop-preview-jobs/preview/events?after_seq=9', cursor: undefined }]);
});

it('returns original pre-stream error status/body rather than SSE success', async () => {
  const f = await fixture((_req, res) => res.status(409).set('Retry-After', '3').type('json').send('{"error":{"code":"ORIGINAL"}}'));
  const response = await f.events('operation=job_events&jobId=job');
  expect(response.status).toBe(409);
  expect(response.headers.get('retry-after')).toBe('3');
  expect(await response.text()).toBe('{"error":{"code":"ORIGINAL"}}');
});

it('browser stream abort closes upstream without issuing cancel', async () => {
  const calls = [];
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const f = await fixture((req, res) => {
    calls.push(req.url);
    res.type('text/event-stream').flushHeaders();
    res.write('data: {"seq":1}\n\n');
    res.once('close', () => close(res.writableFinished));
  });
  const controller = new AbortController();
  const response = await f.events('operation=preview_job_events&jobId=preview&scope=agent&agentId=target', {}, controller.signal);
  await response.body.getReader().read();
  controller.abort();
  expect(await closed).toBe(false);
  expect(calls).toEqual(['/agents/target/sop-preview-jobs/preview/events']);
}, 10000);


it('requires explicit scope, rejects legacy target fallback and leaves global jobs unscoped', async () => {
  const calls = [];
  const f = await fixture((req, res) => { calls.push(req.url); res.json({ id: 'job', status: 'running' }); });
  const missing = await f.call('list_knowledge_bases');
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: { code: 'PUBLIC_SELECTED_SCOPE_REQUIRED' } });
  expect((await f.call('list_knowledge_bases', { agentId: 'target' })).status).toBe(400);
  expect((await f.call('list_knowledge_bases', {}, { kind: 'agent' })).status).toBe(400);
  expect((await f.events('operation=preview_job_events&jobId=preview&scope=team&agentId=target')).status).toBe(400);
  expect(f.checks()).toBe(0);
  expect((await f.call('get_job', { jobId: 'job' })).status).toBe(200);
  expect((await f.call('get_job', { jobId: 'job' }, { kind: 'team' })).status).toBe(400);
  expect((await f.call('update_tool', { toolId: 'tool', body: {}, etag: 'original' }, { kind: 'agent', agentId: 'target' })).status).toBe(409);
  expect(calls).toEqual(['/jobs/job']);
});

it('rejects excluded team catalogs and preview calls and streams before business transport', async () => {
  const calls = [];
  const f = await fixture((req, res) => { calls.push(req.url); res.json({}); });
  for (const operation of ['list_knowledge_bases', 'list_sops',
    'preview_generate_sop', 'preview_rewrite_sop', 'get_preview_job', 'cancel_preview_job', 'remove_sop']) {
    const response = await f.call(operation, { jobId: 'preview', sopId: 'sop', body: {} }, { kind: 'team' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'PUBLIC_FIXED_TARGET_SCOPE_MISMATCH' } });
  }
  const stream = await f.events('operation=preview_job_events&jobId=preview&scope=team&afterSeq=2');
  expect(stream.status).toBe(403);
  expect(await stream.json()).toMatchObject({ error: { code: 'PUBLIC_FIXED_TARGET_SCOPE_MISMATCH' } });
  expect(calls).toEqual([]);
});


it('routes selected draft/version management precisely and preserves same-response ETags and precondition errors', async () => {
  const calls = [];
  const draft = { id: 'draft/id', sop_id: 'sop/id', content: { skill_id: 'sop/id' }, etag: '"original etag"' };
  const f = await fixture((req, res) => {
    calls.push({ method: req.method, url: req.url, body: req.body, etag: req.get('If-Match') });
    if (req.method === 'PUT' && req.get('If-Match') !== draft.etag) return res.status(412).type('json').end('{"error":{"code":"ETAG_MISMATCH"}}');
    if (req.url.includes('/versions/v%2F1:rollback')) return res.status(201).json(draft);
    if (req.url.includes('/versions/v%2F1')) return res.json({ version: 'v/1', content: draft.content });
    if (req.url.includes('/versions')) return res.json({ data: [{ version: 'v/1' }] });
    if (req.url.includes(':archive')) return res.json({ skill_id: 'sop/id', status: 'archived' });
    return res.status(req.method === 'POST' ? 201 : 200).set('ETag', draft.etag).json(draft);
  });
  const scope = { kind: 'agent', agentId: 'target' };
  for (const [operation, input, status] of [
    ['get_sop_draft', { sopId: 'sop/id', draftId: 'draft/id' }, 200],
    ['create_sop_draft', { body: { content: draft.content } }, 201],
    ['replace_sop_draft', { sopId: 'sop/id', draftId: 'draft/id', etag: draft.etag, body: { content: draft.content } }, 200],
  ]) {
    const response = await f.call(operation, input, scope);
    expect(response.status).toBe(status);
    expect(response.headers.get('etag')).toBe(draft.etag);
    expect(await response.json()).toEqual(draft);
  }
  const input = { sopId: 'sop/id', draftId: 'draft/id', body: { content: draft.content } };
  expect((await f.call('replace_sop_draft', input, scope)).status).toBe(428);
  const stale = await f.call('replace_sop_draft', { ...input, etag: '"stale"' }, scope);
  expect(stale.status).toBe(412); expect(await stale.text()).toBe('{"error":{"code":"ETAG_MISMATCH"}}');
  expect((await f.call('list_sop_versions', { sopId: 'sop/id' }, scope)).status).toBe(200);
  expect((await f.call('get_sop_version', { sopId: 'sop/id', version: 'v/1' }, scope)).status).toBe(200);
  const rolled = await f.call('rollback_sop_version', { sopId: 'sop/id', version: 'v/1' }, scope);
  expect(rolled.status).toBe(201); expect(await rolled.json()).toEqual(draft);
  expect((await f.call('archive_sop', { sopId: 'sop/id' }, scope)).status).toBe(200);
  expect(calls.map(c => c.url)).toEqual([
    '/agents/target/sops/sop%2Fid/drafts/draft%2Fid', '/agents/target/sops',
    '/agents/target/sops/sop%2Fid?draft_id=draft%2Fid', '/agents/target/sops/sop%2Fid?draft_id=draft%2Fid',
    '/sops/sop%2Fid/versions?agent_id=target', '/sops/sop%2Fid/versions/v%2F1?agent_id=target',
    '/sops/sop%2Fid/versions/v%2F1:rollback?agent_id=target', '/sops/sop%2Fid:archive?agent_id=target',
  ]);
  expect(calls[2].etag).toBe(draft.etag); expect(calls[3].etag).toBe('"stale"');
});

it('rejects excluded team draft/version management without business transport', async () => {
  const calls = [];
  const f = await fixture((req, res) => { calls.push(req.url); res.json({}); });
  for (const operation of ['list_sop_versions', 'get_sop_version', 'get_sop_draft', 'create_sop_draft',
    'replace_sop_draft', 'publish_sop', 'archive_sop', 'rollback_sop_version']) {
    const response = await f.call(operation, { sopId: 'sop', draftId: 'draft', version: '1',
      ...(operation === 'replace_sop_draft' ? { etag: 'original' } : {}) }, { kind: 'team' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'PUBLIC_FIXED_TARGET_SCOPE_MISMATCH' } });
  }
  expect(calls).toEqual([]);
});

it('SDK publish reuses the once-publish coordinator and retains original body with separate runtime status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-publish-'));
  const path = join(dir, 'definitions.yaml');
  await writeFile(path, JSON.stringify({ sops: [{ id: 'sop', version: '1', content: { skill_id: 'sop', version: '1' } }] }));
  let publications = 0;
  const refreshes = [];
  const publication = { sop: { id: 'row', skill_id: 'sop', status: 'published', version: '2', content: { skill_id: 'sop', version: '2' } }, draft: { id: 'draft' } };
  const f = await fixture((req, res) => {
    publications++;
    expect(req.url).toBe('/sops/sop:publish?agent_id=target');
    expect(req.body).toEqual({ draft_id: 'draft' });
    expect(req.get('If-Match')).toBeUndefined();
    res.json(publication);
  }, { binding: { definitionsPath: path, defaultSopId: 'sop', discoveryAgentId: 'target' },
    getGateway: async () => ({ reloadExtensions: async input => { refreshes.push(input); return { reloaded: true }; } }) });
  try {
    const response = await f.call('publish_sop', { sopId: 'sop', draftId: 'draft' }, { kind: 'agent', agentId: 'target' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(publication);
    expect(JSON.parse(response.headers.get('X-StaffDeck-Runtime'))).toMatchObject({ ownerPublished: true, snapshotWritten: true, refreshRequested: true, receiptPersisted: true, effective: false });
    expect(publications).toBe(1); expect(refreshes).toEqual([{ changedPaths: [path] }]);
    expect(JSON.parse(await readFile(path, 'utf8')).sops[0].version).toBe('2');
    expect((await (await f.management()).json()).runtime.receipts).toEqual([expect.objectContaining({ sopId: 'sop', effective: false })]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('an excluded non-target publish makes no publication, bundle write or refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-publish-scope-'));
  const path = join(dir, 'definitions.yaml');
  const original = JSON.stringify({ sops: [{ id: 'sop', version: '1' }] });
  await writeFile(path, original);
  let publications = 0, refreshes = 0;
  const f = await fixture((req, res) => {
    publications++; expect(req.url).toBe('/sops/sop:publish?agent_id=other');
    res.json({ sop: { id: 'row', skill_id: 'sop', status: 'published', version: '2', content: { skill_id: 'sop', version: '2' } } });
  }, { binding: { definitionsPath: path, defaultSopId: 'sop', discoveryAgentId: 'target' }, getGateway: async () => ({ reloadExtensions: async () => { refreshes++; return { reloaded: true }; } }) });
  try {
    const response = await f.call('publish_sop', { sopId: 'sop', draftId: 'draft' }, { kind: 'agent', agentId: 'other' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'PUBLIC_FIXED_TARGET_SCOPE_MISMATCH' } });
    expect(response.headers.get('X-StaffDeck-Runtime')).toBeNull();
    expect(publications).toBe(0); expect(refreshes).toBe(0); expect(await readFile(path, 'utf8')).toBe(original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('dispatches fixed-target Knowledge contracts with original conflict and accepted-job responses', async () => {
  const calls = [];
  const catalogCalls = [];
  const f = await fixture((req, res) => {
    calls.push({ method: req.method, url: req.url, body: req.body, idempotency: req.get('Idempotency-Key') });
    if (req.body?.expected_updated_at === 'stale') return res.status(409).type('json').end('{"detail":"original conflict"}');
    if (req.url.endsWith('/entries')) return res.status(202).json({ id: 'job', status: 'queued' });
    res.json({ data: [], id: 'original' });
  }, { scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:read', 'knowledge:write', 'knowledge:publish'],
    getGateway: async () => ({ moduleHostCapabilities: { operations: ['list_model_catalog'],
      call: async (operation, input, context) => {
        catalogCalls.push({ operation, input, context });
        return { status: 200, body: { data: [{ id: 'pd/model', provider: 'pd', model: 'model', available: true, is_default: true }] } };
      } } }) });
  const scope = { kind: 'agent', agentId: 'target' };
  const root = '/agents/target/knowledge-bases';
  for (const [operation, input, method, path] of [
    ['create_knowledge_base', { body: { name: 'Base' } }, 'POST', root],
    ['update_knowledge_base', { knowledgeBaseId: 'kb/id', body: { name: 'Changed' } }, 'PATCH', root + '/kb%2Fid'],
    ['archive_knowledge_base', { knowledgeBaseId: 'kb/id' }, 'POST', root + '/kb%2Fid:archive'],
    ['search_knowledge_base', { knowledgeBaseId: 'kb/id', selectedPdModelId: 'pd/model', body: { query: 'source' } }, 'POST', root + '/kb%2Fid:search'],
    ['upsert_knowledge_entries', { knowledgeBaseId: 'kb/id', body: { entries: [{ content: 'source' }] }, idempotencyKey: 'original-key' }, 'POST', root + '/kb%2Fid/entries'],
    ['list_knowledge_versions', { knowledgeBaseId: 'kb/id' }, 'GET', root + '/kb%2Fid/versions'],
    ['rollback_knowledge_base', { knowledgeBaseId: 'kb/id', version: '1.0.0' }, 'POST', root + '/kb%2Fid:rollback'],
    ['list_knowledge_documents', { knowledgeBaseId: 'kb/id' }, 'GET', root + '/kb%2Fid/documents'],
    ['update_knowledge_document', { knowledgeBaseId: 'kb/id', documentId: 'doc/id', body: { content_md: 'draft', expected_updated_at: 'original' } }, 'PATCH', root + '/kb%2Fid/documents/doc%2Fid'],
    ['archive_knowledge_document', { knowledgeBaseId: 'kb/id', documentId: 'doc/id' }, 'POST', root + '/kb%2Fid/documents/doc%2Fid:archive'],
    ['list_knowledge_concepts', { knowledgeBaseId: 'kb/id' }, 'GET', root + '/kb%2Fid/concepts'],
  ]) {
    const response = await f.call(operation, input, scope);
    expect(response.status).toBe(operation === 'upsert_knowledge_entries' ? 202 : 200);
    if (operation === 'upsert_knowledge_entries') expect(await response.json()).toEqual({ id: 'job', status: 'queued' });
    if (operation === 'search_knowledge_base') expect(await response.json()).toMatchObject({
      host_model_selection: { id: 'pd/model', model_use: 'pilotdeck_dialogue_only', retrieval_mode: 'staffdeck_public_lexical' },
    });
    expect(calls.at(-1)).toMatchObject({ method, url: path });
    if (input.body) expect(calls.at(-1).body).toEqual(input.body);
  }
  expect(calls[4].idempotency).toBe('original-key');
  expect(catalogCalls).toHaveLength(1);
  expect(catalogCalls[0]).toMatchObject({ operation: 'list_model_catalog', input: {},
    context: { principal: { pilotDeckUserId: 'local', tenantId: 'tenant', actorUserId: 'actor', agentId: 'target' } } });
  expect(catalogCalls[0].context.signal).toBeInstanceOf(AbortSignal);
  expect(calls[6].body).toEqual({ version: '1.0.0' });
  const conflict = await f.call('update_knowledge_document', { knowledgeBaseId: 'kb/id', documentId: 'doc/id',
    body: { content_md: 'draft', expected_updated_at: 'stale' } }, scope);
  expect(conflict.status).toBe(409); expect(await conflict.text()).toBe('{"detail":"original conflict"}');
  const denied = await f.call('update_knowledge_document', { knowledgeBaseId: 'kb/id', documentId: 'doc/id', body: {} }, { kind: 'agent', agentId: 'other' });
  expect(denied.status).toBe(403);
  expect(calls).toHaveLength(12);
});

it('keeps host catalog errors and stale model selection ahead of StaffDeck search', async () => {
  let searches = 0;
  let hostStatus = 422;
  const f = await fixture((_req, res) => { searches++; res.json({ okf_citations: [] }); }, {
    scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:read'],
    getGateway: async () => ({ moduleHostCapabilities: { operations: ['list_model_catalog'],
      call: async () => hostStatus === 422
        ? { status: 422, body: { detail: 'original host error' }, rawBody: '{"detail":"original host error"}',
          headers: { 'content-type': 'application/json', 'x-request-id': 'host-request' } }
        : { status: 200, body: { data: [{ id: 'pd/current', provider: 'pd', model: 'current', available: true, is_default: true }] } },
    } }),
  });
  const scope = { kind: 'agent', agentId: 'target' };
  const input = { knowledgeBaseId: 'kb', selectedPdModelId: 'pd/current', body: { query: 'source' } };
  const upstream = await f.call('search_knowledge_base', input, scope);
  expect(upstream.status).toBe(422);
  expect(upstream.headers.get('x-request-id')).toBe('host-request');
  expect(await upstream.text()).toBe('{"detail":"original host error"}');
  hostStatus = 200;
  const stale = await f.call('search_knowledge_base', { ...input, selectedPdModelId: 'pd/old' }, scope);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'PUBLIC_PD_MODEL_SELECTION_MISMATCH' } });
  expect(searches).toBe(0);
});

it('forwards real Knowledge multipart bytes and original ingest status without JSON/APIJob substitution', async () => {
  const uploads = [];
  const parser = multer({ storage: multer.memoryStorage() }).single('file');
  const f = await fixture((req, res) => parser(req, res, error => {
    if (error) return res.status(400).json({ detail: error.message });
    uploads.push({ url: req.url, bytes: [...req.file.buffer], title: req.body.title, name: req.file.originalname });
    res.status(200).set('x-request-id', 'original-ingest').json({ id: 'native-ingest', status: 'pending', stage: 'queued' });
  }), { scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:read', 'knowledge:write'] });
  const form = () => {
    const value = new FormData();
    value.set('operation', 'upload_knowledge_document');
    value.set('knowledgeBaseId', 'kb/id');
    value.set('scope', JSON.stringify({ kind: 'agent', agentId: 'target' }));
    value.set('title', 'original title');
    value.set('file', new Blob([new Uint8Array([0, 255, 10, 13])], { type: 'application/pdf' }), 'original.pdf');
    return value;
  };
  const response = await f.file(form());
  expect(response.status).toBe(200);
  expect(response.headers.get('x-request-id')).toBe('original-ingest');
  expect(await response.json()).toEqual({ id: 'native-ingest', status: 'pending', stage: 'queued' });
  expect(uploads).toEqual([{ url: '/agents/target/knowledge-bases/kb%2Fid/documents', bytes: [0, 255, 10, 13], title: 'original title', name: 'original.pdf' }]);
  const other = form(); other.set('scope', JSON.stringify({ kind: 'team' }));
  expect((await f.file(other)).status).toBe(403);
  expect(uploads).toHaveLength(1);
  expect((await f.call('upload_knowledge_document', { knowledgeBaseId: 'kb', body: { filename: 'x', content_base64: '' } }, { kind: 'agent', agentId: 'target' })).status).toBe(409);
});

it('forwards auto-create upload once without guessing a KB and preserves capability scope', async () => {
  const uploads = [];
  const parser = multer({ storage: multer.memoryStorage() }).single('file');
  const f = await fixture((req, res) => parser(req, res, error => {
    if (error) return res.status(400).json({ detail: error.message });
    uploads.push({ url: req.url, bytes: [...req.file.buffer], fields: req.body });
    res.status(200).set('x-request-id', 'original-auto-ingest').json({ id: 'native-ingest', knowledge_base_id: 'owner-created-kb', status: 'queued' });
  }), { scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:write'] });
  const form = () => {
    const value = new FormData();
    value.set('operation', 'upload_knowledge_document_auto');
    value.set('scope', JSON.stringify({ kind: 'agent', agentId: 'target' }));
    value.set('title', 'original title');
    value.set('capability_scope', 'sop_specific');
    value.set('file', new Blob(['original text'], { type: 'text/plain' }), 'facts.txt');
    return value;
  };
  const response = await f.file(form());
  expect(response.status).toBe(200);
  expect(response.headers.get('x-request-id')).toBe('original-auto-ingest');
  expect(await response.json()).toMatchObject({ id: 'native-ingest', knowledge_base_id: 'owner-created-kb' });
  expect(uploads).toEqual([{ url: '/agents/target/knowledge/documents:auto-create',
    bytes: [...Buffer.from('original text')], fields: { title: 'original title', capability_scope: 'sop_specific' } }]);
  for (const [field, value] of [['knowledgeBaseId', 'guessed'], ['capability_scope', 'invalid']]) {
    const invalid = form(); invalid.set(field, value);
    expect((await f.file(invalid)).status).toBe(400);
  }
  expect(uploads).toHaveLength(1);
  expect((await f.call('upload_knowledge_document_auto', { body: { filename: 'facts.txt', content_base64: '' } },
    { kind: 'agent', agentId: 'target' })).status).toBe(409);
});

it('forwards OKF FormData through the same named file route with its original response', async () => {
  const uploads = [];
  const parser = multer({ storage: multer.memoryStorage() }).single('file');
  const f = await fixture((req, res) => parser(req, res, error => {
    if (error) return res.status(400).json({ detail: error.message });
    uploads.push({ url: req.url, bytes: [...req.file.buffer], name: req.file.originalname });
    res.status(200).set('x-request-id', 'okf-import').json({ imported: 2, skipped: 0 });
  }), { scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:read', 'knowledge:write'] });
  const form = new FormData();
  form.set('operation', 'import_knowledge_okf');
  form.set('knowledgeBaseId', 'kb/id');
  form.set('scope', JSON.stringify({ kind: 'agent', agentId: 'target' }));
  form.set('file', new Blob([new Uint8Array([80, 75, 3, 4])], { type: 'application/zip' }), 'backup.okf');
  const response = await f.file(form);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-request-id')).toBe('okf-import');
  expect(await response.json()).toEqual({ imported: 2, skipped: 0 });
  expect(uploads).toEqual([{ url: '/agents/target/knowledge-bases/kb%2Fid/okf:import', bytes: [80, 75, 3, 4], name: 'backup.okf' }]);
});

it('dispatches deep Knowledge IDs and raw export/domain-job envelopes without APIJob conversion', async () => {
  const calls = [];
  const f = await fixture((req, res) => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    if (req.url.endsWith('/okf/export')) return res.json({ content_base64: 'UEs=', media_type: 'application/zip', filename: 'original.zip' });
    if (req.url.endsWith('/knowledge-jobs/job%2Fid')) return res.json({ id: 'job/id', stage: 'parse', status: 'processing', source_document_id: 'doc/id' });
    return res.json({ data: [], id: 'original' });
  }, { scopes: ['sops:read', 'sops:write', 'sops:publish', 'knowledge:read', 'knowledge:write'] });
  const scope = { kind: 'agent', agentId: 'target' };
  for (const [operation, input, method, path] of [
    ['get_knowledge_document', { knowledgeBaseId: 'kb/id', documentId: 'doc/id' }, 'GET', '/agents/target/knowledge-bases/kb%2Fid/documents/doc%2Fid'],
    ['list_document_buckets', { documentId: 'doc/id' }, 'GET', '/agents/target/knowledge-documents/doc%2Fid/buckets'],
    ['list_bucket_chunks', { bucketId: 'bucket/id' }, 'GET', '/agents/target/knowledge-buckets/bucket%2Fid/chunks'],
    ['update_knowledge_bucket', { bucketId: 'bucket/id', body: { title: 'original' } }, 'PUT', '/agents/target/knowledge-buckets/bucket%2Fid'],
    ['update_knowledge_chunk', { chunkId: 'chunk/id', body: { content_md: 'source' } }, 'PUT', '/agents/target/knowledge-chunks/chunk%2Fid'],
    ['get_knowledge_concept', { knowledgeBaseId: 'kb/id', conceptId: 'a/b' }, 'GET', '/agents/target/knowledge-bases/kb%2Fid/concepts/a%2Fb'],
    ['update_knowledge_concept', { knowledgeBaseId: 'kb/id', conceptId: 'a/b', body: { content_md: 'graph edit' } }, 'PUT', '/agents/target/knowledge-bases/kb%2Fid/concepts/a%2Fb'],
    ['list_knowledge_jobs', { status: 'running', limit: 12 }, 'GET', '/agents/target/knowledge-jobs?status=running&limit=12'],
    ['cancel_knowledge_job', { jobId: 'job/id' }, 'POST', '/agents/target/knowledge-jobs/job%2Fid:cancel'],
    ['list_knowledge_discoveries', { knowledgeBaseId: 'kb/id', status: 'pending' }, 'GET', '/agents/target/knowledge-discoveries?knowledge_base_id=kb%2Fid&status=pending'],
    ['confirm_knowledge_discovery', { suggestionId: 'suggestion/id' }, 'POST', '/agents/target/knowledge-discoveries/suggestion%2Fid:confirm'],
    ['reject_knowledge_discovery', { suggestionId: 'suggestion/id' }, 'POST', '/agents/target/knowledge-discoveries/suggestion%2Fid:reject'],
  ]) {
    const response = await f.call(operation, input, scope);
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method, url: path });
    if (input.body) expect(calls.at(-1).body).toEqual(input.body);
  }
  expect(await (await f.call('export_knowledge_okf', { knowledgeBaseId: 'kb/id' }, scope)).json()).toEqual({ content_base64: 'UEs=', media_type: 'application/zip', filename: 'original.zip' });
  expect(await (await f.call('get_knowledge_job', { jobId: 'job/id' }, scope)).json()).toEqual({ id: 'job/id', stage: 'parse', status: 'processing', source_document_id: 'doc/id' });
  const beforeInvalidLimit = calls.length;
  expect((await f.call('list_knowledge_jobs', { limit: 0 }, scope)).status).toBe(400);
  expect((await f.call('list_knowledge_jobs', { limit: 51 }, scope)).status).toBe(400);
  expect(calls).toHaveLength(beforeInvalidLimit);
});
