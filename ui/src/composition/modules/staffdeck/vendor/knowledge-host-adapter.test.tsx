import { describe, expect, it, vi } from 'vitest';
import { pilotDeckKnowledgePageHost, planKnowledgePublic, visibleKnowledgeDocuments } from './knowledge-host-adapter';
import { pilotDeckSkillsPageHost } from './skills-host-adapter';
import { staffDeckCopyClient, staffDeckKnowledgeClient } from '../clients';
import type { CopyContext } from './copy-scope';

describe('fixed-target Knowledge public planning', () => {
  it('collects every visible current document through its owner base with request-local scope and signal', async () => {
    const signal = new AbortController().signal;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_path, init) => {
      const { operation, input } = JSON.parse(String(init?.body));
      const data = operation === 'list_knowledge_bases' ? [{ id: 'a' }, { id: 'b' }]
        : [{ id: `doc-${input.knowledgeBaseId}`, knowledge_base_id: input.knowledgeBaseId }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const context = { readScope: () => 'target', assertSelectedScope: vi.fn() } as unknown as CopyContext;
    try {
      expect(await visibleKnowledgeDocuments(context, signal)).toEqual([
        { id: 'doc-a', knowledge_base_id: 'a' }, { id: 'doc-b', knowledge_base_id: 'b' },
      ]);
      expect(fetch.mock.calls.map(([_path, init]) => [JSON.parse(String(init?.body)), init?.signal])).toEqual([
        [{ operation: 'list_knowledge_bases', input: {}, scope: { kind: 'agent', agentId: 'target' } }, signal],
        [{ operation: 'list_knowledge_documents', input: { knowledgeBaseId: 'a' }, scope: { kind: 'agent', agentId: 'target' } }, signal],
        [{ operation: 'list_knowledge_documents', input: { knowledgeBaseId: 'b' }, scope: { kind: 'agent', agentId: 'target' } }, signal],
      ]);
    } finally { fetch.mockRestore(); }
  });
  it('keeps original IDs, content and ingest-job namespaces in owner-equivalent operations', () => {
    expect(planKnowledgePublic('/api/enterprise/knowledge-bases/base%2F1/okf/concepts/path/%E4%B8%AD%E6%96%87', 'put', { tenant_id: 'forged', document_id: 'doc', content_md: 'new text' })).toEqual({
      operation: 'update_knowledge_concept', input: { knowledgeBaseId: 'base/1', conceptId: 'path/中文', body: { document_id: 'doc', content_md: 'new text' } }, collection: false,
    });
    expect(planKnowledgePublic('/api/enterprise/knowledge/jobs/ingest%2F1/cancel', 'post')).toMatchObject({ operation: 'cancel_knowledge_job', input: { jobId: 'ingest/1' } });
    expect(planKnowledgePublic('/api/enterprise/knowledge/buckets/b%2F1/chunks', 'get')).toMatchObject({ operation: 'list_bucket_chunks', input: { bucketId: 'b/1' }, collection: true });
    expect(planKnowledgePublic('/api/enterprise/knowledge-bases/base/okf/export', 'get')).toMatchObject({ operation: 'export_knowledge_okf', input: { knowledgeBaseId: 'base' } });
    expect(planKnowledgePublic('/api/enterprise/knowledge/documents/doc%2F1?knowledge_base_id=base', 'put', { tenant_id: 'forged', content_md: 'full text', expected_updated_at: 'original' })).toMatchObject({
      operation: 'update_knowledge_document', input: { knowledgeBaseId: 'base', documentId: 'doc/1', body: { content_md: 'full text', expected_updated_at: 'original' } },
    });
    expect(planKnowledgePublic('/api/enterprise/knowledge/search', 'post', { tenant_id: 'forged', knowledge_base_ids: ['base'], query: 'question', model_config_id: 'provider/model', mode: 'debug', max_depth: 3, need_evidence_pack: true })).toEqual({
      operation: 'search_knowledge_base', input: { knowledgeBaseId: 'base', selectedPdModelId: 'provider/model', body: { query: 'question', mode: 'debug', max_depth: 3, need_evidence_pack: true } }, collection: false,
    });
    expect(planKnowledgePublic('/api/enterprise/knowledge/search', 'post', { knowledge_base_ids: ['base'], query: 'question', model_config_id: '' })?.input).toEqual({
      knowledgeBaseId: 'base', selectedPdModelId: '', body: { query: 'question' },
    });
    expect(planKnowledgePublic('/api/enterprise/knowledge/search', 'post', { knowledge_base_ids: ['base'], query: 'question', model_config_id: 'stale/provider' })?.input.selectedPdModelId).toBe('stale/provider');
  });

  it('does not substitute archive, scoped search or one-base document listing for different owner semantics', () => {
    expect(planKnowledgePublic('/api/enterprise/knowledge-bases/base', 'delete')).toBeUndefined();
    expect(planKnowledgePublic('/api/enterprise/knowledge/documents', 'get')).toBeUndefined();
    expect(planKnowledgePublic('/api/enterprise/knowledge/documents/doc', 'put', { content_md: 'unspecified base' })).toBeUndefined();
    expect(planKnowledgePublic('/api/enterprise/knowledge/search', 'post', { knowledge_base_ids: ['a', 'b'] })).toBeUndefined();
    expect(planKnowledgePublic('/api/enterprise/knowledge-bases/base/okf/concepts?concept_type=SourceSection', 'get')).toBeUndefined();
  });
});

describe('PilotDeck Knowledge host authorization boundary', () => {
  it('preserves document query scope and body for scoped branch writes and adjacent reads', async () => {
    const original = staffDeckKnowledgeClient.call;
    const calls: any[] = [];
    const document = { id: 'branch-document', knowledge_base_version_id: 'branch-version', content_md: 'unique fact' };
    staffDeckKnowledgeClient.call = async (operation, input) => { calls.push({ operation, input }); return document as any; };
    const path = '/api/enterprise/knowledge/documents/doc%2F%E4%B8%AD%E6%96%87?agent_id=sales&tenant_id=actual&knowledge_base_id=base';
    const scope = { agentId: 'sales', tenantId: 'actual', knowledgeBaseId: 'base', documentId: 'doc/中文' };
    const body = { tenant_id: 'actual', title: 'Title', content_md: 'unique fact', expected_updated_at: 'original-read', metadata: { preserved: true }, documentId: 'body-must-not-replace-path', agentId: 'body-must-not-replace-query' };
    try {
      expect(await pilotDeckKnowledgePageHost.api.put(path, body)).toBe(document);
      expect(await pilotDeckKnowledgePageHost.api.get(path)).toBe(document);
      expect(await pilotDeckKnowledgePageHost.api.delete!(path)).toBe(document);
      expect(await pilotDeckKnowledgePageHost.api.get(path.replace('?', '/buckets?'))).toBe(document);
      expect(calls).toEqual([
        { operation: 'update_document', input: { ...body, ...scope } },
        { operation: 'get_document', input: scope },
        { operation: 'delete_document', input: scope },
        { operation: 'list_document_buckets', input: scope },
      ]);
      for (const method of ['get', 'put', 'delete'] as const) {
        const unknownPath = path.replace('?', '/unknown?');
        await expect(method === 'put' ? pilotDeckKnowledgePageHost.api.put(unknownPath, {}) : pilotDeckKnowledgePageHost.api[method](unknownPath)).rejects.toThrow('Unsupported');
      }
      expect(calls).toHaveLength(4);
    } finally { staffDeckKnowledgeClient.call = original; }
  });
  it('dispatches a complete scoped concept ID and exact body/response without updating the base', async () => {
    const original = staffDeckKnowledgeClient.call;
    const calls: any[] = [];
    const concept = { id: 'row', concept_id: 'rules/中文', content_md: 'title-only edit', source_refs: [{ document_id: 'doc' }] };
    staffDeckKnowledgeClient.call = async (operation, input) => { calls.push({ operation, input }); return concept as any; };
    try {
      const path = '/api/enterprise/knowledge-bases/base%20id/okf/concepts/rules/%E4%B8%AD%E6%96%87?agent_id=actual-target';
      expect(await pilotDeckKnowledgePageHost.api.put(path, { tenant_id: 'actual-tenant', document_id: 'doc', content_md: 'title-only edit', status: 'active' })).toBe(concept);
      expect(calls[0]).toEqual({ operation: 'upsert_okf_concept', input: { knowledgeBaseId: 'base id', conceptId: 'rules/中文', agentId: 'actual-target', tenantId: 'actual-tenant', documentId: 'doc', contentMd: 'title-only edit', status: 'active' } });
      expect(await pilotDeckKnowledgePageHost.api.get(path + '&tenant_id=actual-tenant')).toBe(concept);
      expect(calls[1]).toEqual({ operation: 'get_okf_concept', input: { knowledgeBaseId: 'base id', conceptId: 'rules/中文', agentId: 'actual-target', tenantId: 'actual-tenant' } });
      await expect(pilotDeckKnowledgePageHost.api.delete!(path)).rejects.toThrow('Unsupported');
      await expect(pilotDeckKnowledgePageHost.api.put('/api/enterprise/knowledge-bases/base/unknown', {})).rejects.toThrow('Unsupported');
      expect(calls).toHaveLength(2);
    } finally { staffDeckKnowledgeClient.call = original; }
  });
  it('does not grant overall administration to an authenticated non-admin user', () => {
    expect(pilotDeckKnowledgePageHost.isEnterpriseAdmin({ id: 'user-1', is_admin: false })).toBe(false);
    expect(pilotDeckKnowledgePageHost.canManageEmployeeAgent({ id: 'agent-1' }, { id: 'user-1', is_admin: false })).toBe(false);
  });

  it('uses the explicit single-user/admin identity supplied by the host', () => {
    expect(pilotDeckKnowledgePageHost.isEnterpriseAdmin({ id: 'user-1', is_admin: true })).toBe(true);
    expect(pilotDeckKnowledgePageHost.canManageEmployeeAgent({ id: 'agent-1' }, { id: 'user-1', is_admin: true })).toBe(false);
  });

  it('loads actual overall and target identities from the formal copy directory', async () => {
    const originalCall = staffDeckCopyClient.call;
    staffDeckCopyClient.call = async () => [
      { id: 'employee-real', tenant_id: 'tenant_demo', name: 'Employee', is_overall: false, active: true, copy_target: true, can_manage: true },
      { id: 'plaza-real', tenant_id: 'tenant-real', name: 'Plaza', is_overall: true, active: true, copy_target: false },
    ] as any;
    try {
      expect((await pilotDeckKnowledgePageHost.loadEmployeeDirectory()).map((agent) => agent.id)).toEqual(['employee-real', 'plaza-real']);
      expect(pilotDeckKnowledgePageHost.openGalleryAgentId(await pilotDeckKnowledgePageHost.loadEmployeeDirectory())).toBe('plaza-real');
      expect(pilotDeckKnowledgePageHost.canManageEmployeeAgent({ id: 'plaza-real' }, { is_admin: true })).toBe(false);
      expect(pilotDeckKnowledgePageHost.canManageEmployeeAgent({ id: 'employee-real', can_manage: true })).toBe(true);
      expect(pilotDeckKnowledgePageHost.canManageEmployeeAgent({ id: 'employee-real', can_manage: false }, { is_admin: true })).toBe(false);
    } finally { staffDeckCopyClient.call = originalCall; }
  });

  it('maps both shared plaza pages to scoped source reads and formal resource imports', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    const originalCall = staffDeckCopyClient.call;
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
    staffDeckCopyClient.call = async (operation, input = {}) => {
      calls.push({ operation, input });
      return [] as any;
    };
    window.localStorage.setItem('ultrarag_enterprise_agent_scope', 'employee-real');
    try {
      await pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge-bases?tenant_id=forged&agent_id=plaza-real');
      await pilotDeckSkillsPageHost.api.get('/api/enterprise/agents/plaza-real/skills?tenant_id=forged');
      await pilotDeckKnowledgePageHost.api.post('/api/enterprise/agents/employee-real/resources/import', { source_agent_id: 'plaza-real', resource_type: 'knowledge_base', resource_ids: ['base-real'], tenant_id: 'forged' });
      await pilotDeckSkillsPageHost.api.post('/api/enterprise/agents/employee-real/resources/import', { source_agent_id: 'plaza-real', resource_type: 'skill', resource_ids: ['sop-real'], tenant_id: 'forged' });
      expect(calls).toEqual([
        { operation: 'list_skills', input: { sourceAgentId: 'plaza-real' } },
        { operation: 'import_resources', input: { targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType: 'knowledge_base', resourceIds: ['base-real'] } },
        { operation: 'import_resources', input: { targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType: 'skill', resourceIds: ['sop-real'] } },
      ]);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ operation: 'list_knowledge_bases', scope: { kind: 'agent', agentId: 'plaza-real' } });
    } finally { fetch.mockRestore(); staffDeckCopyClient.call = originalCall; window.localStorage.removeItem('ultrarag_enterprise_agent_scope'); }
  });

  it('resolves plaza copy only from an actual overall agent in either shared page', () => {
    const employee = { id: 'employee-1', is_overall: false };
    const overall = { id: 'overall-actual', is_overall: true };
    for (const host of [pilotDeckKnowledgePageHost, pilotDeckSkillsPageHost]) {
      expect(host.openGalleryAgentId([employee])).toBe('');
      expect(host.openGalleryAgentId([employee, overall])).toBe(overall.id);
      expect(host.openGalleryImportSourceOptions([employee, overall], '开放广场')).toEqual([
        { value: overall.id, label: overall.id },
      ]);
    }
  });
});

describe('PilotDeck Knowledge host protocol mapping', () => {
  it('maps every formal Knowledge page operation without bypassing the StaffDeck protocol', async () => {
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
    const originalCall = staffDeckKnowledgeClient.call;
    staffDeckKnowledgeClient.call = async function <T>(operation: string, input: Record<string, unknown> = {}) {
      calls.push({ operation, input });
      return {} as T;
    };

    const cases: Array<{
      method: 'get' | 'post' | 'put' | 'delete';
      path: string;
      body?: Record<string, unknown>;
      operation: string;
      input: Record<string, unknown>;
    }> = [
      { method: 'get', path: '/api/enterprise/knowledge-bases', operation: 'list_bases', input: {} },
      { method: 'post', path: '/api/enterprise/knowledge-bases', body: { name: 'G4', description: 'fixture' }, operation: 'create_base', input: { name: 'G4', description: 'fixture' } },
      { method: 'get', path: '/api/enterprise/knowledge/documents?knowledge_base_id=base-1', operation: 'list_documents', input: { knowledgeBaseId: 'base-1' } },
      { method: 'post', path: '/api/enterprise/knowledge/documents', body: { knowledgeBaseId: 'base-1', title: 'Policy' }, operation: 'import_document', input: { knowledgeBaseId: 'base-1', title: 'Policy' } },
      { method: 'get', path: '/api/enterprise/knowledge/documents/doc-1', operation: 'get_document', input: { documentId: 'doc-1' } },
      { method: 'put', path: '/api/enterprise/knowledge/documents/doc-1', body: { title: 'Updated' }, operation: 'update_document', input: { documentId: 'doc-1', title: 'Updated' } },
      { method: 'delete', path: '/api/enterprise/knowledge/documents/doc-1', operation: 'delete_document', input: { documentId: 'doc-1' } },
      { method: 'get', path: '/api/enterprise/knowledge-bases/base-1/versions', operation: 'list_versions', input: { knowledgeBaseId: 'base-1' } },
      { method: 'post', path: '/api/enterprise/knowledge-bases/base-1/sync-from-overall?agent_id=agent-1', operation: 'sync_base', input: { knowledgeBaseId: 'base-1', agentId: 'agent-1' } },
      { method: 'post', path: '/api/enterprise/knowledge-bases/base-1/promote-to-overall?agent_id=agent-1', operation: 'publish_version', input: { knowledgeBaseId: 'base-1', agentId: 'agent-1' } },
      { method: 'post', path: '/api/enterprise/knowledge-bases/base-1/rollback', body: { version: 2 }, operation: 'rollback_version', input: { knowledgeBaseId: 'base-1', version: 2 } },
      { method: 'get', path: '/api/enterprise/knowledge-bases/base-1/okf/concepts', operation: 'list_okf_concepts', input: { knowledgeBaseId: 'base-1' } },
      { method: 'get', path: '/api/enterprise/knowledge-bases/base-1/okf/export', operation: 'export_okf', input: { knowledgeBaseId: 'base-1' } },
      { method: 'post', path: '/api/enterprise/knowledge-bases/base-1/okf/lint', body: { strict: true }, operation: 'lint_okf', input: { knowledgeBaseId: 'base-1', strict: true } },
      { method: 'put', path: '/api/enterprise/knowledge-bases/base-1', body: { description: 'kept' }, operation: 'update_base', input: { knowledgeBaseId: 'base-1', description: 'kept' } },
      { method: 'delete', path: '/api/enterprise/knowledge-bases/base-1', operation: 'delete_base', input: { knowledgeBaseId: 'base-1' } },
      { method: 'post', path: '/api/enterprise/knowledge/search', body: { query: 'approval', knowledgeBaseIds: ['base-1'] }, operation: 'query', input: { query: 'approval', knowledgeBaseIds: ['base-1'] } },
      { method: 'post', path: '/api/enterprise/knowledge/okf/import', body: { knowledgeBaseId: 'base-1', archive: 'fixture' }, operation: 'import_okf', input: { knowledgeBaseId: 'base-1', archive: 'fixture' } },
      { method: 'get', path: '/api/enterprise/knowledge/documents/doc-1/buckets?knowledge_base_id=base-1', operation: 'list_document_buckets', input: { documentId: 'doc-1', knowledgeBaseId: 'base-1' } },
      { method: 'get', path: '/api/enterprise/knowledge/buckets/bucket-1/chunks', operation: 'list_bucket_chunks', input: { bucketId: 'bucket-1' } },
      { method: 'put', path: '/api/enterprise/knowledge/buckets/bucket-1', body: { title: 'Section' }, operation: 'update_bucket', input: { bucketId: 'bucket-1', title: 'Section' } },
      { method: 'put', path: '/api/enterprise/knowledge/chunks/chunk-1', body: { content: 'changed', summary: 'kept' }, operation: 'update_chunk', input: { chunkId: 'chunk-1', content: 'changed', summary: 'kept' } },
      { method: 'get', path: '/api/enterprise/knowledge/citations/chunk-1', operation: 'resolve_citation', input: { chunkId: 'chunk-1' } },
      { method: 'get', path: '/api/enterprise/knowledge/jobs?limit=8', operation: 'list_jobs', input: { limit: 8 } },
      { method: 'get', path: '/api/enterprise/knowledge/jobs/job-1', operation: 'get_job', input: { jobId: 'job-1' } },
      { method: 'get', path: '/api/enterprise/knowledge/jobs/job%2F1', operation: 'get_job', input: { jobId: 'job/1' } },
      { method: 'get', path: '/api/enterprise/knowledge/jobs/job%E0%A4%A', operation: 'get_job', input: { jobId: 'job%E0%A4%A' } },
      { method: 'post', path: '/api/enterprise/knowledge/jobs/job-1/cancel', operation: 'cancel_job', input: { jobId: 'job-1' } },
      { method: 'get', path: '/api/enterprise/knowledge/discoveries', operation: 'list_discoveries', input: {} },
      { method: 'post', path: '/api/enterprise/knowledge/discoveries/discovery-1/confirm', operation: 'confirm_discovery', input: { suggestionId: 'discovery-1' } },
      { method: 'post', path: '/api/enterprise/knowledge/discoveries/suggestion%2F5/confirm', operation: 'confirm_discovery', input: { suggestionId: 'suggestion/5' } },
      { method: 'post', path: '/api/enterprise/knowledge/discoveries/suggestion%E0%A4%A/reject', operation: 'reject_discovery', input: { suggestionId: 'suggestion%E0%A4%A' } },
      { method: 'post', path: '/api/enterprise/knowledge/discoveries/discovery-1/reject', operation: 'reject_discovery', input: { suggestionId: 'discovery-1' } },
    ];

    try {
      for (const testCase of cases) {
        if (testCase.method === 'get' || testCase.method === 'delete') {
          await pilotDeckKnowledgePageHost.api[testCase.method](testCase.path);
        } else {
          await pilotDeckKnowledgePageHost.api[testCase.method](testCase.path, testCase.body);
        }
      }
    } finally {
      staffDeckKnowledgeClient.call = originalCall;
    }

    expect(calls).toEqual(cases.map(({ operation, input }) => ({ operation, input })));
    await expect(pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge/unsupported')).rejects.toThrow('Unsupported StaffDeck Knowledge path');
  });
});

describe('Knowledge exact root and query projection', () => {
  it('keeps root query scope and makes path/query identity authoritative over the body', async () => {
    const original = staffDeckKnowledgeClient.call;
    const calls: any[] = [];
    staffDeckKnowledgeClient.call = async (operation, input) => { calls.push({ operation, input }); return {} as any; };
    try {
      const path = '/api/enterprise/knowledge-bases/base%2Fid?tenant_id=tenant&agent_id=target';
      await pilotDeckKnowledgePageHost.api.put(path, { name: 'New name', knowledgeBaseId: 'spoof', agentId: 'spoof', tenantId: 'spoof' });
      await pilotDeckKnowledgePageHost.api.delete!(path);
      await pilotDeckKnowledgePageHost.api.post('/api/enterprise/knowledge-bases?tenant_id=tenant&agent_id=target', { name: 'Created', tenantId: 'spoof' });
      expect(calls).toEqual([
        { operation: 'update_base', input: { name: 'New name', knowledgeBaseId: 'base/id', agentId: 'target', tenantId: 'tenant' } },
        { operation: 'delete_base', input: { knowledgeBaseId: 'base/id', agentId: 'target', tenantId: 'tenant' } },
        { operation: 'create_base', input: { name: 'Created', tenantId: 'tenant', agentId: 'target' } },
      ]);
    } finally { staffDeckKnowledgeClient.call = original; }
  });
  it('keeps concept_type and the actual false include_all_versions value', async () => {
    const original = staffDeckKnowledgeClient.call;
    const calls: any[] = [];
    staffDeckKnowledgeClient.call = async (operation, input) => { calls.push({ operation, input }); return [] as any; };
    try {
      await pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge/documents?tenant_id=tenant&include_all_versions=false');
      await pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge/knowledge-bases?tenant_id=tenant&agent_id=target');
      await pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge-bases/base/okf/concepts?concept_type=SourceSection');
      expect(calls).toEqual([
        { operation: 'list_documents', input: { tenantId: 'tenant', includeAllVersions: false } },
        { operation: 'list_bases', input: { tenantId: 'tenant', agentId: 'target' } },
        { operation: 'list_okf_concepts', input: { knowledgeBaseId: 'base', conceptType: 'SourceSection' } },
      ]);
      await expect(pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge/documents?include_all_versions=unknown')).rejects.toThrow('Invalid');
    } finally { staffDeckKnowledgeClient.call = original; }
  });
  it('rejects unknown adjacent routes without invoking an owner', async () => {
    const original = staffDeckKnowledgeClient.call;
    const calls: any[] = [];
    staffDeckKnowledgeClient.call = async (operation, input) => { calls.push({ operation, input }); return [] as any; };
    try {
      for (const path of ['/api/enterprise/knowledge/jobs/job/unknown', '/api/enterprise/knowledge/search/unknown', '/api/enterprise/knowledge-bases/base/versions/unknown', '/wrong/enterprise/knowledge/jobs']) {
        await expect(pilotDeckKnowledgePageHost.api.get(path)).rejects.toThrow('Unsupported');
      }
      expect(calls).toEqual([]);
    } finally { staffDeckKnowledgeClient.call = original; }
  });
  it('rejects a malformed export rather than fabricating a JSON archive', async () => {
    const original = staffDeckKnowledgeClient.call;
    staffDeckKnowledgeClient.call = async () => ({ filename: 'wrong-shape' }) as any;
    try {
      await expect(pilotDeckKnowledgePageHost.api.blob!('/api/enterprise/knowledge-bases/base/okf/export')).rejects.toThrow('content_base64');
    } finally { staffDeckKnowledgeClient.call = original; }
  });
});
