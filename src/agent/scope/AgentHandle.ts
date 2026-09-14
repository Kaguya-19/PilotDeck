import { randomUUID } from "node:crypto";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSession, AgentSessionRuntimeReloadSnapshot } from "../session/AgentSession.js";
import type { AgentCancelSteerResult, AgentSteerResult } from "../session/SteerMailbox.js";
import type { AgentQueuedTurn } from "../session/AgentTurnInbox.js";
import type { ManualCompactionResult } from "../session/ManualCompactionController.js";

export type AgentHandleState = "active" | "draining" | "disposed";

export type AgentHandleOptions = {
  onDispose?: () => void | Promise<void>;
  /**
   * Runs after the handle crosses the admission cutoff and before its owned
   * resources are drained. Scoped owners use this to propagate teardown to
   * dynamically-owned descendants.
   */
  onDisposeStart?: (reason: string) => void | Promise<void>;
  uuid?: () => string;
  onQueuedTurnError?: (error: unknown, turn: AgentQueuedTurn) => void | Promise<void>;
};

export type AgentFollowupOptions = AgentSubmitOptions & {
  itemId?: string;
  /** Owns admission only; cancellation after durable enqueue does not retract accepted input. */
  abortSignal?: AbortSignal;
  /** Revalidates transient caller authority at the durable enqueue boundary. */
  authorizeAdmission?: () => void;
};

/** An idle-only operation owned by a live agent rather than a user turn. */
export type AgentMaintenanceTask<Result> = (signal: AbortSignal) => Promise<Result>;

export type AgentCompactOptions = {
  abortSignal?: AbortSignal;
  turnId?: string;
};

export class AgentHandle {
  private handleState: AgentHandleState = "active";
  private activeRuns = 0;
  private idlePromise?: Promise<void>;
  private resolveIdle?: () => void;
  private activeRunIdlePromise?: Promise<void>;
  private resolveActiveRunIdle?: () => void;
  private disposePromise?: Promise<void>;
  private queuedPumpPromise?: Promise<void>;
  private queuedPumpBlocked = false;
  private maintenanceReserved = false;
  private maintenanceController?: AbortController;
  private admissionTail: Promise<void> = Promise.resolve();
  private readonly disposeStartListeners = new Set<(reason: string) => void | Promise<void>>();

  constructor(
    readonly session: AgentSession,
    private readonly options: AgentHandleOptions = {},
  ) {}

  get state(): AgentHandleState {
    return this.handleState;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get inFlight(): number {
    return this.activeRuns;
  }

  async *submit(
    input: AgentInput,
    submitOptions: AgentSubmitOptions = {},
  ): AsyncGenerator<AgentEvent, void, unknown> {
    this.assertActive("submit a turn");
    if (this.activeRuns > 0 || this.pendingTurnCount() > 0 || this.queuedPumpPromise || this.maintenanceReserved) {
      throw new Error("Agent handle already has an active turn.");
    }

    this.activeRuns += 1;
    try {
      yield* this.session.submit(input, submitOptions);
    } finally {
      this.releaseRun();
    }
  }

  /**
   * Durably admit one ordinary next-turn input and wake this agent's owner.
   * The returned id identifies admission only; it is not a result handle.
   */
  async followup(
    input: AgentInput,
    options: AgentFollowupOptions = {},
  ): Promise<{ itemId: string; turnId: string }> {
    this.assertActive("enqueue a follow-up turn");
    const {
      itemId: requestedItemId,
      turnId: requestedTurnId,
      abortSignal,
      authorizeAdmission,
      ...submitOptions
    } = options;
    throwIfAdmissionAborted(abortSignal);
    authorizeAdmission?.();
    const itemId = requestedItemId ?? this.nextId();
    const turnId = requestedTurnId ?? this.nextId();
    return this.enqueueAdmission(async () => {
      this.assertActive("enqueue a follow-up turn");
      throwIfAdmissionAborted(abortSignal);
      authorizeAdmission?.();
      const turn: AgentQueuedTurn = { itemId, turnId, input, submitOptions };
      await this.session.enqueueTurn(turn);
      this.queuedPumpBlocked = false;
      this.startQueuedPump();
      return { itemId, turnId };
    });
  }

  pendingTurns(): readonly AgentQueuedTurn[] {
    return this.session.pendingTurns();
  }

  /**
   * Reserve the next admission slot for a non-turn maintenance operation.
   * Ordinary follow-ups admitted after this call remain FIFO behind it; a
   * direct turn or a second maintenance request is rejected while it owns the
   * idle slot. Disposal and `abort()` cancel the task through its owned signal.
   */
  runMaintenance<Result>(task: AgentMaintenanceTask<Result>): Promise<Result> {
    this.assertActive("run maintenance");
    if (!this.isIdle() || this.maintenanceReserved) {
      throw new Error("Agent handle is not idle for maintenance.");
    }
    this.maintenanceReserved = true;
    const controller = new AbortController();
    // Publish cancellation ownership before waiting on admissionTail. A
    // concurrent abort/dispose must cancel a reserved maintenance task even
    // when an earlier admission is still draining.
    this.maintenanceController = controller;
    return this.enqueueAdmission(async () => {
      try {
        this.assertActive("run maintenance");
        if (this.activeRuns > 0 || this.pendingTurnCount() > 0 || this.queuedPumpPromise) {
          throw new Error("Agent handle is not idle for maintenance.");
        }
        throwIfAdmissionAborted(controller.signal);
        return await task(controller.signal);
      } finally {
        if (this.maintenanceController === controller) {
          this.maintenanceController = undefined;
        }
        this.maintenanceReserved = false;
        this.notifyIdle();
      }
    });
  }

  /** Run the session-owned manual compaction consumer in the reserved idle slot. */
  compact(options: AgentCompactOptions = {}): Promise<ManualCompactionResult> {
    const turnId = options.turnId ?? this.nextId();
    return this.runMaintenance(async (maintenanceSignal) => {
      const abortSignal = options.abortSignal
        ? AbortSignal.any([maintenanceSignal, options.abortSignal])
        : maintenanceSignal;
      return this.session.compact({ abortSignal, turnId });
    });
  }

  discardQueuedTurn(itemId: string): Promise<boolean> {
    if (this.handleState !== "active") return Promise.resolve(false);
    return this.enqueueAdmission(() => this.session.discardQueuedTurn(itemId, "cancelled"));
  }

  abort(reason?: string): void {
    if (this.handleState === "disposed") return;
    this.maintenanceController?.abort(reason);
    this.session.abort(reason);
  }

  steer(input: {
    turnId: string;
    itemId: string;
    message: CanonicalMessage;
    allowedReadFiles?: string[];
  }): Promise<AgentSteerResult> {
    if (this.handleState !== "active") {
      return Promise.resolve({ accepted: false, reason: "no_active_turn" });
    }
    return this.session.steer(input);
  }

  cancelSteer(input: { turnId: string; itemId: string }): Promise<AgentCancelSteerResult> {
    if (this.handleState !== "active") {
      return Promise.resolve({ cancelled: false, reason: "no_active_turn" });
    }
    return this.session.cancelSteer(input);
  }

  snapshot(): ReturnType<AgentSession["snapshot"]> {
    return this.session.snapshot();
  }

  snapshotForRuntimeReload(): AgentSessionRuntimeReloadSnapshot {
    return this.session.snapshotForRuntimeReload();
  }

  async *replay(): AsyncGenerator<AgentEvent, void, unknown> {
    yield* this.session.replay();
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    if (!this.idlePromise) {
      this.idlePromise = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    return this.idlePromise;
  }

  /**
   * Register a teardown propagation hook. The hook runs once, after this
   * handle becomes non-admitting and before its own queues/resources drain.
   * This is intentionally a small lifecycle seam rather than exposing the
   * handle's internals to composition code.
   */
  addDisposeStartListener(listener: (reason: string) => void | Promise<void>): () => void {
    if (this.handleState !== "active") {
      void Promise.resolve(listener("agent_handle_already_disposing")).catch(() => undefined);
      return () => undefined;
    }
    this.disposeStartListeners.add(listener);
    return () => this.disposeStartListeners.delete(listener);
  }

  dispose(reason = "agent_handle_disposed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.handleState = "draining";
    this.disposePromise = this.finishDispose(reason);
    return this.disposePromise;
  }

  private async finishDispose(reason: string): Promise<void> {
    const errors: unknown[] = [];
    const disposeStart = [
      ...(this.options.onDisposeStart ? [this.options.onDisposeStart] : []),
      ...this.disposeStartListeners,
    ];
    // Preserve the historic synchronous abort cutoff when nobody registered a
    // descendant owner. A needless await here would let an active turn advance
    // before this handle's cancellation is observed.
    if (disposeStart.length > 0) {
      const startResults = await Promise.allSettled(disposeStart.map((listener) => listener(reason)));
      for (const result of startResults) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    }
    if (this.maintenanceReserved) {
      this.maintenanceController?.abort(reason);
    }
    if (this.activeRuns > 0) {
      try {
        this.session.abort(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.admissionTail;
    if (typeof this.session.discardQueuedTurns === "function") {
      try {
        await this.session.discardQueuedTurns("agent_disposed");
      } catch (error) {
        errors.push(error);
      }
    }

    await this.waitForNoActiveRun();
    await this.queuedPumpPromise;
    try {
      await this.options.onDispose?.();
    } catch (error) {
      errors.push(error);
    } finally {
      this.handleState = "disposed";
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose agent handle.");
    }
  }

  private startQueuedPump(): void {
    if (this.queuedPumpPromise !== undefined || this.queuedPumpBlocked) return;
    this.queuedPumpPromise = this.runQueuedPump().finally(() => {
      this.queuedPumpPromise = undefined;
      if (
        this.pendingTurnCount() > 0
        && this.handleState === "active"
        && !this.queuedPumpBlocked
      ) this.startQueuedPump();
      this.notifyIdle();
    });
  }

  private async runQueuedPump(): Promise<void> {
    while (this.handleState === "active") {
      if (this.activeRuns > 0) {
        await this.waitForNoActiveRun();
        continue;
      }
      let turn: AgentQueuedTurn | undefined;
      let iterator: AsyncGenerator<AgentEvent, void, unknown> | undefined;
      try {
        const started = await this.enqueueAdmission(async () => {
          if (this.handleState !== "active") return undefined;
          const next = this.session.pendingTurns()[0];
          if (!next) return undefined;
          turn = next;
          this.activeRuns += 1;
          const stream = this.session.submitQueuedTurn(next);
          try {
            const first = await stream.next();
            return { turn: next, stream, first };
          } catch (error) {
            this.releaseRun();
            throw error;
          }
        });
        if (!started) return;
        turn = started.turn;
        iterator = started.stream;
        while (!(await iterator.next()).done) {
          // Follow-up has admission semantics, not a second result stream.
        }
      } catch (error) {
        try {
          if (turn) await this.options.onQueuedTurnError?.(error, turn);
        } catch {
          // Diagnostics cannot change queue ownership or turn settlement.
        }
        this.queuedPumpBlocked = true;
        return;
      } finally {
        if (iterator) this.releaseRun();
      }
    }
  }

  private releaseRun(): void {
    this.activeRuns -= 1;
    if (this.activeRuns === 0) {
      this.resolveActiveRunIdle?.();
      this.resolveActiveRunIdle = undefined;
      this.activeRunIdlePromise = undefined;
    }
    this.notifyIdle();
  }

  private waitForNoActiveRun(): Promise<void> {
    if (this.activeRuns === 0) return Promise.resolve();
    if (!this.activeRunIdlePromise) {
      this.activeRunIdlePromise = new Promise<void>((resolve) => {
        this.resolveActiveRunIdle = resolve;
      });
    }
    return this.activeRunIdlePromise;
  }

  private isIdle(): boolean {
    return this.activeRuns === 0
      && this.pendingTurnCount() === 0
      && this.queuedPumpPromise === undefined
      && !this.maintenanceReserved;
  }

  private pendingTurnCount(): number {
    return typeof this.session.pendingTurnCount === "number" ? this.session.pendingTurnCount : 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    this.resolveIdle?.();
    this.resolveIdle = undefined;
    this.idlePromise = undefined;
  }

  private enqueueAdmission<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.admissionTail.then(operation, operation);
    this.admissionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }

  private assertActive(action: string): void {
    if (this.handleState !== "active") {
      throw new Error(`Cannot ${action}; agent handle is ${this.handleState}.`);
    }
  }
}

function throwIfAdmissionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error(`Agent follow-up admission aborted: ${String(signal.reason ?? "aborted")}`);
}

export function asAgentHandle(
  session: AgentSession | AgentHandle,
  options: AgentHandleOptions = {},
): AgentHandle {
  return session instanceof AgentHandle ? session : new AgentHandle(session, options);
}
