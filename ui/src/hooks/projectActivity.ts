import type { Project, ProjectSession } from '../types/app';

export const activityTime = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;
const sessionTime = (session?: ProjectSession) => Math.max(
  activityTime(session?.lastActivity), activityTime(session?.updated_at),
);
const normalizedId = (id: string) => id.replace(/^web:s_/, 'web-s_');

type Activity = {
  projectName: string;
  sessionId: string;
  at: number;
  baseProjectActivity: unknown;
  baseSession?: ProjectSession;
};

/** Protect only unconfirmed activity; other snapshot fields remain authoritative. */
export class ProjectActivity {
  private pending = new Set<Activity>();

  begin(project: Project, sessionId: string, at: number) {
    const sameProject = [...this.pending].filter((entry) => entry.projectName === project.name);
    const previous = sameProject.find((entry) => normalizedId(entry.sessionId) === normalizedId(sessionId));
    const entry: Activity = {
      projectName: project.name, sessionId, at,
      baseProjectActivity: sameProject[0]?.baseProjectActivity ?? project.lastActivity,
      baseSession: previous ? previous.baseSession : project.sessions?.find((s) => normalizedId(s.id) === normalizedId(sessionId)),
    };
    this.pending.add(entry);
    return entry;
  }

  merge(snapshot: Project[], current: Project[]): Project[] {
    if (this.pending.size === 0) return snapshot;
    const currentByName = new Map(current.map((project) => [project.name, project]));
    return snapshot.map((project) => {
      const entries = [...this.pending].filter((entry) => entry.projectName === project.name);
      let sessions = project.sessions ?? [];
      let lastActivity = activityTime(project.lastActivity);
      let protectedActivity = false;
      for (const entry of entries) {
        const serverSession = project.sessions?.find((s) => normalizedId(s.id) === normalizedId(entry.sessionId));
        if (sessionTime(serverSession) >= entry.at) {
          this.pending.delete(entry);
          continue;
        }
        entry.baseProjectActivity = project.lastActivity;
        if (serverSession) entry.baseSession = serverSession;
        const session = serverSession ?? currentByName.get(project.name)?.sessions?.find((s) => normalizedId(s.id) === normalizedId(entry.sessionId));
        if (!session) continue;
        const pendingAt = Math.max(...entries.filter((item) => normalizedId(item.sessionId) === normalizedId(entry.sessionId)).map((item) => item.at));
        const bumped = { ...session, updated_at: new Date(pendingAt).toISOString(), lastActivity: new Date(pendingAt).toISOString() };
        sessions = [bumped, ...sessions.filter((s) => normalizedId(s.id) !== normalizedId(entry.sessionId))];
        lastActivity = Math.max(lastActivity, entry.at);
        protectedActivity = true;
      }
      if (!protectedActivity) return project;
      return { ...project, lastActivity, sessions: sessions.sort((a, b) => sessionTime(b) - sessionTime(a)) };
    });
  }

  cancel(entry: Activity): ((project: Project) => Project) | undefined {
    // A failed earlier attempt must not undo a later send or acknowledged activity.
    if (!this.pending.delete(entry)) return;
    return (project) => {
      if (project.name !== entry.projectName) return project;
      const sessions = (project.sessions ?? []).flatMap((session) => {
        if (normalizedId(session.id) !== normalizedId(entry.sessionId) || sessionTime(session) !== entry.at) return [session];
        const remaining = [...this.pending].filter((item) => item.projectName === entry.projectName && normalizedId(item.sessionId) === normalizedId(entry.sessionId));
        if (remaining.length > 0) {
          const at = Math.max(...remaining.map((item) => item.at));
          return [{ ...session, updated_at: new Date(at).toISOString(), lastActivity: new Date(at).toISOString() }];
        }
        return entry.baseSession ? [{ ...session, updated_at: entry.baseSession.updated_at, lastActivity: entry.baseSession.lastActivity }] : [];
      });
      return {
        ...project,
        sessions,
        lastActivity: Math.max(activityTime(entry.baseProjectActivity), ...sessions.map(sessionTime)),
        sessionMeta: {
          ...project.sessionMeta,
          total: typeof project.sessionMeta?.total === 'number'
            ? Math.max(0, project.sessionMeta.total - ((project.sessions?.length ?? 0) - sessions.length))
            : project.sessionMeta?.total,
        },
      };
    };
  }

  replaceTemporarySession(realSessionId: string) {
    for (const entry of this.pending) {
      if (entry.sessionId.startsWith('new-session-')) entry.sessionId = realSessionId;
    }
  }

  cancelSession(sessionId: string) {
    const rollbacks = [...this.pending]
      .filter((entry) => normalizedId(entry.sessionId) === normalizedId(sessionId))
      .map((entry) => this.cancel(entry));
    return (project: Project) => rollbacks.reduce((value, rollback) => rollback ? rollback(value) : value, project);
  }

  remove(projectName?: string, sessionId?: string) {
    for (const entry of this.pending) {
      if ((!projectName || entry.projectName === projectName)
        && (!sessionId || normalizedId(entry.sessionId) === normalizedId(sessionId))) this.pending.delete(entry);
    }
  }
}
