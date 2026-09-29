// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { pilotDeckKnowledgePageHost } from './knowledge-host-adapter';
import { pilotDeckSkillsPageHost, createPilotDeckDistillPageHost } from './skills-host-adapter';
import { staffDeckKnowledgeClient, staffDeckSopManagementClient } from '../clients';
import { pilotDeckFormalComponents } from './host-components';
import { renderMarkdownBlocks } from './FormalMarkdown';
import { normalizeCapabilityScope } from './FormalCapabilityScopeControl';
import { formatHandoffAssigneeValue, parseHandoffAssigneeValue } from './FormalHandoff';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('formal Host audit regressions', () => {
  it('does not send unknown nested operations, forged prefixes or methods to a real module', async () => {
    const call = vi.spyOn(staffDeckKnowledgeClient, 'call');
    for (const root of ['knowledge-bases/b/versions', 'knowledge/buckets/b/chunks', 'knowledge/chunks/c', 'knowledge/jobs/j', 'knowledge/discoveries/d/confirm']) {
      await expect(pilotDeckKnowledgePageHost.api.get('/api/enterprise/' + root + '/unexpected')).rejects.toThrow('Unsupported');
    }
    await expect(pilotDeckKnowledgePageHost.api.put('/other/enterprise/knowledge-bases/b', {})).rejects.toThrow('Unsupported');
    expect(call).not.toHaveBeenCalled();
  });
  it('uses decoded base/bucket/chunk path IDs and query scope before conflicting body fields', async () => {
    const call = vi.spyOn(staffDeckKnowledgeClient, 'call').mockResolvedValue({} as any);
    const body = { knowledgeBaseId: 'wrong', bucketId: 'wrong', chunkId: 'wrong', agentId: 'wrong', expected_updated_at: 'original' };
    await pilotDeckKnowledgePageHost.api.put('/api/enterprise/knowledge-bases/b%2F1?agent_id=target', body);
    expect(call).toHaveBeenLastCalledWith('update_base', { ...body, knowledgeBaseId: 'b/1', agentId: 'target' });
    await pilotDeckKnowledgePageHost.api.put('/api/enterprise/knowledge/buckets/b%2F2?agent_id=target', body);
    expect(call).toHaveBeenLastCalledWith('update_bucket', { ...body, bucketId: 'b/2', agentId: 'target' });
    await pilotDeckKnowledgePageHost.api.put('/api/enterprise/knowledge/chunks/c%2F3?agent_id=target', body);
    expect(call).toHaveBeenLastCalledWith('update_chunk', { ...body, chunkId: 'c/3', agentId: 'target' });
    await pilotDeckKnowledgePageHost.api.get('/api/enterprise/knowledge/documents?include_all_versions=false&agent_id=target');
    expect(call).toHaveBeenLastCalledWith('list_documents', { includeAllVersions: false, agentId: 'target' });
  });
  it('rejects a malformed export response instead of downloading a JSON body as an OKF archive', async () => {
    vi.spyOn(staffDeckKnowledgeClient, 'call').mockResolvedValue({} as any);
    await expect(pilotDeckKnowledgePageHost.api.blob('/api/enterprise/knowledge-bases/base/okf/export')).rejects.toThrow('content_base64');
  });
  it('does not let an editor unknown suffix become a detail read or save', async () => {
    const call = vi.spyOn(staffDeckSopManagementClient, 'call');
    const host = createPilotDeckDistillPageHost();
    await expect(host.api.get('/api/enterprise/skills/sop/unknown')).rejects.toThrow('Unsupported');
    await expect(host.api.put('/api/enterprise/skills/sop/unknown', {})).rejects.toThrow('Unsupported');
    expect(call).not.toHaveBeenCalled();
  });
  it('creates the first edited draft from its published snapshot while keeping move-to-draft blocked', async () => {
    const content = { skill_id: 'sop', name: 'Original', version: '1.0.0', nodes: [{ node_id: 'start' }], extensions: { preserved: true } };
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async operation => operation === 'list' ? { data: [{ id: 'sop', skill_id: 'sop', status: 'published', content }], drafts: [] } as any : { id: 'new-draft', sop_id: 'sop', content, draft_version: '1.0.1', etag: 'first-read' } as any);
    const host = createPilotDeckDistillPageHost();
    await host.api.get('/api/enterprise/skills/sop?agent_id=target');
    await host.api.put('/api/enterprise/skills/sop?agent_id=target', content);
    expect(call).toHaveBeenLastCalledWith('create', { sopId: 'sop', content });
    const requests = call.mock.calls.length;
    await expect(pilotDeckSkillsPageHost.api.post('/api/enterprise/skills/sop/draft?agent_id=target')).rejects.toThrow('not equivalent');
    expect(call).toHaveBeenCalledTimes(requests);
  });
  it('preserves formal markdown blocks and pure scope/handoff contracts', () => {
    render(<article>{renderMarkdownBlocks('# Title\n\n**Fact**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')}</article>);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('Fact').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(normalizeCapabilityScope('sop-specific')).toBe('sop_specific');
    expect(normalizeCapabilityScope('unknown')).toBe('general');
    expect(formatHandoffAssigneeValue('user', 'web')).toBe('user');
    expect(parseHandoffAssigneeValue(' user ')).toEqual({ userId: 'user', channel: 'web' });
  });
  it('keeps the original loading confirmation open and blocks Cancel/Confirm until loading completes', async () => {
    const Confirm = pilotDeckFormalComponents.ConfirmDialog;
    const close = vi.fn(); const confirm = vi.fn();
    render(<Confirm open loading title="Delete original item" onOpenChange={close} onConfirm={confirm} />);
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(close).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
});
