import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppSocketMessage, Project } from '../types/app';
import { api } from '../utils/api';
import { useProjectsState } from './useProjectsState';
import { compareProjectsBySidebarOrder } from '../components/app-shell/appShellSelection';

vi.mock('../utils/api', () => ({ api: { projects: vi.fn() } }));
const iso = (time: number) => new Date(time).toISOString();
const projects: Project[] = [
  { name: 'recent', displayName: 'Recent', fullPath: '/recent', lastActivity: 2000, sessions: [] },
  { name: 'older', displayName: 'Older', fullPath: '/older', lastActivity: 1000,
    sessions: [{ id: 'web:s_1', title: 'Original', updated_at: iso(1000), lastActivity: iso(1000) }] },
];
const response = (items: Project[], revision: number) => new Response(JSON.stringify(items), {
  headers: { 'X-Projects-Revision': String(revision) },
});
beforeEach(() => {
  vi.mocked(api.projects).mockReset().mockResolvedValue(response(projects, 10));
  vi.spyOn(Date, 'now').mockReturnValue(3000);
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function setup() {
  const navigate = vi.fn();
  const activeSessions = new Set<string>();
  const hook = renderHook(({ latestMessage }: { latestMessage: AppSocketMessage | null }) => useProjectsState({
    navigate, activeSessions, isMobile: false, latestMessage,
  }), { initialProps: { latestMessage: null } as { latestMessage: AppSocketMessage | null } });
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(2));
  act(() => {
    hook.result.current.setSelectedProject(projects[1]);
    hook.result.current.handleSessionSelect(projects[1].sessions![0]);
  });
  return hook;
}
const first = (items: Project[]) => [...items].sort(compareProjectsBySidebarOrder)[0].name;

it.each([true, false])('keeps a just-active project first (same socket frame replay: %s)', async (replay) => {
  const { result, rerender } = await setup();
  const message: AppSocketMessage = { type: 'projects_updated', projects, projectListRevision: 20 };
  if (replay) rerender({ latestMessage: message });
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  if (!replay) rerender({ latestMessage: message });
  expect(first(result.current.projects)).toBe('older');
  expect(result.current.projects.find((p) => p.name === 'older')?.sessions?.[0].updated_at).toBe(iso(3000));
});

it('accepts unrelated HTTP data and session titles while protecting only the pending activity', async () => {
  const { result } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  const updated = [
    { ...projects[0], displayName: 'Updated other project' },
    { ...projects[1], sessions: [{ ...projects[1].sessions![0], id: 'web-s_1', title: 'Server title' }] },
  ];
  vi.mocked(api.projects).mockResolvedValue(response(updated, 20));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  expect(first(result.current.projects)).toBe('older');
  expect(result.current.projects[0].displayName).toBe('Updated other project');
  expect(result.current.projects[1].sessions?.[0]).toMatchObject({ title: 'Server title', updated_at: iso(3000) });
});

it('releases protection on server confirmation and permits subsequent deletion', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  const confirmed = [projects[0], { ...projects[1], lastActivity: 3200,
    sessions: [{ ...projects[1].sessions![0], updated_at: iso(3200), lastActivity: iso(3200) }] }];
  rerender({ latestMessage: { type: 'projects_updated', projects: confirmed, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(result.current.projects[1].lastActivity).toBe(3200);
  rerender({ latestMessage: { type: 'projects_updated', projects: [projects[0]], projectListRevision: 30 } });
  expect(result.current.projects.map((p) => p.name)).toEqual(['recent']);
});

it('rolls back a failed send without discarding newer metadata from the server', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  const updated = [projects[0], { ...projects[1], sessions: [{ ...projects[1].sessions![0], title: 'Renamed on server' }] }];
  rerender({ latestMessage: { type: 'projects_updated', projects: updated, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].sessions?.[0]).toMatchObject({ title: 'Renamed on server', updated_at: iso(1000) });
});

it('an earlier failure cannot undo a later activity bump in the same session', async () => {
  const { result } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  act(() => rollback?.());
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(4000));
  expect(first(result.current.projects)).toBe('older');
});

it('keeps a different session active when one pending send fails', async () => {
  const { result, rerender } = await setup();
  let rollback: (() => void) | undefined;
  act(() => { rollback = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_2', 'Second'); });
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  act(() => rollback?.());
  expect(result.current.projects[1].lastActivity).toBe(4000);
  expect(first(result.current.projects)).toBe('older');
});

it('falls back to a preceding unconfirmed send if a later send in the same session fails', async () => {
  const { result } = await setup();
  let earlier: (() => void) | undefined;
  let later: (() => void) | undefined;
  act(() => { earlier = result.current.bumpSessionActivity('older', 'web:s_1'); });
  vi.mocked(Date.now).mockReturnValue(4000);
  act(() => { later = result.current.bumpSessionActivity('older', 'web:s_1'); });
  act(() => later?.());
  expect(result.current.projects[1].sessions?.[0].updated_at).toBe(iso(3000));
  expect(first(result.current.projects)).toBe('older');
  act(() => earlier?.());
  expect(first(result.current.projects)).toBe('recent');
});

it('moves temporary activity to the real session id without duplicate rows', async () => {
  const { result, rerender } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-check', 'New'); });
  act(() => result.current.replaceOptimisticInProjects('web:s_2'));
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20 } });
  expect(result.current.projects[1].sessions?.filter((s) => s.id === 'web:s_2')).toHaveLength(1);
  expect(first(result.current.projects)).toBe('older');
});

it('removes failed temporary-session activity as well as its placeholder', async () => {
  const { result } = await setup();
  act(() => { result.current.bumpSessionActivity('older', 'new-session-check', 'New'); });
  act(() => result.current.dropOptimisticInProjects('new-session-check'));
  expect(first(result.current.projects)).toBe('recent');
  expect(result.current.projects[1].sessions).toHaveLength(1);
});

it('handles a transcript notification only once when selection state changes', async () => {
  const { result, rerender } = await setup();
  rerender({ latestMessage: { type: 'projects_updated', projects, projectListRevision: 20, changedFile: 'older/web-s_1.jsonl' } });
  const count = result.current.externalMessageUpdate;
  expect(count).toBe(1);
  act(() => { result.current.bumpSessionActivity('older', 'web:s_1'); });
  expect(result.current.externalMessageUpdate).toBe(count);
});
