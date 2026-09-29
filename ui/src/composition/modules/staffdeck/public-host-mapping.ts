import { PILOTDECK_HOST_OPERATIONS, type PilotDeckHostCapabilityPort } from './pilotdeck-host-capabilities';
import { authenticatedFetch } from '../../../utils/api';
import { moduleApiError } from './clients';
import { createPublicModuleClient, type PublicSelectedScope } from './public-module-client';

export const publicModuleClient = createPublicModuleClient('/api/modules/staffdeck-sdk/call');
const globals = new Set(['get_job', 'get_job_result', 'job_events', 'cancel_job']);
export function selectedPublicScope(path: string, body?: Record<string, unknown>, readScope?: () => string): PublicSelectedScope {
  const url = new URL(path, 'http://host.local');
  const pathAgent = url.pathname.match(/^\/api\/enterprise\/agents\/([^/]+)\//)?.[1];
  const selected = pathAgent ? decodeURIComponent(pathAgent) : url.searchParams.has('agent_id')
    ? url.searchParams.get('agent_id') || '' : body?.agent_id !== undefined
      ? String(body?.agent_id ?? '') : readScope?.();
  if (selected === undefined) throw new Error('PUBLIC_SELECTED_SCOPE_REQUIRED');
  return selected && !selected.startsWith('team:') ? { kind: 'agent', agentId: selected } : { kind: 'team' };
}
function cleanBody(body: unknown) {
  const result = { ...(body as Record<string, unknown> ?? {}) };
  for (const key of ['tenant_id', 'agent_id', 'actor_user_id', 'user_id']) delete result[key];
  return result;
}
export type HostPlan = { operation: string; input: Record<string, unknown>; collection?: boolean };
export function planPublicHost(path: string, method: string, body?: unknown): HostPlan | undefined {
  const url = new URL(path, 'http://host.local');
  if (!/^\/api\/(?:auth\/users$|enterprise\/(?:tools|general-skills|model-configs|skills|agents)(?:\/|$))/.test(url.pathname)) return;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const inputBody = cleanBody(body);
  const plan = (operation: string, input: Record<string, unknown> = {}, collection = false) => ({ operation, input, collection });
  if (url.pathname === '/api/auth/users' && method === 'get') return plan('list_handoff_users', {}, true);
  if (parts[0] !== 'api' || parts[1] !== 'enterprise') return;
  const resource = parts[2], id = parts[3], action = parts[4];
  if (parts.length === 3 && method === 'get') {
    const op = ({ tools: 'list_tools', 'general-skills': 'list_general_skills', 'model-configs': 'list_model_catalog' } as Record<string, string>)[resource];
    if (op) return plan(op, {}, true);
  }
  if (resource === 'tools') {
    if (parts.length === 3 && method === 'post') return plan('create_tool', { body: inputBody });
    if (parts.length === 4 && id === 'probe' && method === 'post') return plan('probe_unsaved_tool', { body: inputBody });
    if (parts.length === 4 && method === 'put') return plan('update_tool', { toolId: id, body: inputBody });
    if (parts.length === 4 && method === 'delete') return plan('remove_tool', { toolId: id });
    if (parts.length === 5 && action === 'test' && method === 'post') return plan('test_tool', { toolId: id, body: inputBody });
  }
  if (resource === 'general-skills') {
    if (parts.length === 3 && method === 'post') return plan('import_general_skill', { body: inputBody });
    if (parts.length === 5 && method === 'post' && ['publish', 'archive', 'test'].includes(action)) return plan(`${action}_general_skill`, { slug: id, ...(action === 'test' ? { body: inputBody } : {}) });
  }
  if (resource === 'agents' && parts.length === 7 && parts[4] === 'skills' && method === 'post') {
    const op = ({ 'sync-from-overall': 'sync_sop_from_overall', 'promote-to-overall': 'promote_sop_to_overall' } as Record<string, string>)[parts[6]];
    if (op) return plan(op, { sopId: parts[5] });
  }
  if (resource === 'skills') {
    if (parts.length === 5 && id === 'files' && action === 'extract' && method === 'post') return plan('extract_sop_text', { body: inputBody });
    if (parts.length === 6 && id === 'jobs' && parts[5] === 'cancel' && method === 'post') return plan('cancel_preview_job', { jobId: parts[4] });
    if (parts.length === 4 && method === 'delete') return plan('remove_sop', { sopId: id });
    if (parts.length === 5 && action === 'draft' && method === 'post') return plan('move_to_draft_sop', { sopId: id });
    if (parts.length === 6 && action === 'versions' && method === 'delete') return plan('delete_sop_version', { sopId: id, version: parts[5] });
  }
}
export async function callPublicHost(plan: HostPlan, scope: PublicSelectedScope, signal?: AbortSignal, hostCapabilities?: PilotDeckHostCapabilityPort) {
  signal?.throwIfAborted();
  const isHostCapability = PILOTDECK_HOST_OPERATIONS.has(plan.operation);
  if (isHostCapability && !hostCapabilities) throw Object.assign(new Error('PilotDeck host capability binding is unavailable.'), { code: 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE' });
  const response = isHostCapability
    ? await hostCapabilities!.call(plan.operation, plan.input, { signal })
    : await publicModuleClient.call(plan.operation, plan.input, { scope: globals.has(plan.operation) ? undefined : scope, signal });
  if (response.status < 200 || response.status >= 300) throw moduleApiError(response.status, typeof response.body === 'string' ? response.body : JSON.stringify(response.body), `HTTP ${response.status}`);
  signal?.throwIfAborted();
  if (plan.collection) {
    const body = response.body as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error('Public collection response has no data array.');
    return body.data;
  }
  return response.body;
}

/** Consume the module gateway's real SSE; preview seq stays in data, never becomes an APIJob ID. */
export async function gatewayEvents(operation: 'job_events' | 'preview_job_events', jobId: string, scope: PublicSelectedScope | undefined, cursor: string | undefined, onEvent: (event: { id?: string; event: string; data: Record<string, unknown> }) => void, signal?: AbortSignal) {
  const query = new URLSearchParams({ operation, jobId });
  if (operation === 'preview_job_events') {
    if (!scope) throw new Error('PUBLIC_SELECTED_SCOPE_REQUIRED');
    query.set('scope', scope.kind);
    if (scope.kind === 'agent') query.set('agentId', scope.agentId);
    if (cursor !== undefined) query.set('afterSeq', cursor);
  }
  const response = await authenticatedFetch(`/api/modules/staffdeck-sdk/events?${query}`, { signal, ...(operation === 'job_events' && cursor ? { headers: { 'Last-Event-ID': cursor } } : {}) });
  if (!response.ok) throw moduleApiError(response.status, await response.text(), response.statusText);
  if (!response.body) throw new Error('Preview stream response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = 'message', data: string[] = [], pendingCR = false, id: string | undefined;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { decoder.decode(); break; }
      for (const char of decoder.decode(chunk.value, { stream: true })) {
        if (pendingCR && char === '\n') { pendingCR = false; continue; }
        pendingCR = false;
        if (char !== '\r' && char !== '\n') { buffer += char; continue; }
        const line = buffer; buffer = ''; pendingCR = char === '\r';
        if (!line) {
          if (data.length) { signal?.throwIfAborted(); onEvent({ ...(id === undefined ? {} : { id }), event, data: JSON.parse(data.join('\n')) }); }
          event = 'message'; data = []; id = undefined; continue;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value || 'message';
        if (field === 'data') data.push(value);
        if (field === 'id' && !value.includes('\0')) id = value;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const previewEvents = (jobId: string, scope: PublicSelectedScope, afterSeq: string | undefined, onEvent: (event: { event: string; data: Record<string, unknown> }) => void, signal?: AbortSignal) => gatewayEvents('preview_job_events', jobId, scope, afterSeq, onEvent, signal);
