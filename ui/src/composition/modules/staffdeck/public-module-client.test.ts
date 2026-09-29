import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import { createPublicModuleClient, uploadPublicKnowledgeDocument, uploadPublicKnowledgeDocumentAuto } from './public-module-client';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const fetch = vi.mocked(authenticatedFetch);
beforeEach(() => vi.clearAllMocks());

describe('public capability module transport', () => {
  it('passes a named operation and signal through the local gateway while preserving 202, data and ETag', async () => {
    const controller = new AbortController();
    const body = { id: 'job-owned', status: 'queued', draft: { id: 'draft-owned' } };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 202, headers: { ETag: '"owner-etag"' } }));
    const client = createPublicModuleClient('/api/modules/staffdeck-public/call');
    const result = await client.call('generate_sop', { body: { title: 'Original' } }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 202, body });
    expect((result.headers as Headers).get('etag')).toBe('"owner-etag"');
    expect(fetch).toHaveBeenCalledWith('/api/modules/staffdeck-public/call', {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'generate_sop', input: { body: { title: 'Original' } } }),
    });
  });

  it('keeps the original HTTP failure and sends no request after cancellation', async () => {
    const raw = '{"error":{"code":"SCOPE_DENIED","message":"Denied"}}';
    fetch.mockResolvedValueOnce(new Response(raw, { status: 403 }));
    const client = createPublicModuleClient('/api/modules/staffdeck-public/call');
    await expect(client.call('list_tools')).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'SCOPE_DENIED', body: raw });
    const controller = new AbortController();
    controller.abort();
    await expect(client.call('list_tools', {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => createPublicModuleClient('/api/v1/agents/private')).toThrow('PilotDeck module');
  });
});

it('sends original file bytes to the named multipart route and keeps the 200 ingest job namespace', async () => {
  const signal = new AbortController().signal;
  const job = { id: 'ingest-1', status: 'queued', knowledge_base_id: 'base-1', filename: 'fact.md' };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 200 }));
  expect(await uploadPublicKnowledgeDocument({ scope: { kind: 'agent', agentId: 'target' }, knowledgeBaseId: 'base-1',
    filename: 'fact.md', contentBase64: btoa('unique fact'), signal })).toEqual(job);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('/api/modules/staffdeck-sdk/file');
  expect(init).toMatchObject({ method: 'POST', signal });
  const form = (init as RequestInit).body as FormData;
  expect(form.get('operation')).toBe('upload_knowledge_document');
  expect(form.get('scope')).toBe(JSON.stringify({ kind: 'agent', agentId: 'target' }));
  expect(form.get('knowledgeBaseId')).toBe('base-1');
  expect(await (form.get('file') as File).text()).toBe('unique fact');
  expect((init as RequestInit).headers).toBeUndefined();
});

it('does not turn a file HTTP failure into an accepted job', async () => {
  const raw = '{"error":{"code":"PUBLIC_FILE_INPUT_INVALID","message":"Wrong base"}}';
  fetch.mockResolvedValueOnce(new Response(raw, { status: 409 }));
  await expect(uploadPublicKnowledgeDocument({ scope: { kind: 'agent', agentId: 'target' }, knowledgeBaseId: 'base-1',
    filename: 'fact.md', contentBase64: btoa('fact') })).rejects.toMatchObject({ status: 409, code: 'PUBLIC_FILE_INPUT_INVALID', body: raw });
});

it('uses the named auto-create multipart operation without a guessed base and validates the returned new base', async () => {
  const job = { id: 'ingest-auto', status: 'queued', knowledge_base_id: 'new-base', filename: 'fact.md' };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 200 }));
  expect(await uploadPublicKnowledgeDocumentAuto({ scope: { kind: 'agent', agentId: 'target' }, filename: 'fact.md',
    contentBase64: btoa('unique fact'), title: 'Fact', capabilityScope: 'general' })).toEqual(job);
  const init = fetch.mock.calls[0][1] as RequestInit;
  const form = init.body as FormData;
  expect(form.get('operation')).toBe('upload_knowledge_document_auto');
  expect(form.get('knowledgeBaseId')).toBeNull();
  expect(form.get('capability_scope')).toBe('general');
  expect(await (form.get('file') as File).text()).toBe('unique fact');
});

it('rejects an auto-upload response with no new knowledge base ID', async () => {
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', status: 'queued' }), { status: 200 }));
  await expect(uploadPublicKnowledgeDocumentAuto({ scope: { kind: 'agent', agentId: 'target' }, filename: 'fact.md', contentBase64: btoa('fact') })).rejects.toThrow('new knowledge base ID');
});
