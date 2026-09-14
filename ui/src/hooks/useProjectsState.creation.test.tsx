import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSocketMessage, Project } from '../types/app';
import { api } from '../utils/api';
import { useProjectsState } from './useProjectsState';

vi.mock('../utils/api', () => ({ api: { projects: vi.fn() } }));

const project = (name: string, revision?: number): Project => ({
  name, displayName: name, fullPath: `/workspace/${name}`,
  lastActivity: 100, projectListRevision: revision,
});

function response(projects: Project[], revision: number) {
  return new Response(JSON.stringify(projects), {
    headers: { 'X-Projects-Revision': String(revision) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderProjects() {
  const navigate = vi.fn();
  const activeSessions = new Set<string>();
  return renderHook(({ latestMessage }: { latestMessage: AppSocketMessage | null }) => useProjectsState({
    navigate, activeSessions, isMobile: false, latestMessage,
  }), { initialProps: { latestMessage: null } as { latestMessage: AppSocketMessage | null } });
}

describe('new project visibility', () => {
  beforeEach(() => {
    vi.mocked(api.projects).mockReset();
    localStorage.clear();
  });
  afterEach(cleanup);

  it('inserts into a large sidebar immediately without another list request', async () => {
    const existing = Array.from({ length: 250 }, (_, i) => project(`existing-${i}`));
    vi.mocked(api.projects).mockResolvedValue(response(existing, 10));
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(250));

    act(() => result.current.addCreatedProject(project('new', 20)));

    expect(result.current.projects).toHaveLength(251);
    expect(result.current.projects[0]).toMatchObject({
      name: 'new', sessions: [], sessionMeta: { total: 0, hasMore: false },
    });
    expect(api.projects).toHaveBeenCalledTimes(1);
  });

  it('keeps the project when an older HTTP scan finishes after creation', async () => {
    const pending = deferred<Response>();
    vi.mocked(api.projects).mockReturnValue(pending.promise);
    const { result } = renderProjects();
    act(() => result.current.addCreatedProject(project('new', 20)));

    await act(async () => { pending.resolve(response([], 10)); });

    expect(result.current.projects.map((p) => p.name)).toEqual(['new']);
    expect(result.current.isLoadingProjects).toBe(false);
  });

  it('rejects old socket snapshots, accepts enrichment, and allows later deletion', async () => {
    vi.mocked(api.projects).mockResolvedValue(response([], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    act(() => result.current.addCreatedProject(project('new', 20)));

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 15 } });
    expect(result.current.projects).toHaveLength(1);

    const enriched = { ...project('new'), sessions: [{ id: 'real-session', title: 'Hello' }] };
    rerender({ latestMessage: { type: 'projects_updated', projects: [enriched], projectListRevision: 30 } });
    expect(result.current.projects[0].sessions?.[0].id).toBe('real-session');

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 25 } });
    expect(result.current.projects).toHaveLength(1);

    rerender({ latestMessage: { type: 'projects_updated', projects: [], projectListRevision: 40 } });
    expect(result.current.projects).toEqual([]);
  });

  it('does not let a delayed HTTP response undo an acknowledged socket update', async () => {
    vi.mocked(api.projects).mockResolvedValueOnce(response([], 10));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    const pending = deferred<Response>();
    vi.mocked(api.projects).mockReturnValueOnce(pending.promise);
    let refresh!: Promise<Project[] | null>;
    act(() => { refresh = result.current.fetchProjects({ showLoadingState: false }); });
    act(() => result.current.addCreatedProject(project('new', 20)));
    rerender({ latestMessage: { type: 'projects_updated', projects: [project('new')], projectListRevision: 30 } });

    await act(async () => {
      pending.resolve(response([], 15));
      await refresh;
    });
    expect(result.current.projects.map((p) => p.name)).toEqual(['new']);
  });

  it('deduplicates a registration and preserves sessions already loaded by the watcher', async () => {
    const existing = {
      ...project('existing'), lastActivity: 500,
      sessions: [{ id: 'session-1', title: 'Existing conversation' }],
      sessionMeta: { total: 8, hasMore: true },
    };
    vi.mocked(api.projects).mockResolvedValue(response([existing], 30));
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => result.current.addCreatedProject(project('existing', 20)));

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0]).toMatchObject({
      sessions: existing.sessions, sessionMeta: existing.sessionMeta, lastActivity: 500,
    });
  });

  it('still delivers transcript changes when their accompanying list is outdated', async () => {
    const existing = { ...project('existing'), sessions: [{ id: 'session-1', title: 'Hello' }] };
    vi.mocked(api.projects).mockResolvedValue(response([existing], 30));
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => {
      result.current.setSelectedProject(existing);
      result.current.handleSessionSelect(existing.sessions[0]);
    });
    const previousUpdates = result.current.externalMessageUpdate;
    rerender({ latestMessage: {
      type: 'projects_updated', projects: [], projectListRevision: 20,
      changedFile: 'existing/session-1.jsonl',
    } });
    expect(result.current.externalMessageUpdate).toBe(previousUpdates + 1);
    expect(result.current.projects).toHaveLength(1);
  });
});
