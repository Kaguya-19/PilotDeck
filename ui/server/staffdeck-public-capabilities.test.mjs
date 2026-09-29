import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicCapabilityClient, planPublicOperation, decodePublicJobEvents, decodePreviewJobEvents, PUBLIC_PROTOCOL_BLOCKERS, PUBLIC_APPROVED_OPERATIONS, PUBLIC_OPERATION_CONTRACTS } from './staffdeck-public-capabilities.mjs';

const code = expected => cause => cause.code === expected;

test('unapproved operations never reach transport; unknown/inequivalent operations have no route', async () => {
  let calls = 0;
  const client = createPublicCapabilityClient({ agentId: 'a', transport: () => { calls++; } });
  await assert.rejects(client.call('list_tools'), code('PUBLIC_OPERATION_NOT_AUTHORIZED'));
  for (const operation of Object.keys(PUBLIC_PROTOCOL_BLOCKERS)) assert.throws(() => planPublicOperation('a', operation), code('PUBLIC_PROTOCOL_UNAVAILABLE'));
  assert.equal(calls, 0);
});

test('directories preserve data envelopes and encoded scope; malformed response is not empty success', async () => {
  const response = { status: 200, body: { data: [{ id: 'tool', auth: { token: '********' } }], next_cursor: null } };
  let request;
  const client = createPublicCapabilityClient({ agentId: 'a/b', authorizedOperations: ['list_tools'], transport: async value => { request = value; return response; } });
  assert.equal(await client.call('list_tools', {}, { scope: { kind: 'agent', agentId: 'a/b' } }), response);
  assert.equal(request.path, 'agents/a%2Fb/tools');
  response.body = {};
  await assert.rejects(client.call('list_tools', {}, { scope: { kind: 'agent', agentId: 'a/b' } }), code('PUBLIC_RESPONSE_INVALID'));
});

test('tool write rejects masked credentials and scope override without modifying input', () => {
  const body = { name: 'x', connection: { headers: { key: '********' } } };
  assert.throws(() => planPublicOperation('a', 'update_tool', { toolId: 'x', body }), code('PUBLIC_MASKED_CREDENTIAL'));
  assert.equal(body.connection.headers.key, '********');
  assert.throws(() => planPublicOperation('a', 'import_general_skill', { body: { tenant_id: 'other' } }), code('PUBLIC_SCOPE_OVERRIDE'));
  assert.throws(() => planPublicOperation('a', 'test_tool', { body: {} }), code('PUBLIC_INPUT_INVALID'));
});

test('rewrite refuses dirty/current skill/conversation rather than discard them or save', async () => {
  let calls = 0;
  const client = createPublicCapabilityClient({ agentId: 'a', authorizedOperations: ['rewrite_saved_sop'], transport: () => { calls++; } });
  for (const input of [
    { dirty: true }, { current_skill: { version: '1' } }, { conversation: [] },
    { body: { instruction: 'change', current_skill: {} } },
  ]) {
    await assert.rejects(client.call('rewrite_saved_sop', { sopId: 's', body: { instruction: 'change' }, ...input }, { scope: { kind: 'agent', agentId: 'a' } }), code('PUBLIC_PREVIEW_REQUIRED'));
  }
  assert.equal(calls, 0);
});

test('generation and results preserve server-assigned draft/etag; never create a second draft', async () => {
  const requests = [];
  const accepted = { status: 202, body: { id: 'job', status: 'queued' } };
  const result = { status: 200, body: { job: { id: 'job', status: 'succeeded' }, result: { draft: { id: 'd', content: { nodes: [{ extra: true }] }, etag: 'original', version: '1.0.1' } }, error: {} } };
  const client = createPublicCapabilityClient({ agentId: 'a', authorizedOperations: ['generate_sop', 'get_job_result'], transport: async request => { requests.push(request); return requests.length === 1 ? accepted : result; } });
  assert.equal(await client.call('generate_sop', { body: { title: 'title', raw_content: 'source' } }, { scope: { kind: 'agent', agentId: 'a' } }), accepted);
  assert.equal(await client.call('get_job_result', { jobId: 'job' }), result);
  assert.deepEqual(requests.map(value => value.path), ['agents/a/sops:generate', 'jobs/job/result']);
});

test('original HTTP failures, abort signal and resume cursor are preserved', async () => {
  const failure = { status: 403, body: { error: { code: 'INSUFFICIENT_SCOPE', message: 'denied' } } };
  const controller = new AbortController();
  let request;
  const client = createPublicCapabilityClient({ agentId: 'a', authorizedOperations: ['job_events'], transport: async value => { request = value; return failure; } });
  assert.equal(await client.call('job_events', { jobId: 'j/x', lastEventId: '19' }, { signal: controller.signal }), failure);
  assert.equal(request.headers['Last-Event-ID'], '19');
  assert.equal(request.path, 'jobs/j%2Fx/events');
  assert.equal(request.signal, controller.signal);
  controller.abort();
  await assert.rejects(client.call('job_events', { jobId: 'j' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('SSE preserves real IDs, event names, multiline data and split UTF-8; drops incomplete frame', async () => {
  const wire = new TextEncoder().encode(': keepalive\r\nid: 7\r\nevent: sop.generate.learning\r\ndata: {"text":"中文"}\r\ndata: second\r\n\r\nid: 8\nevent: job.succeeded\ndata: {}\n\ndata: incomplete');
  async function* chunks() { for (const byte of wire) yield Uint8Array.of(byte); }
  const events = [];
  for await (const event of decodePublicJobEvents(chunks())) events.push(event);
  assert.deepEqual(events, [
    { id: '7', event: 'sop.generate.learning', data: '{"text":"中文"}\nsecond' },
    { id: '8', event: 'job.succeeded', data: '{}' },
  ]);
});

test('approved facade plans remain fixed by name, method, path and input', () => {
  const cases = [
    ['preview_generate_sop', { body: { title: 't', raw_content: 'r' } }, 'POST', 'agents/a/sops:preview-generate'],
    ['preview_rewrite_sop', { sopId: 's/x', body: { current_skill: { skill_id: 's/x' }, instruction: 'change', conversation: [{ role: 'user', content: 'current' }] } }, 'POST', 'agents/a/sops/s%2Fx:preview-rewrite'],
    ['get_preview_job', { jobId: 'j' }, 'GET', 'agents/a/sop-preview-jobs/j'],
    ['preview_job_events', { jobId: 'j', afterSeq: 4 }, 'GET', 'agents/a/sop-preview-jobs/j/events?after_seq=4'],
    ['cancel_preview_job', { jobId: 'j' }, 'POST', 'agents/a/sop-preview-jobs/j:cancel'],
    ['move_to_draft_sop', { sopId: 's' }, 'POST', 'agents/a/sops/s:move-to-draft'],
    ['remove_sop', { sopId: 's' }, 'DELETE', 'agents/a/sops/s'],
    ['sync_sop_from_overall', { sopId: 's' }, 'POST', 'agents/a/sops/s:sync-from-overall'],
    ['promote_sop_to_overall', { sopId: 's' }, 'POST', 'agents/a/sops/s:promote-to-overall'],
    ['delete_sop_version', { sopId: 's', version: '1.0.0' }, 'DELETE', 'agents/a/sops/s/versions/1.0.0'],
    ['probe_unsaved_tool', { body: { name: 't', url: 'https://example.test' } }, 'POST', 'agents/a/tools:probe'],
    ['remove_tool', { toolId: 't' }, 'DELETE', 'agents/a/tools/t'],
    ['extract_sop_text', { body: { filename: 'a.txt', content_base64: 'YQ==' } }, 'POST', 'agents/a/sops:extract-file'],
    ['list_model_catalog', {}, 'GET', 'agents/a/model-catalog'],
    ['list_handoff_users', {}, 'GET', 'agents/a/handoff-users'],
    ['cancel_job', { jobId: 'j' }, 'POST', 'jobs/j:cancel'],
  ];
  for (const [operation, input, method, path] of cases) {
    const planned = planPublicOperation('a', operation, input);
    assert.equal(planned.method, method, operation);
    assert.equal(planned.path, path, operation);
  }
  assert.equal(PUBLIC_APPROVED_OPERATIONS.length, 68);
  for (const operation of PUBLIC_APPROVED_OPERATIONS) {
    assert.equal(typeof PUBLIC_OPERATION_CONTRACTS[operation][2], 'string');
  }
});

test('preview keeps dirty current skill and conversation, while saved rewrite still rejects them', async () => {
  let request;
  const client = createPublicCapabilityClient({ agentId: 'a', authorizedOperations: ['preview_rewrite_sop', 'rewrite_saved_sop'], transport: async value => { request = value; return { status: 202, body: { job_id: 'preview' } }; } });
  const current_skill = { skill_id: 's', version: '1', nodes: [{ id: 'dirty' }] };
  const conversation = [{ role: 'user', content: 'keep this' }];
  const input = { sopId: 's', body: { current_skill, instruction: 'rewrite', conversation } };
  assert.deepEqual((await client.call('preview_rewrite_sop', input, { scope: { kind: 'agent', agentId: 'a' } })).body, { job_id: 'preview' });
  assert.deepEqual(request.body.current_skill, current_skill);
  assert.deepEqual(request.body.conversation, conversation);
  await assert.rejects(client.call('rewrite_saved_sop', input, { scope: { kind: 'agent', agentId: 'a' } }), code('PUBLIC_PREVIEW_REQUIRED'));
});

test('preview SSE exposes only the native data.seq cursor and preserves token event text', async () => {
  async function* chunks() {
    yield 'event: message_chunk\ndata: {"job_id":"j","seq":12,"text":"part"}\n\n';
    yield 'event: job_complete\ndata: {"job_id":"j","status":"succeeded"}\n\n';
  }
  const events = [];
  for await (const event of decodePreviewJobEvents(chunks())) events.push(event);
  assert.deepEqual(events, [
    { event: 'message_chunk', data: '{"job_id":"j","seq":12,"text":"part"}', sequence: 12 },
    { event: 'job_complete', data: '{"job_id":"j","status":"succeeded"}' },
  ]);
  assert.equal(events[0].id, undefined);
});

test('selected agent never falls back to configured target; team uses bounded routes', async () => {
  const paths = [];
  const client = createPublicCapabilityClient({
    agentId: 'configured-target',
    authorizedOperations: ['list_tools', 'list_general_skills', 'list_knowledge_bases', 'list_sops', 'preview_rewrite_sop', 'remove_sop'],
    transport: async plan => { paths.push(plan.path); return { status: 200, body: { data: [], drafts: [] } }; },
  });
  await assert.rejects(client.call('list_tools'), code('PUBLIC_SELECTED_SCOPE_REQUIRED'));
  await client.call('list_tools', {}, { scope: { kind: 'agent', agentId: 'selected' } });
  await client.call('list_general_skills', {}, { scope: { kind: 'team' } });
  await client.call('list_knowledge_bases', {}, { scope: { kind: 'team' } });
  await client.call('list_sops', {}, { scope: { kind: 'team' } });
  assert.deepEqual(paths, ['agents/selected/tools', 'team/general-skills', 'team/knowledge-bases', 'team/sops']);
  assert.equal(planPublicOperation(null, 'preview_rewrite_sop', {
    sopId: 's', body: { current_skill: { skill_id: 's' }, instruction: 'dirty', conversation: [{ role: 'user', content: 'latest' }] },
  }).path, 'team/sops/s:preview-rewrite');
  await assert.rejects(client.call('remove_sop', { sopId: 's' }, { scope: { kind: 'team' } }), code('PUBLIC_TEAM_PROTOCOL_UNAVAILABLE'));
  assert.equal(planPublicOperation(undefined, 'get_job', { jobId: 'j' }).path, 'jobs/j');
});

test('selected SOP lifecycle preserves exact IDs, ETag precondition and original response', async () => {
  const scope = { kind: 'agent', agentId: 'selected/employee' };
  const content = { skill_id: 's/op', version: '1.0.2', nodes: [{ node_id: 'dirty' }] };
  const draft = { id: 'd/1', agent_id: 'selected/employee', sop_id: 's/op', content, etag: '"original"', status: 'draft' };
  const paths = [];
  const client = createPublicCapabilityClient({
    agentId: 'configured-target',
    authorizedOperations: ['get_sop_draft', 'list_sop_versions', 'get_sop_version', 'create_sop_draft', 'replace_sop_draft', 'publish_sop', 'archive_sop', 'rollback_sop_version'],
    transport: async plan => { paths.push(plan); return { status: plan.shape === 'created-draft' ? 201 : 200, body: draft, headers: { ETag: '"original"' } }; },
  });
  assert.deepEqual((await client.call('get_sop_draft', { sopId: 's/op', draftId: 'd/1' }, { scope })).body, draft);
  assert.equal(paths[0].path, 'agents/selected%2Femployee/sops/s%2Fop/drafts/d%2F1');
  await assert.rejects(client.call('replace_sop_draft', { sopId: 's/op', draftId: 'd/1', etag: '', body: { content } }, { scope }), code('IF_MATCH_REQUIRED'));
  assert.equal(paths.length, 1);
  assert.deepEqual((await client.call('replace_sop_draft', { sopId: 's/op', draftId: 'd/1', etag: '"original"', body: { content } }, { scope })).headers, { ETag: '"original"' });
  assert.equal(paths[1].headers['If-Match'], '"original"');
  assert.equal(paths[1].path, 'agents/selected%2Femployee/sops/s%2Fop?draft_id=d%2F1');
  assert.deepEqual(paths[1].body, { content });
  await client.call('publish_sop', { sopId: 's/op', draftId: 'd/1' }, { scope });
  assert.equal(paths[2].path, 'sops/s%2Fop:publish?agent_id=selected%2Femployee');
  assert.deepEqual(paths[2].body, { draft_id: 'd/1' });
  assert.equal(planPublicOperation(null, 'list_sop_versions', { sopId: 's/op' }).path, 'team/sops/s%2Fop/versions');
  assert.equal(planPublicOperation(null, 'get_sop_version', { sopId: 's/op', version: '1.0.1' }).path, 'team/sops/s%2Fop/versions/1.0.1');
  await assert.rejects(client.call('create_sop_draft', { body: { content } }, { scope: { kind: 'team' } }), code('PUBLIC_TEAM_PROTOCOL_UNAVAILABLE'));
});

test('fixed candidate target accepts original draft ETag and rejects explicit other scope before transport', async () => {
  const plans = [];
  const draft = { id: 'd1', sop_id: 's1', agent_id: 'configured-target', status: 'draft', etag: '"old"', content: { skill_id: 's1' } };
  const client = createPublicCapabilityClient({
    agentId: 'configured-target', fixedTargetAgentId: 'configured-target',
    authorizedOperations: ['get_sop_draft', 'replace_sop_draft'],
    transport: async plan => { plans.push(plan); return { status: 200, body: draft, headers: { ETag: '"old"' } }; },
  });
  await assert.rejects(client.call('get_sop_draft', { sopId: 's1', draftId: 'd1' }, { scope: { kind: 'agent', agentId: 'other' } }), code('PUBLIC_FIXED_TARGET_SCOPE_MISMATCH'));
  await assert.rejects(client.call('get_sop_draft', { sopId: 's1', draftId: 'd1' }, { scope: { kind: 'team' } }), code('PUBLIC_FIXED_TARGET_SCOPE_MISMATCH'));
  assert.equal(plans.length, 0);
  await client.call('get_sop_draft', { sopId: 's1', draftId: 'd1' }, { scope: { kind: 'agent', agentId: 'configured-target' } });
  await client.call('replace_sop_draft', { sopId: 's1', draftId: 'd1', etag: draft.etag, body: { content: draft.content } }, { scope: { kind: 'agent', agentId: 'configured-target' } });
  assert.equal(plans[1].headers['If-Match'], '"old"');
  assert.deepEqual(plans[1].body, { content: draft.content });
});

test('fixed Knowledge routes retain base and document IDs, conflict timestamp and ingest idempotency', () => {
  const target = 'target/1';
  const cases = [
    ['create_knowledge_base', { body: { name: 'Base' } }, 'POST', 'agents/target%2F1/knowledge-bases'],
    ['update_knowledge_base', { knowledgeBaseId: 'kb/1', body: { name: 'New' } }, 'PATCH', 'agents/target%2F1/knowledge-bases/kb%2F1'],
    ['archive_knowledge_base', { knowledgeBaseId: 'kb/1' }, 'POST', 'agents/target%2F1/knowledge-bases/kb%2F1:archive'],
    ['search_knowledge_base', { knowledgeBaseId: 'kb/1', body: { query: 'policy' } }, 'POST', 'agents/target%2F1/knowledge-bases/kb%2F1:search'],
    ['list_knowledge_versions', { knowledgeBaseId: 'kb/1' }, 'GET', 'agents/target%2F1/knowledge-bases/kb%2F1/versions'],
    ['rollback_knowledge_base', { knowledgeBaseId: 'kb/1', version: '1.0.0' }, 'POST', 'agents/target%2F1/knowledge-bases/kb%2F1:rollback'],
    ['list_knowledge_documents', { knowledgeBaseId: 'kb/1' }, 'GET', 'agents/target%2F1/knowledge-bases/kb%2F1/documents'],
    ['archive_knowledge_document', { knowledgeBaseId: 'kb/1', documentId: 'doc/1' }, 'POST', 'agents/target%2F1/knowledge-bases/kb%2F1/documents/doc%2F1:archive'],
    ['list_knowledge_concepts', { knowledgeBaseId: 'kb/1' }, 'GET', 'agents/target%2F1/knowledge-bases/kb%2F1/concepts'],
  ];
  for (const [op, input, method, path] of cases) {
    const plan = planPublicOperation(target, op, input);
    assert.equal(plan.method, method, op);
    assert.equal(plan.path, path, op);
  }
  const changed = planPublicOperation(target, 'update_knowledge_document', {
    knowledgeBaseId: 'kb/1', documentId: 'doc/1', body: { content_md: 'draft', expected_updated_at: 'original' },
  });
  assert.equal(changed.method, 'PATCH');
  assert.equal(changed.path, 'agents/target%2F1/knowledge-bases/kb%2F1/documents/doc%2F1');
  assert.equal(changed.body.expected_updated_at, 'original');
  const ingest = planPublicOperation(target, 'upsert_knowledge_entries', {
    knowledgeBaseId: 'kb/1', body: { entries: [{ external_id: 'x', content: 'source' }] }, idempotencyKey: 'source-v1',
  });
  assert.equal(ingest.headers['Idempotency-Key'], 'source-v1');
  assert.equal(ingest.shape, 'accepted-job');
  const multipart = planPublicOperation(target, 'upload_knowledge_document', {
    knowledgeBaseId: 'kb/1', body: { filename: 'source.md', content_base64: 'YQ==', title: 'Source' },
  });
  assert.equal(multipart.shape, 'knowledge-ingest-job');
  const auto = planPublicOperation(target, 'upload_knowledge_document_auto', {
    body: { filename: 'source.md', content_base64: 'YQ==', title: 'Source', capability_scope: 'general' },
  });
  assert.equal(auto.path, 'agents/target%2F1/knowledge/documents:auto-create');
  assert.equal(auto.shape, 'knowledge-ingest-job');
  assert.equal(auto.body.capability_scope, 'general');
  assert.throws(() => planPublicOperation(target, 'upload_knowledge_document_auto', {
    knowledgeBaseId: 'not-allowed', body: { filename: 'source.md' },
  }), code('PUBLIC_INPUT_INVALID'));

  const jobs = planPublicOperation(target, 'list_knowledge_jobs', { status: 'running', limit: 12 });
  assert.equal(jobs.path, 'agents/target%2F1/knowledge-jobs?status=running&limit=12');
  const discoveries = planPublicOperation(target, 'list_knowledge_discoveries', { knowledgeBaseId: 'kb/1', status: 'pending' });
  assert.equal(discoveries.path, 'agents/target%2F1/knowledge-discoveries?knowledge_base_id=kb%2F1&status=pending');
  assert.throws(() => planPublicOperation(null, 'update_knowledge_document', { knowledgeBaseId: 'kb', documentId: 'd', body: {} }), code('PUBLIC_TEAM_PROTOCOL_UNAVAILABLE'));
});
