import { authenticatedFetch } from '../../../utils/api';
import { moduleApiError } from './clients';
import type { PublicCapabilityClient, PublicCapabilityResponse } from './public-capability-adapter';

export type PublicSelectedScope = { kind: 'agent'; agentId: string } | { kind: 'team' };

/** Browser transport for a named operation on the existing PilotDeck module gateway. */
export function createPublicModuleClient(endpoint: string): PublicCapabilityClient & { call(operation: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal; scope?: PublicSelectedScope }): Promise<PublicCapabilityResponse> } {
  if (!/^\/api\/modules\/[a-z0-9/-]+\/call$/.test(endpoint)) {
    throw new Error('The public capability endpoint must be a named PilotDeck module call route.');
  }
  return Object.freeze({
    async call(operation: string, input: Record<string, unknown> = {}, options: { signal?: AbortSignal; scope?: PublicSelectedScope } = {}): Promise<PublicCapabilityResponse> {
      options.signal?.throwIfAborted();
      const response = await authenticatedFetch(endpoint, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, input, ...(options.scope ? { scope: options.scope } : {}) }),
      });
      const raw = await response.text();
      options.signal?.throwIfAborted();
      let body: unknown = raw;
      if (raw) {
        try { body = JSON.parse(raw); } catch {
          if (response.ok) throw new Error('Public module response is not JSON.');
        }
      }
      if (!response.ok) throw moduleApiError(response.status, raw, response.statusText);
      return { status: response.status, body, headers: response.headers };
    },
  });
}

/** The named file route preserves the original 200 Knowledge ingest job. */
export async function uploadPublicKnowledgeDocument(input: {
  scope: Extract<PublicSelectedScope, { kind: 'agent' }>;
  knowledgeBaseId: string;
  filename: string;
  contentBase64: string;
  title?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  input.signal?.throwIfAborted();
  if (!input.knowledgeBaseId || !input.filename) throw new Error('PUBLIC_FILE_INPUT_INVALID');
  const binary = atob(input.contentBase64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const form = new FormData();
  form.set('operation', 'upload_knowledge_document');
  form.set('scope', JSON.stringify(input.scope));
  form.set('knowledgeBaseId', input.knowledgeBaseId);
  if (input.title !== undefined) form.set('title', input.title);
  form.set('file', new File([bytes], input.filename, { type: 'application/octet-stream' }));
  const response = await authenticatedFetch('/api/modules/staffdeck-sdk/file', { method: 'POST', body: form, signal: input.signal });
  const raw = await response.text();
  input.signal?.throwIfAborted();
  if (!response.ok) throw moduleApiError(response.status, raw, response.statusText);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('Knowledge ingest response is not JSON.'); }
  const job = body as Record<string, unknown>;
  if (response.status !== 200 || !job || typeof job.id !== 'string' || typeof job.status !== 'string' || job.knowledge_base_id !== input.knowledgeBaseId) {
    throw new Error('Knowledge upload did not return the original ingest job.');
  }
  return body;
}

export async function uploadPublicKnowledgeDocumentAuto(input: {
  scope: Extract<PublicSelectedScope, { kind: 'agent' }>;
  filename: string;
  contentBase64: string;
  title?: string;
  capabilityScope?: 'general' | 'sop_specific';
  mediaType?: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  input.signal?.throwIfAborted();
  if (!input.filename) throw new Error('PUBLIC_FILE_INPUT_INVALID');
  const binary = atob(input.contentBase64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const form = new FormData();
  form.set('operation', 'upload_knowledge_document_auto');
  form.set('scope', JSON.stringify(input.scope));
  if (input.title !== undefined) form.set('title', input.title);
  if (input.capabilityScope !== undefined) form.set('capability_scope', input.capabilityScope);
  form.set('file', new File([bytes], input.filename, { type: input.mediaType || 'application/octet-stream' }));
  const response = await authenticatedFetch('/api/modules/staffdeck-sdk/file', { method: 'POST', body: form, signal: input.signal });
  const raw = await response.text();
  input.signal?.throwIfAborted();
  if (!response.ok) throw moduleApiError(response.status, raw, response.statusText);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('Knowledge ingest response is not JSON.'); }
  const job = body as Record<string, unknown>;
  if (response.status !== 200 || typeof job?.id !== 'string' || !job.id || typeof job.status !== 'string' ||
      typeof job.knowledge_base_id !== 'string' || !job.knowledge_base_id) {
    throw new Error('Knowledge auto-upload did not return the original ingest job and new knowledge base ID.');
  }
  return job;
}
