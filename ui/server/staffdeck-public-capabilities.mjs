/** Public protocol helpers only. The host owns authentication, PEP and operation authorization. */
import { bindBrowserKnowledgeSearchModel } from './public-knowledge-model-selection.mjs';
export class PublicCapabilityError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'PublicCapabilityError';
    this.code = code;
    this.status = status;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status) => { throw new PublicCapabilityError(code, message, status); };
const id = value => {
  if (typeof value !== 'string' || !value.trim()) fail('PUBLIC_INPUT_INVALID', 'A non-empty resource ID is required.', 400);
  return encodeURIComponent(value);
};
const own = (value, key) => Object.hasOwn(value, key);

/** Fixed, named grant surface. SD still enforces the scope and original PEP. */
export const PUBLIC_OPERATION_CONTRACTS = Object.freeze({
  list_tools: ['GET', 'agents/{agent}/tools', 'tools:read', 'data[]'],
  list_general_skills: ['GET', 'agents/{agent}/general-skills', 'skills:read', 'data[]'],
  list_knowledge_bases: ['GET', 'agents/{agent}/knowledge-bases', 'knowledge:read', 'data[]'],
  create_knowledge_base: ['POST', 'agents/{agent}/knowledge-bases', 'knowledge:write', 'base'],
  update_knowledge_base: ['PATCH', 'agents/{agent}/knowledge-bases/{base}', 'knowledge:write', 'base'],
  archive_knowledge_base: ['POST', 'agents/{agent}/knowledge-bases/{base}:archive', 'knowledge:write', 'base'],
  search_knowledge_base: ['POST', 'agents/{agent}/knowledge-bases/{base}:search', 'knowledge:read', 'search-result'],
  upsert_knowledge_entries: ['POST', 'agents/{agent}/knowledge-bases/{base}/entries', 'knowledge:write', '202 APIJob'],
  list_knowledge_versions: ['GET', 'agents/{agent}/knowledge-bases/{base}/versions', 'knowledge:read', 'data[]'],
  rollback_knowledge_base: ['POST', 'agents/{agent}/knowledge-bases/{base}:rollback', 'knowledge:publish', 'rollback-result'],
  list_knowledge_documents: ['GET', 'agents/{agent}/knowledge-bases/{base}/documents', 'knowledge:read', 'data[]'],
  update_knowledge_document: ['PATCH', 'agents/{agent}/knowledge-bases/{base}/documents/{document}', 'knowledge:write', 'document'],
  archive_knowledge_document: ['POST', 'agents/{agent}/knowledge-bases/{base}/documents/{document}:archive', 'knowledge:write', 'document'],
  list_knowledge_concepts: ['GET', 'agents/{agent}/knowledge-bases/{base}/concepts', 'knowledge:read', 'data[]'],
  get_knowledge_document: ['GET', 'agents/{agent}/knowledge-bases/{base}/documents/{document}', 'knowledge:read', 'document'],
  upload_knowledge_document: ['POST', 'agents/{agent}/knowledge-bases/{base}/documents', 'knowledge:write', '200 KnowledgeIngestJobRead'],
  upload_knowledge_document_auto: ['POST', 'agents/{agent}/knowledge/documents:auto-create', 'knowledge:write', '200 KnowledgeIngestJobRead'],
  import_knowledge_okf: ['POST', 'agents/{agent}/knowledge-bases/{base}/okf:import', 'knowledge:write', 'import result'],
  list_document_buckets: ['GET', 'agents/{agent}/knowledge-documents/{document}/buckets', 'knowledge:read', 'data[]'],
  list_bucket_chunks: ['GET', 'agents/{agent}/knowledge-buckets/{bucket}/chunks', 'knowledge:read', 'data[]'],
  update_knowledge_bucket: ['PUT', 'agents/{agent}/knowledge-buckets/{bucket}', 'knowledge:write', 'bucket'],
  update_knowledge_chunk: ['PUT', 'agents/{agent}/knowledge-chunks/{chunk}', 'knowledge:write', 'chunk'],
  get_knowledge_concept: ['GET', 'agents/{agent}/knowledge-bases/{base}/concepts/{concept}', 'knowledge:read', 'concept'],
  update_knowledge_concept: ['PUT', 'agents/{agent}/knowledge-bases/{base}/concepts/{concept}', 'knowledge:write', 'concept'],
  export_knowledge_okf: ['GET', 'agents/{agent}/knowledge-bases/{base}/okf/export', 'knowledge:read', 'base64 zip'],
  list_knowledge_jobs: ['GET', 'agents/{agent}/knowledge-jobs', 'knowledge:read', 'data[]'],
  get_knowledge_job: ['GET', 'agents/{agent}/knowledge-jobs/{job}', 'knowledge:read', 'ingest job'],
  cancel_knowledge_job: ['POST', 'agents/{agent}/knowledge-jobs/{job}:cancel', 'knowledge:write', 'ingest job'],
  list_knowledge_discoveries: ['GET', 'agents/{agent}/knowledge-discoveries', 'knowledge:read', 'data[]'],
  confirm_knowledge_discovery: ['POST', 'agents/{agent}/knowledge-discoveries/{suggestion}:confirm', 'knowledge:write', 'discovery'],
  reject_knowledge_discovery: ['POST', 'agents/{agent}/knowledge-discoveries/{suggestion}:reject', 'knowledge:write', 'discovery'],
  list_sops: ['GET', 'agents/{agent}/sops', 'sops:read', 'data[]/drafts[]'],
  get_sop_draft: ['GET', 'agents/{agent}/sops/{sop}/drafts/{draft}', 'sops:read', 'draft/ETag'],
  list_sop_versions: ['GET', 'sops/{sop}/versions?agent_id={agent}', 'sops:read', 'data[]'],
  get_sop_version: ['GET', 'sops/{sop}/versions/{version}?agent_id={agent}', 'sops:read', 'version'],
  create_sop_draft: ['POST', 'agents/{agent}/sops', 'sops:write', '201 draft/ETag'],
  replace_sop_draft: ['PUT', 'agents/{agent}/sops/{sop}?draft_id={draft}', 'sops:write', 'draft/ETag/If-Match'],
  publish_sop: ['POST', 'sops/{sop}:publish?agent_id={agent}', 'sops:publish', 'sop/draft'],
  archive_sop: ['POST', 'sops/{sop}:archive?agent_id={agent}', 'sops:publish', 'archived SOP'],
  rollback_sop_version: ['POST', 'sops/{sop}/versions/{version}:rollback?agent_id={agent}', 'sops:write', '201 draft'],
  create_tool: ['POST', 'agents/{agent}/tools', 'tools:write', 'tool'],
  update_tool: ['PUT', 'agents/{agent}/tools/{tool}', 'tools:write', 'tool'],
  test_tool: ['POST', 'agents/{agent}/tools/{tool}:test', 'tools:test', 'test-result'],
  import_general_skill: ['POST', 'agents/{agent}/general-skills', 'skills:write', 'general-skill'],
  publish_general_skill: ['POST', 'agents/{agent}/general-skills/{slug}:publish', 'skills:write', 'general-skill'],
  archive_general_skill: ['POST', 'agents/{agent}/general-skills/{slug}:archive', 'skills:write', 'general-skill'],
  test_general_skill: ['POST', 'agents/{agent}/general-skills/{slug}:test', 'skills:test', 'test-result'],
  generate_sop: ['POST', 'agents/{agent}/sops:generate', 'sops:write', '202 APIJob'],
  rewrite_saved_sop: ['POST', 'agents/{agent}/sops/{sop}:rewrite', 'sops:write', '202 APIJob'],
  get_job: ['GET', 'jobs/{job}', 'sops:read', 'APIJob by kind'],
  get_job_result: ['GET', 'jobs/{job}/result', 'sops:read', 'job/result/error'],
  job_events: ['GET', 'jobs/{job}/events', 'sops:read', 'SSE id/event/data'],
  cancel_job: ['POST', 'jobs/{job}:cancel', 'sops:cancel', 'APIJob'],
  preview_generate_sop: ['POST', 'agents/{agent}/sops:preview-generate', 'sops:write', '202 {job_id}'],
  preview_rewrite_sop: ['POST', 'agents/{agent}/sops/{sop}:preview-rewrite', 'sops:write', '202 {job_id}'],
  get_preview_job: ['GET', 'agents/{agent}/sop-preview-jobs/{job}', 'sops:read', 'transient job'],
  preview_job_events: ['GET', 'agents/{agent}/sop-preview-jobs/{job}/events', 'sops:read', 'SSE event/data.seq'],
  cancel_preview_job: ['POST', 'agents/{agent}/sop-preview-jobs/{job}:cancel', 'sops:cancel', 'cancel_requested'],
  move_to_draft_sop: ['POST', 'agents/{agent}/sops/{sop}:move-to-draft', 'sops:write', 'SkillRead'],
  remove_sop: ['DELETE', 'agents/{agent}/sops/{sop}', 'sops:write', 'hidden/deleted'],
  sync_sop_from_overall: ['POST', 'agents/{agent}/sops/{sop}:sync-from-overall', 'sops:write', 'branch head'],
  promote_sop_to_overall: ['POST', 'agents/{agent}/sops/{sop}:promote-to-overall', 'sops:publish', 'promoted version'],
  delete_sop_version: ['DELETE', 'agents/{agent}/sops/{sop}/versions/{version}', 'sops:publish', 'deleted'],
  probe_unsaved_tool: ['POST', 'agents/{agent}/tools:probe', 'tools:test', 'probe-result'],
  remove_tool: ['DELETE', 'agents/{agent}/tools/{tool}', 'tools:write', 'hidden/deleted'],
  extract_sop_text: ['POST', 'agents/{agent}/sops:extract-file', 'sops:write', 'filename/text'],
  list_model_catalog: ['GET', 'agents/{agent}/model-catalog', 'sops:read', 'data[] metadata'],
  list_handoff_users: ['GET', 'agents/{agent}/handoff-users', 'agents:read', 'data[] users'],
});
export const PUBLIC_APPROVED_OPERATIONS = Object.freeze(Object.keys(PUBLIC_OPERATION_CONTRACTS));
const GLOBAL_JOB_OPERATIONS = new Set(['get_job', 'get_job_result', 'job_events', 'cancel_job']);
const TEAM_OPERATIONS = new Set([
  'list_tools', 'list_general_skills', 'list_knowledge_bases', 'list_sops',
  'list_sop_versions', 'get_sop_version',
  'preview_generate_sop', 'preview_rewrite_sop',
  'get_preview_job', 'preview_job_events', 'cancel_preview_job',
]);

export const PUBLIC_PROTOCOL_BLOCKERS = Object.freeze({
  rewrite_preview: 'Use the explicit preview_rewrite_sop operation with current_skill; saved rewrite is a different lifecycle.',
  move_to_draft: 'Use move_to_draft_sop; creating a new draft is a different operation.',
  remove: 'Use remove_sop or remove_tool; archive is a different operation.',
  sync_from_overall: 'Use sync_sop_from_overall with an explicit SOP ID.',
  promote_to_overall: 'Use promote_sop_to_overall with an explicit SOP ID.',
  delete_version: 'Use delete_sop_version with an explicit SOP ID and version.',
  probe_tool: 'Use probe_unsaved_tool with the complete unsaved tool body.',
  delete_tool: 'Use remove_tool; archive is a different operation.',
  extract_sop_file: 'Use extract_sop_text with the original filename/content_base64 body.',
  model_catalog: 'Use list_model_catalog; model bindings are not a catalog.',
  user_catalog: 'Use list_handoff_users; handoff records are not a directory.',
});

function publicBody(input) {
  if (!record(input.body)) fail('PUBLIC_INPUT_INVALID', 'An explicit public request body is required.', 400);
  for (const field of ['tenant_id', 'agent_id', 'user_id', 'actor_user_id']) {
    if (own(input.body, field)) fail('PUBLIC_SCOPE_OVERRIDE', `Host identity field ${field} cannot be supplied in the public body.`, 400);
  }
  return structuredClone(input.body);
}

function rejectMaskedCredentials(body) {
  for (const object of [body.headers, body.auth, body.connection?.headers, body.connection?.env]) {
    if (record(object) && Object.values(object).some(value => value === '********')) {
      fail('PUBLIC_MASKED_CREDENTIAL', 'Masked credentials cannot be written back; submit an explicit supported update.', 400);
    }
  }
}

/** Explicit route map, never an arbitrary URL proxy. IDs are encoded once by this layer. */
export function planPublicOperation(agentId, operation, input = {}) {
  if (agentId === null && !TEAM_OPERATIONS.has(operation)) {
    fail('PUBLIC_TEAM_PROTOCOL_UNAVAILABLE', `No equivalent team public route for ${operation}.`, 409);
  }
  const agent = GLOBAL_JOB_OPERATIONS.has(operation) ? '' : agentId === null ? 'team' : `agents/${id(agentId)}`;
  const plan = { method: 'GET', headers: { accept: 'application/json' } };
  if (own(PUBLIC_PROTOCOL_BLOCKERS, operation)) fail('PUBLIC_PROTOCOL_UNAVAILABLE', PUBLIC_PROTOCOL_BLOCKERS[operation]);
  switch (operation) {
    case 'list_tools': plan.path = `${agent}/tools`; plan.shape = 'collection'; break;
    case 'list_general_skills': plan.path = `${agent}/general-skills`; plan.shape = 'collection'; break;
    case 'list_knowledge_bases': plan.path = `${agent}/knowledge-bases`; plan.shape = 'collection'; break;
    case 'create_knowledge_base':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases`; plan.body = publicBody(input); break;
    case 'update_knowledge_base':
      plan.method = 'PATCH'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}`;
      plan.body = publicBody(input); break;
    case 'archive_knowledge_base':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}:archive`; break;
    case 'search_knowledge_base':
      if (own(input, 'selectedPdModelId')) {
        fail('PUBLIC_PD_MODEL_VALIDATION_REQUIRED', 'Validate the selected PilotDeck model through the mounted host catalog first.', 409);
      }
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}:search`;
      plan.body = publicBody(input);
      if (own(plan.body, 'model_config_id') || own(plan.body, 'modelConfigId')) {
        fail('PUBLIC_SD_MODEL_SELECTION_FORBIDDEN', 'SD model_config_id cannot select a PilotDeck model.', 400);
      }
      break;
    case 'upsert_knowledge_entries':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/entries`;
      plan.body = publicBody(input);
      if (!Array.isArray(plan.body.entries)) fail('PUBLIC_INPUT_INVALID', 'Knowledge entries must be an array.', 400);
      if (input.idempotencyKey !== undefined) {
        if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) fail('PUBLIC_INPUT_INVALID', 'Idempotency key must be non-empty.', 400);
        plan.headers['Idempotency-Key'] = input.idempotencyKey;
      }
      plan.shape = 'accepted-job'; break;
    case 'list_knowledge_versions':
      plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/versions`; plan.shape = 'collection'; break;
    case 'rollback_knowledge_base':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}:rollback`;
      id(input.version); plan.body = { version: input.version }; break;
    case 'list_knowledge_documents':
      plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/documents`; plan.shape = 'collection'; break;
    case 'update_knowledge_document':
      plan.method = 'PATCH'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/documents/${id(input.documentId)}`;
      plan.body = publicBody(input); break;
    case 'archive_knowledge_document':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/documents/${id(input.documentId)}:archive`; break;
    case 'list_knowledge_concepts':
      plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/concepts`; plan.shape = 'collection'; break;
    case 'get_knowledge_document':
      plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/documents/${id(input.documentId)}`; break;
    case 'upload_knowledge_document':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/documents`;
      plan.body = publicBody(input); plan.shape = 'knowledge-ingest-job'; break;
    case 'upload_knowledge_document_auto': {
      if (input.knowledgeBaseId !== undefined) fail('PUBLIC_INPUT_INVALID', 'Auto-create upload does not accept a knowledge base ID.', 400);
      const body = publicBody(input);
      if (Object.keys(body).some(key => !['filename', 'title', 'content_base64', 'media_type', 'capability_scope'].includes(key))) {
        fail('PUBLIC_INPUT_INVALID', 'Auto-create upload accepts only original file, title and capability scope.', 400);
      }
      if (body.capability_scope !== undefined && !['general', 'sop_specific'].includes(body.capability_scope)) {
        fail('PUBLIC_INPUT_INVALID', 'Unknown capability scope.', 400);
      }
      plan.method = 'POST'; plan.path = `${agent}/knowledge/documents:auto-create`;
      plan.body = body; plan.shape = 'knowledge-ingest-job'; break;
    }
    case 'import_knowledge_okf':
      plan.method = 'POST'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/okf:import`;
      plan.body = publicBody(input); break;
    case 'list_document_buckets': plan.path = `${agent}/knowledge-documents/${id(input.documentId)}/buckets`; plan.shape = 'collection'; break;
    case 'list_bucket_chunks': plan.path = `${agent}/knowledge-buckets/${id(input.bucketId)}/chunks`; plan.shape = 'collection'; break;
    case 'update_knowledge_bucket': plan.method = 'PUT'; plan.path = `${agent}/knowledge-buckets/${id(input.bucketId)}`; plan.body = publicBody(input); break;
    case 'update_knowledge_chunk': plan.method = 'PUT'; plan.path = `${agent}/knowledge-chunks/${id(input.chunkId)}`; plan.body = publicBody(input); break;
    case 'get_knowledge_concept': plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/concepts/${id(input.conceptId)}`; break;
    case 'update_knowledge_concept': plan.method = 'PUT'; plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/concepts/${id(input.conceptId)}`; plan.body = publicBody(input); break;
    case 'export_knowledge_okf': plan.path = `${agent}/knowledge-bases/${id(input.knowledgeBaseId)}/okf/export`; break;
    case 'list_knowledge_jobs': {
      plan.path = `${agent}/knowledge-jobs`;
      const query = new URLSearchParams();
      if (input.status) query.set('status', input.status);
      if (input.limit !== undefined) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) fail('PUBLIC_INPUT_INVALID', 'Knowledge job limit must be an integer between 1 and 50.', 400);
        query.set('limit', String(input.limit));
      }
      const suffix = query.toString();
      if (suffix) plan.path += `?${suffix}`;
      plan.shape = 'collection'; break;
    }
    case 'get_knowledge_job': plan.path = `${agent}/knowledge-jobs/${id(input.jobId)}`; break;
    case 'cancel_knowledge_job': plan.method = 'POST'; plan.path = `${agent}/knowledge-jobs/${id(input.jobId)}:cancel`; break;
    case 'list_knowledge_discoveries': {
      plan.path = `${agent}/knowledge-discoveries`;
      const query = new URLSearchParams();
      if (input.knowledgeBaseId) query.set('knowledge_base_id', input.knowledgeBaseId);
      if (input.status) query.set('status', input.status);
      const suffix = query.toString();
      if (suffix) plan.path += `?${suffix}`;
      plan.shape = 'collection'; break;
    }
    case 'confirm_knowledge_discovery': plan.method = 'POST'; plan.path = `${agent}/knowledge-discoveries/${id(input.suggestionId)}:confirm`; break;
    case 'reject_knowledge_discovery': plan.method = 'POST'; plan.path = `${agent}/knowledge-discoveries/${id(input.suggestionId)}:reject`; break;
    case 'list_sops': plan.path = `${agent}/sops`; plan.shape = 'sop-collection'; break;
    case 'get_sop_draft':
      plan.path = `${agent}/sops/${id(input.sopId)}/drafts/${id(input.draftId)}`;
      plan.shape = 'draft'; break;
    case 'list_sop_versions':
    case 'get_sop_version':
      plan.path = agentId === null ? `${agent}/sops/${id(input.sopId)}/versions`
        : `sops/${id(input.sopId)}/versions?agent_id=${id(agentId)}`;
      if (operation === 'get_sop_version') {
        plan.path = agentId === null ? `${agent}/sops/${id(input.sopId)}/versions/${id(input.version)}`
          : `sops/${id(input.sopId)}/versions/${id(input.version)}?agent_id=${id(agentId)}`;
      } else plan.shape = 'collection';
      break;
    case 'create_sop_draft':
      plan.method = 'POST'; plan.path = `${agent}/sops`; plan.body = publicBody(input);
      if (Object.keys(plan.body).some(key => key !== 'content') || !record(plan.body.content)) fail('PUBLIC_INPUT_INVALID', 'A complete structured SOP content object is required.', 400);
      plan.shape = 'created-draft'; break;
    case 'replace_sop_draft':
      if (typeof input.etag !== 'string' || !input.etag.trim()) fail('IF_MATCH_REQUIRED', 'The original draft ETag is required.', 428);
      plan.method = 'PUT'; plan.path = `${agent}/sops/${id(input.sopId)}?draft_id=${id(input.draftId)}`;
      plan.body = publicBody(input);
      if (Object.keys(plan.body).some(key => key !== 'content') || !record(plan.body.content)) fail('PUBLIC_INPUT_INVALID', 'A complete structured SOP content object is required.', 400);
      plan.headers['If-Match'] = input.etag;
      plan.shape = 'draft'; break;
    case 'publish_sop':
      id(input.draftId);
      plan.method = 'POST'; plan.path = `sops/${id(input.sopId)}:publish?agent_id=${id(agentId)}`;
      plan.body = { draft_id: input.draftId }; break;
    case 'archive_sop':
      plan.method = 'POST'; plan.path = `sops/${id(input.sopId)}:archive?agent_id=${id(agentId)}`; break;
    case 'rollback_sop_version':
      plan.method = 'POST'; plan.path = `sops/${id(input.sopId)}/versions/${id(input.version)}:rollback?agent_id=${id(agentId)}`;
      plan.shape = 'created-draft'; break;
    case 'create_tool':
    case 'update_tool':
      plan.method = operation === 'create_tool' ? 'POST' : 'PUT';
      plan.path = `${agent}/tools${operation === 'update_tool' ? `/${id(input.toolId)}` : ''}`;
      plan.body = publicBody(input);
      rejectMaskedCredentials(plan.body);
      break;
    case 'test_tool':
      plan.method = 'POST'; plan.path = `${agent}/tools/${id(input.toolId)}:test`; plan.body = publicBody(input); break;
    case 'import_general_skill':
      plan.method = 'POST'; plan.path = `${agent}/general-skills`; plan.body = publicBody(input); break;
    case 'publish_general_skill':
    case 'archive_general_skill':
    case 'test_general_skill': {
      const action = operation.split('_')[0];
      plan.method = 'POST'; plan.path = `${agent}/general-skills/${id(input.slug)}:${action}`;
      if (action === 'test') plan.body = publicBody(input);
      break;
    }
    case 'generate_sop':
    case 'rewrite_saved_sop': {
      const body = publicBody(input);
      if (input.dirty === true || ['current_skill', 'currentSkill', 'conversation', 'conversation_context'].some(key => own(input, key) || own(body, key))) {
        fail('PUBLIC_PREVIEW_REQUIRED', 'The public job cannot preserve current editor content/conversation. A preview protocol is required.');
      }
      const fields = operation === 'generate_sop'
        ? ['title', 'raw_content', 'business_domain', 'model_config_id']
        : ['instruction', 'target_paths', 'model_config_id', 'draft_id'];
      if (Object.keys(body).some(key => !fields.includes(key))) fail('PUBLIC_INPUT_INVALID', 'Unsupported public job field; it will not be silently discarded.', 400);
      plan.method = 'POST'; plan.path = operation === 'generate_sop' ? `${agent}/sops:generate` : `${agent}/sops/${id(input.sopId)}:rewrite`;
      plan.body = body; plan.shape = 'accepted-job';
      break;
    }
    case 'get_job': plan.path = `jobs/${id(input.jobId)}`; plan.shape = 'job'; break;
    case 'get_job_result': plan.path = `jobs/${id(input.jobId)}/result`; plan.shape = 'job-result'; break;
    case 'cancel_job': plan.method = 'POST'; plan.path = `jobs/${id(input.jobId)}:cancel`; plan.shape = 'job'; break;
    case 'job_events':
      plan.path = `jobs/${id(input.jobId)}/events`; plan.responseType = 'event-stream';
      plan.headers.accept = 'text/event-stream';
      if (input.lastEventId !== undefined) {
        if (!/^\d+$/.test(String(input.lastEventId))) fail('PUBLIC_INPUT_INVALID', 'Last-Event-ID must be a non-negative integer.', 400);
        plan.headers['Last-Event-ID'] = String(input.lastEventId);
      }
      break;
    case 'preview_generate_sop':
    case 'preview_rewrite_sop': {
      const body = publicBody(input);
      const fields = operation === 'preview_generate_sop'
        ? ['title', 'raw_content', 'business_domain', 'model_config_id', 'available_tools', 'available_general_skills', 'available_knowledge_bases']
        : ['current_skill', 'instruction', 'model_config_id', 'target_path', 'target_paths', 'target_label', 'conversation', 'available_tools', 'available_sops'];
      if (Object.keys(body).some(key => !fields.includes(key))) fail('PUBLIC_INPUT_INVALID', 'Unsupported preview field; it will not be silently discarded.', 400);
      if (operation === 'preview_rewrite_sop') {
        if (!record(body.current_skill) || body.current_skill.skill_id !== input.sopId) {
          fail('PUBLIC_INPUT_INVALID', 'Path SOP ID must match current_skill.skill_id.', 400);
        }
      }
      plan.method = 'POST';
      plan.path = operation === 'preview_generate_sop'
        ? `${agent}/sops:preview-generate`
        : `${agent}/sops/${id(input.sopId)}:preview-rewrite`;
      plan.body = body; plan.shape = 'preview-accepted';
      break;
    }
    case 'get_preview_job': plan.path = `${agent}/sop-preview-jobs/${id(input.jobId)}`; plan.shape = 'preview-job'; break;
    case 'preview_job_events':
      plan.path = `${agent}/sop-preview-jobs/${id(input.jobId)}/events`;
      if (input.afterSeq !== undefined) {
        if (!/^\d+$/.test(String(input.afterSeq))) fail('PUBLIC_INPUT_INVALID', 'afterSeq must be a non-negative integer.', 400);
        plan.path += `?after_seq=${encodeURIComponent(String(input.afterSeq))}`;
      }
      plan.responseType = 'event-stream'; plan.headers.accept = 'text/event-stream';
      break;
    case 'cancel_preview_job': plan.method = 'POST'; plan.path = `${agent}/sop-preview-jobs/${id(input.jobId)}:cancel`; break;
    case 'move_to_draft_sop': plan.method = 'POST'; plan.path = `${agent}/sops/${id(input.sopId)}:move-to-draft`; break;
    case 'remove_sop': plan.method = 'DELETE'; plan.path = `${agent}/sops/${id(input.sopId)}`; break;
    case 'sync_sop_from_overall': plan.method = 'POST'; plan.path = `${agent}/sops/${id(input.sopId)}:sync-from-overall`; break;
    case 'promote_sop_to_overall': plan.method = 'POST'; plan.path = `${agent}/sops/${id(input.sopId)}:promote-to-overall`; break;
    case 'delete_sop_version': plan.method = 'DELETE'; plan.path = `${agent}/sops/${id(input.sopId)}/versions/${id(input.version)}`; break;
    case 'probe_unsaved_tool': plan.method = 'POST'; plan.path = `${agent}/tools:probe`; plan.body = publicBody(input); rejectMaskedCredentials(plan.body); break;
    case 'remove_tool': plan.method = 'DELETE'; plan.path = `${agent}/tools/${id(input.toolId)}`; break;
    case 'extract_sop_text': plan.method = 'POST'; plan.path = `${agent}/sops:extract-file`; plan.body = publicBody(input); break;
    case 'list_model_catalog': plan.path = `${agent}/model-catalog`; plan.shape = 'collection'; break;
    case 'list_handoff_users': plan.path = `${agent}/handoff-users`; plan.shape = 'collection'; break;
    default: fail('PUBLIC_OPERATION_UNSUPPORTED', `Unsupported public operation: ${operation}`, 400);
  }
  return plan;
}

/**
 * transport({method,path,headers,body,signal,responseType}) -> {status,body,headers?}.
 * It must use the host's already-authorized owner credentials and propagate HTTP
 * failures unchanged. This module neither obtains credentials nor enables routes.
 */
export function createPublicCapabilityClient({ agentId, transport, authorizedOperations = [], fixedTargetAgentId, hostModelCatalog } = {}) {
  if (fixedTargetAgentId !== undefined) id(fixedTargetAgentId);
  const authorized = new Set(authorizedOperations);
  return Object.freeze({
    async call(operation, input = {}, { signal, scope } = {}) {
      if (!authorized.has(operation)) fail('PUBLIC_OPERATION_NOT_AUTHORIZED', 'This operation has not been authorized by the host.', 403);
      signal?.throwIfAborted();
      // agentId is kept for older host construction, but never supplies a
      // selected editor scope. The caller must provide the current selection.
      void agentId;
      if (!GLOBAL_JOB_OPERATIONS.has(operation) && !scope) {
        fail('PUBLIC_SELECTED_SCOPE_REQUIRED', 'The current agent or team selection is required.', 400);
      }
      if (scope && scope.kind !== 'team' && scope.kind !== 'agent') {
        fail('PUBLIC_SELECTED_SCOPE_INVALID', 'Scope must be an agent or team selection.', 400);
      }
      if (!GLOBAL_JOB_OPERATIONS.has(operation) && fixedTargetAgentId !== undefined &&
          (scope.kind !== 'agent' || scope.agentId !== fixedTargetAgentId)) {
        fail('PUBLIC_FIXED_TARGET_SCOPE_MISMATCH', 'This gateway is bound to a different configured target.', 403);
      }
      const selectedAgentId = scope?.kind === 'team' ? null : scope?.kind === 'agent' ? scope.agentId : agentId;
      let selectedModel;
      if (operation === 'search_knowledge_base') {
        if (typeof hostModelCatalog !== 'function') {
          fail('PUBLIC_PD_MODEL_CATALOG_UNAVAILABLE', 'The current PilotDeck model catalog is not mounted.', 503);
        }
        const bound = bindBrowserKnowledgeSearchModel(input, await hostModelCatalog({ signal }));
        input = bound.input;
        selectedModel = bound.selection;
      }
      signal?.throwIfAborted();
      const plan = planPublicOperation(selectedAgentId, operation, input);
      const response = await transport({ ...plan, signal });
      // A raw HTTP failure remains a failure with its original body/status.
      if (!response || !Number.isInteger(response.status)) fail('PUBLIC_RESPONSE_INVALID', 'Public transport did not return an HTTP response.', 502);
      if (response.status < 200 || response.status >= 300) return response;
      if (plan.responseType === 'event-stream') return response;
      const value = response.body;
      if (!record(value)) fail('PUBLIC_RESPONSE_INVALID', 'Public response must be an object.', 502);
      if (['collection', 'sop-collection'].includes(plan.shape) && (!Array.isArray(value.data) || value.data.some(item => !record(item)))) {
        fail('PUBLIC_RESPONSE_INVALID', 'Public collection is missing its data array.', 502);
      }
      if (plan.shape === 'sop-collection' && (!Array.isArray(value.drafts) || value.drafts.some(item => !record(item)))) {
        fail('PUBLIC_RESPONSE_INVALID', 'Public SOP collection is missing its drafts array.', 502);
      }
      if (['draft', 'created-draft'].includes(plan.shape) && (typeof value.id !== 'string' || typeof value.etag !== 'string')) {
        fail('PUBLIC_RESPONSE_INVALID', 'Public draft is missing its original ID or ETag.', 502);
      }
      if (plan.shape === 'created-draft' && response.status !== 201) fail('PUBLIC_RESPONSE_INVALID', 'Expected a 201 draft response.', 502);
      if (plan.shape === 'accepted-job' && response.status !== 202) fail('PUBLIC_RESPONSE_INVALID', 'Expected a 202 job acceptance.', 502);
      if (plan.shape === 'knowledge-ingest-job' && response.status !== 200) fail('PUBLIC_RESPONSE_INVALID', 'Expected a 200 Knowledge ingest response.', 502);
      if (plan.shape === 'preview-accepted' && (response.status !== 202 || typeof value.job_id !== 'string')) {
        fail('PUBLIC_RESPONSE_INVALID', 'Expected a 202 transient preview job.', 502);
      }
      if (['accepted-job', 'job', 'knowledge-ingest-job'].includes(plan.shape) && (typeof value.id !== 'string' || typeof value.status !== 'string')) {
        fail('PUBLIC_RESPONSE_INVALID', 'Public job is missing its ID or status.', 502);
      }
      if (plan.shape === 'preview-job' && (typeof value.job_id !== 'string' || typeof value.status !== 'string')) {
        fail('PUBLIC_RESPONSE_INVALID', 'Preview job is missing its ID or status.', 502);
      }
      if (plan.shape === 'job-result' && (!record(value.job) || !record(value.result) || !record(value.error))) {
        fail('PUBLIC_RESPONSE_INVALID', 'Public job result envelope is incomplete.', 502);
      }
      if (selectedModel) return { ...response, body: { ...value, host_model_selection: selectedModel } };
      return response; // Preserve drafts, dates, ETags, terminal errors and extensions verbatim.
    },
  });
}

/** Decode actual SSE frames. No progress synthesis, token conversion or reconnect. */
export async function* decodePublicJobEvents(chunks, { signal } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let pendingCR = false;
  let frame = { event: 'message', data: [] };
  function line(value) {
    if (value === '') {
      const ready = frame.data.length ? { ...frame, data: frame.data.join('\n') } : undefined;
      frame = { event: 'message', data: [] };
      return ready;
    }
    if (value.startsWith(':')) return;
    const split = value.indexOf(':');
    const field = split < 0 ? value : value.slice(0, split);
    let data = split < 0 ? '' : value.slice(split + 1);
    if (data.startsWith(' ')) data = data.slice(1);
    if (field === 'data') frame.data.push(data);
    if (field === 'event') frame.event = data || 'message';
    if (field === 'id' && !data.includes('\0')) frame.id = data;
  }
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    const source = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const char of source) {
      if (pendingCR && char === '\n') { pendingCR = false; continue; }
      pendingCR = false;
      if (char === '\r' || char === '\n') {
        const event = line(buffer); buffer = ''; pendingCR = char === '\r';
        if (event) yield event;
      } else buffer += char;
    }
  }
  signal?.throwIfAborted();
  decoder.decode(); // Reject truncated UTF-8. An unterminated SSE frame is not delivered.
}

/** The native preview stream carries seq inside JSON data, not an SSE id. */
export async function* decodePreviewJobEvents(chunks, options = {}) {
  for await (const event of decodePublicJobEvents(chunks, options)) {
    let sequence;
    try {
      const payload = JSON.parse(event.data);
      if (Number.isSafeInteger(payload?.seq) && payload.seq > 0) sequence = payload.seq;
    } catch { /* Preserve the actual data and event name even when not JSON. */ }
    yield sequence === undefined ? event : { ...event, sequence };
  }
}
