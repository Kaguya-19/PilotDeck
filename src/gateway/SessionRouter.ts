import {
  AgentFactoryProvider,
  AgentRegistry,
  type AgentHandle,
  type AgentSession,
} from "../agent/index.js";
import type { CanonicalMessage } from "../model/index.js";
import type { AgentCancelSteerResult, AgentSteerResult } from "../agent/session/SteerMailbox.js";
import type { ManualCompactionResult } from "../agent/session/ManualCompactionController.js";
import type { GatewaySessionInfo, ListSessionsInput, ListSessionsResult } from "./protocol/types.js";
import type { AgentStatusMessageInput } from "../session/transcript/TranscriptWriter.js";

export type GatewaySessionContext = {
  sessionKey: string;
  projectKey?: string;
  channelKey: string;
};

export type GatewaySessionFactory = (
  context: GatewaySessionContext,
) => AgentSession | AgentHandle | Promise<AgentSession | AgentHandle>;
export type GatewaySessionRecreator = (
  context: GatewaySessionContext,
  previousSession: AgentSession,
) => AgentSession | AgentHandle | Promise<AgentSession | AgentHandle>;
export type GatewaySessionSetup = (
  context: GatewaySessionContext,
  handle: AgentHandle,
  previousSession?: AgentSession,
) => void | Promise<void>;

export type SessionRouterOptions = {
  /** Shared live-agent directory used by scoped consumers such as continuation managers. */
  agents?: AgentRegistry;
  createSession: GatewaySessionFactory;
  recreateSession?: GatewaySessionRecreator;
  setupSession?: GatewaySessionSetup;
  listSessions?: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  idleSessionTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  now?: () => Date;
  /**
   * Called (fire-and-forget) when a session is evicted from the router —
   * idle sweep, explicit close, or dirty-recreate. Use this to clean up
   * per-session resources (e.g. per-session MCP runtimes / browser processes).
   */
  onSessionEvict?: (sessionKey: string) => void;
  onSessionIdleEvict?: (sessionKey: string, record: SessionEvictionSnapshot) => void;
};

type SessionRecord = {
  handle: AgentHandle;
  lastUsedAt: number;
  context: GatewaySessionContext;
  dirtyReason?: string;
};

export type SessionEvictionSnapshot = {
  sessionKey: string;
  lastUsedAt: number;
  context: GatewaySessionContext;
  messageCount?: number;
};

export type SessionRouterStatusAppendResult =
  | { owner: "live"; recorded: boolean }
  | { owner: "not_live"; recorded: false };

const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

export class SessionRouter {
  private readonly sessions = new Map<string, SessionRecord>();
  readonly agents: AgentRegistry;
  private readonly agentFactory: AgentFactoryProvider;
  private readonly inFlightTurns = new Map<string, string>();
  /** Gateway admission reservation for a session-owned non-turn operation. */
  private readonly inFlightMaintenance = new Set<string>();
  private readonly pendingEvictions = new Set<Promise<void>>();
  /** Agent publication that started before stop-new and must drain on shutdown. */
  private readonly pendingSessionCreations = new Set<Promise<void>>();
  private readonly idleSessionTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  private readonly now: () => Date;
  private readonly idleSweepTimer?: ReturnType<typeof setInterval>;
  private isShutdown = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: SessionRouterOptions) {
    this.agents = options.agents ?? new AgentRegistry({ name: "gateway-agents" });
    this.agentFactory = new AgentFactoryProvider({ registry: this.agents });
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
    this.idleSweepIntervalMs = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    if (this.idleSweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => this.sweepIdle(), this.idleSweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async getOrCreate(context: GatewaySessionContext): Promise<AgentHandle> {
    if (this.isShutdown) {
      throw new Error("Session router is shut down.");
    }
    const operation = this.getOrCreateActive(context);
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingSessionCreations.add(tracked);
    try {
      return await operation;
    } finally {
      this.pendingSessionCreations.delete(tracked);
    }
  }

  private async getOrCreateActive(context: GatewaySessionContext): Promise<AgentHandle> {
    this.sweepIdle();
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      cached.context = mergeSessionContext(cached.context, context);
      if (cached.dirtyReason && this.options.recreateSession) {
        const previousSession = cached.handle.session;
        const previousRecord: SessionRecord = {
          ...cached,
          context: { ...cached.context },
        };
        const replacement = await this.agentFactory.replace(
          context.sessionKey,
          () => this.options.recreateSession!(cached.context, previousSession),
          {
            setup: this.options.setupSession
              ? (handle) => this.options.setupSession!(cached.context, handle, previousSession)
              : undefined,
          },
        );
        if (this.isShutdown) {
          await replacement.handle.dispose("session_router_shutdown");
          await replacement.previousDisposed;
          throw new Error("Session router shut down during session recreation.");
        }
        cached.handle = replacement.handle;
        cached.dirtyReason = undefined;
        this.emitSessionEvict(context.sessionKey, previousRecord, "dirty_recreate");
        await replacement.previousDisposed;
      }
      cached.lastUsedAt = this.nowMs();
      return cached.handle;
    }

    const handle = await this.agentFactory.create(
      context.sessionKey,
      () => this.options.createSession(context),
      {
        setup: this.options.setupSession
          ? (createdHandle) => this.options.setupSession!(context, createdHandle)
          : undefined,
      },
    );
    if (this.isShutdown) {
      await handle.dispose("session_router_shutdown");
      throw new Error("Session router shut down during session creation.");
    }
    this.sessions.set(context.sessionKey, {
      handle,
      lastUsedAt: this.nowMs(),
      context,
    });
    return handle;
  }

  beginTurn(sessionKey: string, runId: string): boolean {
    if (this.isShutdown) return false;
    this.sweepIdle();
    if (this.inFlightTurns.has(sessionKey) || this.inFlightMaintenance.has(sessionKey)) {
      return false;
    }
    this.inFlightTurns.set(sessionKey, runId);
    return true;
  }

  hasActiveTurn(sessionKey: string): boolean {
    return this.inFlightTurns.has(sessionKey);
  }

  activeTurnRunId(sessionKey: string): string | undefined {
    return this.inFlightTurns.get(sessionKey);
  }

  endTurn(sessionKey: string, runId?: string): void {
    const record = this.sessions.get(sessionKey);
    const inFlightRunId = this.inFlightTurns.get(sessionKey);
    if (!runId || inFlightRunId === runId) {
      this.inFlightTurns.delete(sessionKey);
    }
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  async abort(sessionKey: string, reason?: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    record?.handle.abort(reason);
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  /**
   * Route an idle-only maintenance command to the single live session owner.
   * This deliberately does not allocate a new session: `/compact` operates on
   * existing durable history and must not manufacture an empty transcript.
   */
  async compact(sessionKey: string, options: { abortSignal?: AbortSignal; turnId?: string } = {}): Promise<ManualCompactionResult> {
    if (this.isShutdown) {
      throw new Error("Session router is shut down.");
    }
    if (this.inFlightTurns.has(sessionKey) || this.inFlightMaintenance.has(sessionKey)) {
      throw new Error("Session has an active turn.");
    }
    const record = this.sessions.get(sessionKey);
    if (!record) {
      throw new Error("Session is not available for manual compaction.");
    }
    record.lastUsedAt = this.nowMs();
    this.inFlightMaintenance.add(sessionKey);
    try {
      return await record.handle.compact(options);
    } finally {
      this.inFlightMaintenance.delete(sessionKey);
      const current = this.sessions.get(sessionKey);
      if (current === record) current.lastUsedAt = this.nowMs();
    }
  }

  async steer(
    sessionKey: string,
    input: { turnId: string; itemId: string; message: CanonicalMessage; allowedReadFiles?: string[] },
  ): Promise<AgentSteerResult> {
    const record = this.sessions.get(sessionKey);
    if (!record) return { accepted: false, reason: "no_active_turn" };
    record.lastUsedAt = this.nowMs();
    return record.handle.steer(input);
  }

  async cancelSteer(
    sessionKey: string,
    input: { turnId: string; itemId: string },
  ): Promise<AgentCancelSteerResult> {
    const record = this.sessions.get(sessionKey);
    if (!record) return { cancelled: false, reason: "no_active_turn" };
    record.lastUsedAt = this.nowMs();
    return record.handle.cancelSteer(input);
  }

  async close(sessionKey: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    if (record && this.sessions.delete(sessionKey)) {
      try {
        await this.beginEviction(sessionKey, record, "closed");
      } finally {
        this.inFlightTurns.delete(sessionKey);
      }
    }
  }

  markAllDirty(reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  markProjectDirty(projectKey: string, reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.context.projectKey !== projectKey) {
        continue;
      }
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  async list(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    if (this.options.listSessions) {
      return this.options.listSessions(input);
    }

    return {
      sessions: [...this.sessions.entries()].map(([sessionKey, record]): GatewaySessionInfo => {
        const snapshot = record.handle.snapshot();
        return {
          sessionId: snapshot.sessionId,
          sessionKey,
          summary: snapshot.messages
            .flatMap((message) => message.content)
            .find((block) => block.type === "text")
            ?.text ?? sessionKey,
          lastModified: record.lastUsedAt,
        };
      }),
    };
  }

  sessionCount(): number {
    this.sweepIdle();
    return this.sessions.size;
  }

  cachedSessionCount(): number {
    return this.sessions.size;
  }

  snapshotSession(sessionKey: string): ReturnType<AgentSession["snapshot"]> | undefined {
    return this.sessions.get(sessionKey)?.handle.snapshot();
  }

  /**
   * Route a status append to the exact live AgentSession writer. The caller
   * can use the `not_live` result to select a cold-history fallback, but must
   * not create a second writer while this session remains published.
   */
  async recordAgentStatusMessage(
    sessionKey: string,
    turnId: string,
    status: AgentStatusMessageInput,
  ): Promise<SessionRouterStatusAppendResult> {
    const record = this.sessions.get(sessionKey);
    if (!record) return { owner: "not_live", recorded: false };
    record.lastUsedAt = this.nowMs();
    return {
      owner: "live",
      recorded: await record.handle.session.recordAgentStatusMessage(turnId, status),
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShutdown = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    const records = [...this.sessions];
    this.sessions.clear();
    this.inFlightTurns.clear();
    this.inFlightMaintenance.clear();
    this.shutdownPromise = this.finishShutdown(records);
    return this.shutdownPromise;
  }

  private async finishShutdown(records: Array<[string, SessionRecord]>): Promise<void> {
    // No new getOrCreate() may start after isShutdown. Wait for every
    // publication that began before stop-new so a late factory result cannot
    // publish a live agent after agentFactory.dispose().
    await Promise.allSettled([...this.pendingSessionCreations]);
    const evictions = records.map(([sessionKey, record]) =>
      this.beginEviction(sessionKey, record, "shutdown")
    );
    const providerResults = await Promise.allSettled([
      ...new Set([...this.pendingEvictions, ...evictions]),
      this.agentFactory.dispose(),
    ]);
    const registryResults = await Promise.allSettled([this.agents.dispose()]);
    const errors = [...providerResults, ...registryResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to shut down all agent sessions.");
    }
  }

  /**
   * Returns true when at least one *user* turn (not always-on / cron) is
   * in flight for the given project.  Used by the Always-On scheduler to
   * implement the `agent_busy` gate.
   */
  hasActiveUserTurn(projectKey: string): boolean {
    for (const [sessionKey] of this.inFlightTurns) {
      if (sessionKey.startsWith("always-on/")) continue;
      if (sessionKey.startsWith("cron:")) continue;
      const record = this.sessions.get(sessionKey);
      if (record?.context.projectKey === projectKey) return true;
    }
    return false;
  }

  private sweepIdle(): void {
    if (this.isShutdown) return;
    const now = this.nowMs();
    for (const [sessionKey, record] of this.sessions) {
      if (this.inFlightTurns.has(sessionKey) || this.inFlightMaintenance.has(sessionKey)) {
        continue;
      }
      if (now - record.lastUsedAt > this.idleSessionTimeoutMs) {
        this.sessions.delete(sessionKey);
        void this.beginEviction(sessionKey, record, "idle").catch((error) => {
          console.warn(`[pilotdeck] failed to dispose idle session ${sessionKey}:`, error);
        });
      }
    }
  }

  private beginEviction(
    sessionKey: string,
    record: SessionRecord,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): Promise<void> {
    const eviction = (async () => {
      try {
        await this.agentFactory.remove(sessionKey, `session_${reason}`);
      } finally {
        this.emitSessionEvict(sessionKey, record, reason);
      }
    })();
    this.pendingEvictions.add(eviction);
    void eviction.then(
      () => this.pendingEvictions.delete(eviction),
      () => this.pendingEvictions.delete(eviction),
    );
    return eviction;
  }

  private emitSessionEvict(
    sessionKey: string,
    record: SessionRecord,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): void {
    this.options.onSessionEvict?.(sessionKey);
    if (reason === "idle") {
      this.options.onSessionIdleEvict?.(sessionKey, snapshotEvictedSession(sessionKey, record));
    }
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

function snapshotEvictedSession(sessionKey: string, record: SessionRecord): SessionEvictionSnapshot {
  let messageCount: number | undefined;
  try {
    messageCount = record.handle.snapshot().messages.length;
  } catch {
    messageCount = undefined;
  }
  return {
    sessionKey,
    lastUsedAt: record.lastUsedAt,
    context: { ...record.context },
    ...(messageCount !== undefined ? { messageCount } : {}),
  };
}

function mergeSessionContext(
  current: GatewaySessionContext,
  next: GatewaySessionContext,
): GatewaySessionContext {
  return {
    sessionKey: next.sessionKey,
    channelKey: next.channelKey || current.channelKey,
    projectKey: current.projectKey ?? next.projectKey,
  };
}
