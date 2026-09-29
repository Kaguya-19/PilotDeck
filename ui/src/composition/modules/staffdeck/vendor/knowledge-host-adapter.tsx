import { usePilotDeckHostCapabilities } from '../pilotdeck-host-capabilities';
import { planPublicHost, callPublicHost, selectedPublicScope, type HostPlan } from '../public-host-mapping';
import { uploadPublicKnowledgeDocument, uploadPublicKnowledgeDocumentAuto } from '../public-module-client';
import type { Host } from './KnowledgePageHost';
import { KnowledgePageHostProvider } from './KnowledgePageHost';
import { PilotDeckDataTable, PilotDeckResourceImportDialog } from './business-primitives';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { staffDeckCopyClient, staffDeckKnowledgeClient } from '../clients';
import { staffDeckNotify } from '../host-notify';
import { persistSharedAgentScope, clearSharedAgentScope, emitAgentScopeChange } from '../host-contract-helpers';
import { createFixedTargetContext, isCopyTarget, loadCopyDirectory, readCopyAgentScope, type CopyContext } from './copy-scope';
import './knowledge-host-theme.css';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from './dialog-primitives';
import { pilotDeckFormalComponents, pilotDeckFormalIcons } from './host-components';
import { renderMarkdownBlocks } from './FormalMarkdown';

function query(path: string): URL { return new URL(path, 'http://staffdeck.local'); }
function record(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
function decodePathSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}
function optionalQueryInput(url: URL): Record<string, string | boolean> {
  const input: Record<string, string | boolean> = {};
  for (const [queryKey, inputKey] of [['tenant_id', 'tenantId'], ['agent_id', 'agentId'], ['knowledge_base_id', 'knowledgeBaseId'], ['status', 'status'], ['concept_type', 'conceptType'], ['include_all_versions', 'includeAllVersions']] as const) {
    const value = url.searchParams.get(queryKey);
    if (value !== null && value !== '') {
      if (inputKey === 'includeAllVersions') {
        if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) throw new Error('Invalid include_all_versions query value.');
        input[inputKey] = ['true', '1'].includes(value.toLowerCase());
      } else input[inputKey] = value;
    }
  }
  if (url.searchParams.has('include_all_versions')) input.includeAllVersions = ['true', '1'].includes(url.searchParams.get('include_all_versions') || '');
  return input;
}
function publicKnowledgeBody(body: unknown): Record<string, unknown> {
  const value = { ...record(body) };
  for (const field of ['tenant_id', 'agent_id', 'actor_user_id', 'user_id', 'tenantId', 'agentId', 'actorUserId', 'userId', 'knowledgeBaseId', 'documentId', 'bucketId', 'chunkId', 'conceptId', 'jobId', 'suggestionId']) delete value[field];
  return value;
}

/** Only map owner-equivalent operations; removal, unscoped documents and multi-base search retain their original contract. */
export function planKnowledgePublic(path: string, method: string, body?: unknown): HostPlan | undefined {
  const url = query(path);
  const parts = url.pathname.split('/').filter(Boolean).map(decodePathSegment);
  const [api, enterprise, resource, baseId, action, itemId] = parts;
  if (api !== 'api' || enterprise !== 'enterprise') return;
  const plan = (operation: string, input: Record<string, unknown> = {}, collection = false): HostPlan => ({ operation, input, collection });
  const inputBody = publicKnowledgeBody(body);
  if (resource === 'knowledge-bases' && parts.length === 3 && method === 'post') return plan('create_knowledge_base', { body: inputBody });
  if (resource === 'knowledge-bases' && baseId && parts.length === 4) {
    if (method === 'put') return plan('update_knowledge_base', { knowledgeBaseId: baseId, body: inputBody });
  }
  if (resource === 'knowledge-bases' && baseId && parts.length === 5 && action === 'versions' && method === 'get') return plan('list_knowledge_versions', { knowledgeBaseId: baseId }, true);
  if (resource === 'knowledge-bases' && baseId && parts.length === 5 && action === 'rollback' && method === 'post' && inputBody.version !== undefined) return plan('rollback_knowledge_base', { knowledgeBaseId: baseId, version: inputBody.version });
  if (resource === 'knowledge-bases' && baseId && action === 'okf') {
    if (parts.length === 6 && itemId === 'export' && method === 'get') return plan('export_knowledge_okf', { knowledgeBaseId: baseId });
    if (parts.length === 6 && itemId === 'concepts' && method === 'get' && !url.searchParams.has('concept_type')) return plan('list_knowledge_concepts', { knowledgeBaseId: baseId }, true);
    if (parts.length > 6 && itemId === 'concepts' && (method === 'get' || method === 'put')) {
      const conceptId = parts.slice(6).join('/');
      return method === 'get' ? plan('get_knowledge_concept', { knowledgeBaseId: baseId, conceptId })
        : plan('update_knowledge_concept', { knowledgeBaseId: baseId, conceptId, body: inputBody });
    }
  }
  if (resource !== 'knowledge') return;
  if (baseId === 'search' && parts.length === 4 && method === 'post') {
    const baseIds = record(body).knowledge_base_ids;
    if (Array.isArray(baseIds) && baseIds.length === 1 && typeof baseIds[0] === 'string' && baseIds[0]) {
      delete inputBody.knowledge_base_ids;
      const selectedPdModelId = inputBody.model_config_id;
      delete inputBody.model_config_id;
      return plan('search_knowledge_base', { knowledgeBaseId: baseIds[0], selectedPdModelId, body: inputBody });
    }
  }
  if (baseId === 'documents' && action && parts.length === 5) {
    const knowledgeBaseId = url.searchParams.get('knowledge_base_id');
    if (knowledgeBaseId && method === 'get') return plan('get_knowledge_document', { knowledgeBaseId, documentId: action });
    if (knowledgeBaseId && method === 'put') return plan('update_knowledge_document', { knowledgeBaseId, documentId: action, body: inputBody });
  }
  if (baseId === 'documents' && parts.length === 4 && method === 'get' && url.searchParams.get('knowledge_base_id') && !url.searchParams.has('include_all_versions')) {
    return plan('list_knowledge_documents', { knowledgeBaseId: url.searchParams.get('knowledge_base_id') }, true);
  }
  if (baseId === 'documents' && parts.length === 6 && parts[5] === 'buckets' && method === 'get') return plan('list_document_buckets', { documentId: action }, true);
  if (baseId === 'buckets' && action && parts.length === 6 && parts[5] === 'chunks' && method === 'get') return plan('list_bucket_chunks', { bucketId: action }, true);
  if (baseId === 'buckets' && action && parts.length === 5 && method === 'put') return plan('update_knowledge_bucket', { bucketId: action, body: inputBody });
  if (baseId === 'chunks' && action && parts.length === 5 && method === 'put') return plan('update_knowledge_chunk', { chunkId: action, body: inputBody });
  if (baseId === 'jobs') {
    if (parts.length === 4 && method === 'get') return plan('list_knowledge_jobs', { limit: Number(url.searchParams.get('limit') || 20), ...optionalQueryInput(url) }, true);
    if (action && parts.length === 5 && method === 'get') return plan('get_knowledge_job', { jobId: action });
    if (action && parts.length === 6 && parts[5] === 'cancel' && method === 'post') return plan('cancel_knowledge_job', { jobId: action });
  }
  if (baseId === 'discoveries') {
    if (parts.length === 4 && method === 'get') return plan('list_knowledge_discoveries', optionalQueryInput(url), true);
    if (action && parts.length === 6 && method === 'post') {
      if (parts[5] === 'confirm') return plan('confirm_knowledge_discovery', { suggestionId: action });
      if (parts[5] === 'reject') return plan('reject_knowledge_discovery', { suggestionId: action });
    }
  }
}
function pilotDeckAgentScope(): string {
  return readCopyAgentScope();
}
async function pilotDeckAgentDirectory(): Promise<Array<{ id: string; name: string; is_overall: boolean; active: boolean }>> {
  return loadCopyDirectory();
}

async function knowledge<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
  return staffDeckKnowledgeClient.call<T>(operation, input);
}

export async function visibleKnowledgeDocuments(context: CopyContext, signal?: AbortSignal): Promise<Array<Record<string, any>>> {
  signal?.throwIfAborted();
  const scope = selectedPublicScope('/api/enterprise/knowledge/documents', undefined, context.readScope);
  context.assertSelectedScope(scope);
  const bases = await callPublicHost({ operation: 'list_knowledge_bases', input: {}, collection: true }, scope, signal);
  if (!Array.isArray(bases)) throw new Error('Knowledge base directory is invalid.');
  const groups = await Promise.all(bases.map(async (base) => {
    const baseId = record(base).id;
    if (typeof baseId !== 'string' || !baseId) throw new Error('Knowledge base directory omitted its ID.');
    return await callPublicHost({ operation: 'list_knowledge_documents', input: { knowledgeBaseId: baseId }, collection: true }, scope, signal);
  }));
  signal?.throwIfAborted();
  return groups.flat().map((row) => record(row));
}

async function callKnowledge<T>(path: string, method: 'get' | 'post' | 'put' | 'delete', body?: any, context?: CopyContext, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  context?.assertSelectedScope(selectedPublicScope(path, body, context.readScope));
  const publicPlan = planPublicHost(path, method, body);
  if (publicPlan) return await callPublicHost(publicPlan, selectedPublicScope(path, body, context?.readScope), signal, context?.hostCapabilities) as T;
  const url = query(path);
  const segments = url.pathname.split('/').filter(Boolean);
  const exact = (...shape: string[]) => segments.length === shape.length && shape.every((part, index) => part === '*' ? Boolean(segments[index]) : part === segments[index]);
  if (segments[0] !== 'api' || segments[1] !== 'enterprise') throw new Error(`Unsupported StaffDeck Knowledge path: ${method} ${path}`);
  const conceptPath = segments[2] === 'knowledge-bases' && segments[4] === 'okf' && segments[5] === 'concepts';
  const allowedLength = segments[2] === 'agents' ? 6
    : segments[2] === 'knowledge-bases' ? (segments[4] === 'okf' ? 6 : 5)
    : segments[2] === 'knowledge' ? (segments[3] === 'knowledge-bases' ? 4 : 6) : 0;
  if (!conceptPath && segments.length > allowedLength) throw new Error(`Unsupported StaffDeck Knowledge path: ${method} ${path}`);
  const knowledgePlan = context && planKnowledgePublic(path, method, body);
  if (knowledgePlan) return await callPublicHost(knowledgePlan, selectedPublicScope(path, body, context.readScope), signal, context.hostCapabilities) as T;
  if (context && url.pathname === '/api/enterprise/knowledge/documents' && method === 'get' && !url.searchParams.has('include_all_versions')) {
    return await visibleKnowledgeDocuments(context, signal) as T;
  }
  if (context && url.pathname === '/api/enterprise/knowledge/documents' && method === 'post') {
    const baseId = body?.knowledge_base_id;
    const scope = selectedPublicScope(path, body, context.readScope);
    if (scope.kind !== 'agent') throw new Error('PUBLIC_FIXED_TARGET_SCOPE_MISMATCH');
    if (typeof baseId !== 'string' || !baseId) return await uploadPublicKnowledgeDocumentAuto({ scope,
      filename: body?.filename, contentBase64: body?.content_base64, title: body?.title,
      capabilityScope: body?.capability_scope, mediaType: body?.media_type, signal }) as T;
    return await uploadPublicKnowledgeDocument({ scope, knowledgeBaseId: baseId, filename: body?.filename,
      contentBase64: body?.content_base64, title: body?.title, signal }) as T;
  }
  if (context && segments[2] === 'knowledge' && segments[3] === 'documents' && segments[4] && segments.length === 5 && (method === 'get' || method === 'put')) {
    const documentId = decodePathSegment(segments[4]);
    const rows = await visibleKnowledgeDocuments(context, signal);
    const row = rows.find((item) => item.id === documentId);
    if (!row || typeof row.knowledge_base_id !== 'string') throw new Error('Knowledge document is not in the visible target bases.');
    const operation = method === 'get' ? 'get_knowledge_document' : 'update_knowledge_document';
    return await callPublicHost({ operation, input: { knowledgeBaseId: row.knowledge_base_id, documentId,
      ...(method === 'put' ? { body: publicKnowledgeBody(body) } : {}) } }, selectedPublicScope(path, body, context.readScope), signal) as T;
  }
  if (url.pathname === '/api/enterprise/agents' && method === 'get') return await staffDeckCopyClient.call<T>('list_agents');
  if (url.pathname === '/api/enterprise/knowledge-bases' && method === 'get') {
    if (context || url.searchParams.has('agent_id')) return await callPublicHost({ operation: 'list_knowledge_bases', input: {}, collection: true }, selectedPublicScope(path, body, context?.readScope), undefined, context?.hostCapabilities) as T;
    const sourceAgentId = url.searchParams.get('agent_id');
    if (sourceAgentId && sourceAgentId !== pilotDeckAgentScope()) {
      return await staffDeckCopyClient.call<T>('list_knowledge_bases', { sourceAgentId });
    }
    return await knowledge<T>('list_bases', optionalQueryInput(url));
  }
  if (exact('api', 'enterprise', 'agents', '*', 'resources', 'import') && method === 'post') {
    return await staffDeckCopyClient.call<T>('import_resources', {
      targetAgentId: decodePathSegment(segments[3]), sourceAgentId: body?.source_agent_id,
      resourceType: body?.resource_type, resourceIds: body?.resource_ids,
    });
  }
  if (url.pathname === '/api/enterprise/knowledge-bases' && method === 'post') return await knowledge<T>('create_base', { ...(body || {}), ...optionalQueryInput(url) });
  if (url.pathname === '/api/enterprise/knowledge/documents' && method === 'get') return await knowledge<T>('list_documents', optionalQueryInput(url));
  if (url.pathname === '/api/enterprise/knowledge/documents' && method === 'post') return await knowledge<T>('import_document', { ...body, ...optionalQueryInput(url) });
  if (segments[0] === 'api' && segments[1] === 'enterprise' && segments[2] === 'knowledge' && segments[3] === 'documents' && segments[4]) {
    const documentId = decodePathSegment(segments[4]);
    const scope = optionalQueryInput(url);
    if (segments.length === 6 && segments[5] === 'buckets' && method === 'get') return await knowledge<T>('list_document_buckets', { ...scope, documentId });
    if (segments.length === 5 && method === 'get') return await knowledge<T>('get_document', { ...scope, documentId });
    if (segments.length === 5 && method === 'put') return await knowledge<T>('update_document', { ...(body || {}), ...scope, documentId });
    if (segments.length === 5 && method === 'delete') return await knowledge<T>('delete_document', { ...scope, documentId });
    throw new Error(`Unsupported StaffDeck Knowledge document operation: ${method} ${path}`);
  }
  if (exact('api', 'enterprise', 'knowledge', 'knowledge-bases') && method === 'get') return await knowledge<T>('list_bases', optionalQueryInput(url));
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'versions') && method === 'get') return await knowledge<T>('list_versions', { knowledgeBaseId: decodePathSegment(segments[3]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'sync-from-overall') && method === 'post') return await knowledge<T>('sync_base', { ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'promote-to-overall') && method === 'post') return await knowledge<T>('publish_version', { ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'rollback') && method === 'post') return await knowledge<T>('rollback_version', { ...(body || {}), ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (segments[0] === 'api' && segments[1] === 'enterprise' && segments[2] === 'knowledge-bases' && segments[3] && segments[4] === 'okf' && segments[5] === 'concepts') {
    const knowledgeBaseId = decodePathSegment(segments[3]);
    const scope = optionalQueryInput(url);
    if (segments.length === 6 && method === 'get') return await knowledge<T>('list_okf_concepts', { ...scope, knowledgeBaseId });
    if (segments.length > 6 && (method === 'get' || method === 'put')) {
      const conceptId = segments.slice(6).map(decodePathSegment).join('/');
      const input = method === 'get' ? { ...scope, knowledgeBaseId, conceptId } : {
        tenantId: body?.tenant_id, documentId: body?.document_id,
        contentMd: body?.content_md, status: body?.status,
        ...scope, knowledgeBaseId, conceptId,
      };
      const result = await knowledge<any>(method === 'get' ? 'get_okf_concept' : 'upsert_okf_concept', input);
      if (!result || Array.isArray(result) || typeof result.concept_id !== 'string' || typeof result.content_md !== 'string') throw new Error('Knowledge concept response does not match the formal concept contract.');
      return result as T;
    }
    throw new Error(`Unsupported StaffDeck Knowledge concept operation: ${method} ${path}`);
  }
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'okf', 'export') && method === 'get') return await knowledge<T>('export_okf', { knowledgeBaseId: decodePathSegment(segments[3]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*', 'okf', 'lint') && method === 'post') return await knowledge<T>('lint_okf', { ...(body || {}), ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*') && method === 'get') return await knowledge<T>('get_base', { ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*') && method === 'put') return await knowledge<T>('update_base', { ...(body || {}), ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge-bases', '*') && method === 'delete') return await knowledge<T>('delete_base', { ...optionalQueryInput(url), knowledgeBaseId: decodePathSegment(segments[3]) });
  if (exact('api', 'enterprise', 'knowledge', 'search') && method === 'post') return await knowledge<T>('query', { ...(body || {}), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'okf', 'import') && method === 'post') return await knowledge<T>('import_okf', { ...(body || {}), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'buckets', '*', 'chunks') && method === 'get') return await knowledge<T>('list_bucket_chunks', { bucketId: decodePathSegment(segments[4]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'buckets', '*') && method === 'put') return await knowledge<T>('update_bucket', { ...(body || {}), ...optionalQueryInput(url), bucketId: decodePathSegment(segments[4]) });
  if (exact('api', 'enterprise', 'knowledge', 'chunks', '*') && method === 'put') return await knowledge<T>('update_chunk', { ...(body || {}), ...optionalQueryInput(url), chunkId: decodePathSegment(segments[4]) });
  if (exact('api', 'enterprise', 'knowledge', 'citations', '*') && method === 'get') return await knowledge<T>('resolve_citation', { ...optionalQueryInput(url), chunkId: decodePathSegment(segments[4]) });
  if (exact('api', 'enterprise', 'knowledge', 'jobs', '*', 'cancel') && method === 'post') return await knowledge<T>('cancel_job', { jobId: decodePathSegment(segments[4]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'jobs', '*') && method === 'get') return await knowledge<T>('get_job', { jobId: decodePathSegment(segments[4]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'jobs') && method === 'get') return await knowledge<T>('list_jobs', { limit: Number(url.searchParams.get('limit') || 20), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'discoveries', '*', 'confirm') && method === 'post') return await knowledge<T>('confirm_discovery', { suggestionId: decodePathSegment(segments[4]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'discoveries', '*', 'reject') && method === 'post') return await knowledge<T>('reject_discovery', { suggestionId: decodePathSegment(segments[4]), ...optionalQueryInput(url) });
  if (exact('api', 'enterprise', 'knowledge', 'discoveries') && method === 'get') return await knowledge<T>('list_discoveries', optionalQueryInput(url));
  throw new Error(`Unsupported StaffDeck Knowledge path: ${method} ${path}`);
}

export const pilotDeckKnowledgePageHost: Host = {
  icons: pilotDeckFormalIcons,
  components: { ...pilotDeckFormalComponents, DataTable: PilotDeckDataTable, ResourceImportDialog: PilotDeckResourceImportDialog },
  api: { get: (path) => callKnowledge(path, 'get'), post: (path, body) => callKnowledge(path, 'post', body), put: (path, body) => callKnowledge(path, 'put', body), delete: (path) => callKnowledge(path, 'delete'), blob: async (path) => {
    const result = record(await callKnowledge(path, 'get'));
    if (typeof result.content_base64 === 'string') {
      const binary = atob(result.content_base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: String(result.media_type || 'application/octet-stream') });
    }
    throw new Error('Knowledge export response is missing its formal content_base64 archive.');
  } },
  navigate: (path: string) => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); },
  tenantId: 'tenant_demo', notify: staffDeckNotify, isEnterpriseAdmin: (user) => Boolean(user?.is_admin),
  loadEmployeeDirectory: async () => pilotDeckAgentDirectory(), agentScope: {
    read: pilotDeckAgentScope,
    persist: persistSharedAgentScope,
    clear: clearSharedAgentScope,
    emit: emitAgentScopeChange,
  },
  visibleEmployeeAgents: (agents) => agents.filter((agent) => !agent.is_overall), canManageEmployeeAgent: (agent) => Boolean(isCopyTarget(agent) && agent.can_manage === true), openGalleryAgentId: (agents) => agents.find((agent) => agent.is_overall)?.id || '', openGalleryImportSourceOptions: (agents) => agents.filter((agent) => agent.is_overall).map((agent) => ({ value: agent.id, label: agent.name || agent.id })), resourceCreatorName: (row) => String(row.created_by_name || ''), renderMarkdownBlocks: (value) => renderMarkdownBlocks(value), getDateLocale: () => 'zh-CN',
};

function mapKnowledgePath(path: string): string {
  if (path === '/enterprise/knowledge' || path === '/enterprise/knowledge/') return '/knowledge';
  if (path.startsWith('/enterprise/knowledge/')) return `/knowledge/${path.slice('/enterprise/knowledge/'.length)}`;
  return path;
}

export function PilotDeckKnowledgePageProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const hostCapabilities = usePilotDeckHostCapabilities();
  const context = useMemo(() => createFixedTargetContext(hostCapabilities), [hostCapabilities]);
  const host = useMemo<Host>(() => ({
    ...pilotDeckKnowledgePageHost,
    api: { ...pilotDeckKnowledgePageHost.api,
      get: (path, options) => callKnowledge(path, 'get', undefined, context, options?.signal),
      post: (path, body, options) => callKnowledge(path, 'post', body, context, options?.signal),
      put: (path, body) => callKnowledge(path, 'put', body, context),
      delete: (path) => callKnowledge(path, 'delete', undefined, context),
    },
    loadEmployeeDirectory: () => context.loadDirectory(),
    canManageEmployeeAgent: (agent) => Boolean(context.isTarget(agent) && agent.can_manage === true),
    agentScope: { ...pilotDeckKnowledgePageHost.agentScope, read: context.readScope },
  }), [context]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void context.loadDirectory({ signal: controller.signal }).then(() => { if (mounted) setReady(true); }).catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { mounted = false; controller.abort(); };
  }, [context]);
  if (error) return <div role="alert">{error}</div>;
  if (!ready) return null;
  return <KnowledgePageHostProvider value={{ ...host, tenantId: context.readTenant(), getDateLocale: () => i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US', navigate: (path) => navigate(mapKnowledgePath(path)) }}><div className="pilotdeck-knowledge-host">{children}</div></KnowledgePageHostProvider>;
}
