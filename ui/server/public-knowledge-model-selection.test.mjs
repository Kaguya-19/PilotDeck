import assert from 'node:assert/strict';
import test from 'node:test';
import { bindBrowserKnowledgeSearchModel } from './public-knowledge-model-selection.mjs';
import { createPublicCapabilityClient, planPublicOperation } from './staffdeck-public-capabilities.mjs';

const catalog = { defaultSelection: { mode: 'model', provider: 'pd', model: 'selected' },
  data: [{ id: 'pd/selected', provider: 'pd', model: 'selected', available: true, enabled: true, is_default: true },
    { id: 'pd/other', provider: 'pd', model: 'other', available: true, enabled: true }] };
const input = { knowledgeBaseId: 'kb', selectedPdModelId: 'pd/selected', body: { query: 'fact', mode: 'debug', max_depth: 3 } };
const code = expected => error => error.code === expected;

test('browser search verifies the selected PD model and keeps SD lexical retrieval distinct', async () => {
  const requests = [];
  let catalogReads = 0;
  const client = createPublicCapabilityClient({ agentId: 'target', fixedTargetAgentId: 'target',
    authorizedOperations: ['search_knowledge_base'],
    hostModelCatalog: async () => { catalogReads++; return catalog; },
    transport: async plan => { requests.push(plan); return { status: 200, body: { chunks: [{ id: 'source' }], okf_citations: [{ chunk_id: 'source' }] } }; } });
  const response = await client.call('search_knowledge_base', input, { scope: { kind: 'agent', agentId: 'target' } });
  assert.equal(catalogReads, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, input.body);
  assert.equal(requests[0].path, 'agents/target/knowledge-bases/kb:search');
  assert.deepEqual(response.body.okf_citations, [{ chunk_id: 'source' }]);
  assert.deepEqual(response.body.host_model_selection, { id: 'pd/selected', model_use: 'pilotdeck_dialogue_only', retrieval_mode: 'staffdeck_public_lexical' });
  assert.equal(input.selectedPdModelId, 'pd/selected');
});

test('missing, mismatched, unavailable and SD model IDs fail before a Knowledge request', async () => {
  let requests = 0;
  const client = createPublicCapabilityClient({ agentId: 'target', fixedTargetAgentId: 'target',
    authorizedOperations: ['search_knowledge_base'], hostModelCatalog: async () => catalog,
    transport: async () => { requests++; return { status: 200, body: {} }; } });
  const scope = { scope: { kind: 'agent', agentId: 'target' } };
  await assert.rejects(client.call('search_knowledge_base', { ...input, selectedPdModelId: '' }, scope), code('PUBLIC_PD_MODEL_SELECTION_REQUIRED'));
  await assert.rejects(client.call('search_knowledge_base', { ...input, selectedPdModelId: 'pd/other' }, scope), code('PUBLIC_PD_MODEL_SELECTION_MISMATCH'));
  await assert.rejects(client.call('search_knowledge_base', { ...input, body: { query: 'fact', model_config_id: 'sd-id' } }, scope), code('PUBLIC_SD_MODEL_SELECTION_FORBIDDEN'));
  assert.equal(requests, 0);
  assert.throws(() => bindBrowserKnowledgeSearchModel(input, { ...catalog, data: [{ ...catalog.data[0], available: false }] }), code('PUBLIC_PD_MODEL_UNAVAILABLE'));
  assert.throws(() => bindBrowserKnowledgeSearchModel(input, { data: [] }), code('PUBLIC_PD_MODEL_CATALOG_INVALID'));
  const unmounted = createPublicCapabilityClient({ agentId: 'target', fixedTargetAgentId: 'target',
    authorizedOperations: ['search_knowledge_base'], transport: async () => { requests++; return { status: 200, body: {} }; } });
  await assert.rejects(unmounted.call('search_knowledge_base', input, scope), code('PUBLIC_PD_MODEL_CATALOG_UNAVAILABLE'));
  assert.throws(() => planPublicOperation('target', 'search_knowledge_base', input), code('PUBLIC_PD_MODEL_VALIDATION_REQUIRED'));
  assert.equal(requests, 0);
});
