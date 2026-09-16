import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore, type NormalizedMessage } from './useSessionStore';
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>), readAgentStatusErrorFromResponse: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
const thought = (revision: number, content: string, offset?: number): NormalizedMessage => ({
  id: 'wire', sessionId: 's', runId: 'run', kind: 'thinking', provider: 'pilotdeck', timestamp: '2026-01-01', content,
  timeline: { version: 1, turnId: 'run', id: 'thought', order: 0, revision, offset },
});
it('history racing live updates does not change identity, regress content or lose the user anchor', async () => {
  let resolveHistory!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveHistory = resolve; })));
  const { result } = renderHook(useSessionStore);
  let request: Promise<unknown>;
  act(() => { result.current.setActiveSession('s'); request = result.current.fetchFromServer('s'); });
  act(() => {
    result.current.appendRealtime('s', { ...thought(1, 'question'), id: 'local_user', timeline: undefined, role: 'user', kind: 'text' });
    result.current.applyTimelineMessage('s', thought(1, 'one', 0));
    result.current.applyTimelineMessage('s', thought(2, ' two', 3));
  });
  const id = result.current.getMessages('s').find(m => m.timeline)?.id;
  await act(async () => {
    resolveHistory(new Response(JSON.stringify({ messages: [], stream: { messages: [thought(1, 'one')] } })));
    await request;
  });
  expect(result.current.getMessages('s').map(m => m.content)).toEqual(['question', 'one two']);
  expect(result.current.getMessages('s').find(m => m.timeline)?.id).toBe(id);
  act(() => result.current.closeTimeline('s', 'run', false, undefined, { turnId: 'run', through: 0, revision: 3 }));
  expect(result.current.getMessages('s').find(m => m.timeline)?.streamState).toBe('closed');
});
it('editing a turn tombstones its protocol rows and rejects late final snapshots', () => {
  const { result } = renderHook(useSessionStore);
  act(() => result.current.applyTimelineMessage('s', thought(1, 'old', 0)));
  act(() => result.current.replaceLastTurn('s', 'run', { ...thought(1, 'new'), id: 'replacement', timeline: undefined, runId: 'new-run', role: 'user', kind: 'text' }));
  act(() => result.current.applyTimelineMessage('s', { ...thought(2, 'old final'), isFinal: true }));
  expect(result.current.getMessages('s').map(m => m.content)).toEqual(['new']);
});

it('keeps linked Agent cards in parent history while excluding actual child detail', async () => {
  const card: NormalizedMessage = { ...thought(1, ''), kind: 'tool_use', toolName: 'Agent', toolId: 'call',
    subagentId: 'child', isFinal: true, timeline: { ...thought(1, '').timeline!, id: 'tool:call' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [card] }))));
  const { result } = renderHook(useSessionStore);
  act(() => result.current.applyTimelineMessage('s', {
    ...thought(1, 'child thought', 0), subagentId: 'child', isSubagentDetail: true,
    timeline: { ...thought(1, '', 0).timeline!, turnId: 'child-t0' },
  }));
  await act(async () => { await result.current.fetchFromServer('s'); });
  expect(result.current.getMessages('s')).toHaveLength(1);
  expect(result.current.getMessages('s')[0]).toMatchObject({ toolId: 'call', subagentId: 'child' });
  expect(result.current.getSubagentDetailMessages('s', 'child')).toHaveLength(1);
});

it('parent termination closes and refreshes cached child details and rejects late deltas', () => {
  const { result } = renderHook(useSessionStore);
  const child = { ...thought(1, 'child thought', 0), subagentId: 'child', isSubagentDetail: true,
    timeline: { ...thought(1, '', 0).timeline!, turnId: 'child-t0' } };
  act(() => {
    result.current.applyTimelineMessage('s', child);
    result.current.closeTimeline('s', 'run', true);
  });
  expect(result.current.getSubagentDetailMessages('s', 'child')[0].streamState).toBe('closed');
  act(() => result.current.applyTimelineMessage('s', { ...child, content: ' late',
    timeline: { ...child.timeline, revision: 2, offset: child.content!.length } }));
  expect(result.current.getSubagentDetailMessages('s', 'child')[0]).toMatchObject({ content: 'child thought', streamState: 'closed' });
});

it.each(['fetchFromServer', 'refreshFromServer'] as const)('%s applies child termination before content in a restored baseline', async (method) => {
  const activity: NormalizedMessage = { ...thought(1, ''), timeline: undefined, kind: 'agent_activity',
    phase: 'subagent', state: 'failed', parentRunId: 'run', runId: 'subagent:child', subagentId: 'child' };
  const child: NormalizedMessage = { ...thought(2, 'Interrupted thought'), subagentId: 'child', isSubagentDetail: true,
    streamState: 'open', timeline: { ...thought(2, '').timeline!, turnId: 'child-t0' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    messages: [], stream: { active: true, runId: 'run', messages: [activity, child, thought(3, 'Parent continues')] },
  }))));
  const { result } = renderHook(useSessionStore);
  await act(async () => { await result.current[method]('s'); });
  expect(result.current.getSubagentDetailMessages('s', 'child')[0]).toMatchObject({ content: 'Interrupted thought', streamState: 'closed' });
  expect(result.current.getMessages('s')[0]).toMatchObject({ content: 'Parent continues', streamState: 'open' });
});
