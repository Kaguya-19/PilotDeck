import { describe, expect, it } from 'vitest';
import type { Project } from '../types/app';
import {
  applyProjectsSocketUpdate,
  preserveLoadedSessions,
  projectsHaveChanges,
} from './useProjectsState';

function makeProject(name: string, overrides: Partial<Project> = {}): Project {
  return {
    name,
    displayName: name,
    fullPath: `/tmp/${name}`,
    sessions: [
      {
        id: 'web:s_1',
        title: 'Session 1',
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('applyProjectsSocketUpdate', () => {
  it('returns the same array reference when the socket payload is unchanged', () => {
    const prev = [makeProject('alpha')];
    const next = [makeProject('alpha')];

    const mergedOnce = applyProjectsSocketUpdate(prev, next);
    const mergedTwice = applyProjectsSocketUpdate(mergedOnce, next);

    expect(mergedTwice).toBe(prev);
  });

  it('returns a new reference when a project field changes', () => {
    const prev = [makeProject('alpha')];
    const next = [
      makeProject('alpha', {
        sessions: [
          {
            id: 'web:s_1',
            title: 'Session 1',
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-29T12:00:00.000Z',
          },
        ],
      }),
    ];

    const merged = applyProjectsSocketUpdate(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged[0]?.sessions?.[0]?.updated_at).toBe('2026-05-29T12:00:00.000Z');
  });

  it('preserves optimistic new-session placeholders across updates', () => {
    const prev = [
      makeProject('alpha', {
        sessions: [
          {
            id: 'new-session-123',
            title: 'New session',
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
          },
        ],
      }),
    ];
    const next = [makeProject('alpha')];

    const merged = applyProjectsSocketUpdate(prev, next);
    const placeholder = merged[0]?.sessions?.find((s) => s.id === 'new-session-123');

    expect(placeholder?.title).toBe('New session');
  });
});

describe('projectsHaveChanges', () => {
  it('detects no changes for structurally equal projects', () => {
    const a = [makeProject('alpha')];
    const b = [makeProject('alpha')];
    expect(projectsHaveChanges(a, b, true)).toBe(false);
  });

  it('ignores unsupported project metadata', () => {
    const previous = [makeProject('alpha', { obsoleteMetadata: { enabled: false } })];
    const next = [makeProject('alpha', { obsoleteMetadata: { enabled: true } })];

    expect(projectsHaveChanges(previous, next, true)).toBe(false);
  });
});

describe('preserveLoadedSessions', () => {
  it('keeps loaded sessions when the server preview is shorter', () => {
    const prev = [
      makeProject('alpha', {
        sessions: Array.from({ length: 8 }, (_, index) => ({
          id: `web:s_${index}`,
          title: `Session ${index}`,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
        })),
        sessionMeta: { total: 8, hasMore: false },
      }),
    ];
    const next = [
      makeProject('alpha', {
        sessions: prev[0].sessions?.slice(0, 5),
        sessionMeta: { total: 8, hasMore: true },
      }),
    ];

    const merged = preserveLoadedSessions(prev, next);

    expect(merged[0]?.sessions?.length).toBe(8);
  });
});
