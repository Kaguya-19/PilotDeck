import type { AgentTurnResult } from "../protocol/result.js";
import { randomUUID } from "node:crypto";
import type { CanonicalModelEvent } from "../../model/index.js";
import type { PilotDeckToolCall, PilotDeckToolResult } from "../../tool/index.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import type { AgentInboxMutationTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { PreparedModelInvocation } from "../modules/protocol.js";
import type { ContextMaterialization } from "../../context/protocol/types.js";
import type {
  AgentInstructionChange,
  AgentInstructionLayerSnapshot,
  AgentCompactionCompletedTranscriptEntry,
  AgentCompactionFailedTranscriptEntry,
  AgentCompactionStartedTranscriptEntry,
  AgentTranscriptEntry,
  AgentQuestionCompletedTranscriptEntry,
  AgentQuestionFailedTranscriptEntry,
  AgentQuestionStartedTranscriptEntry,
  AgentPermissionCompletedTranscriptEntry,
  AgentPermissionFailedTranscriptEntry,
  AgentPermissionStartedTranscriptEntry,
  AgentSubagentDescriptorData,
  AgentTurnDiscardedTranscriptEntry,
  AgentTurnEnqueuedTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";

type TurnRecordingState = {
  nextStep: number;
  openStep?: number;
  contextRecorded?: boolean;
  modelRequested?: boolean;
};

type PendingCompaction = {
  sessionId: string;
  turnId: string;
  operationId: string;
  completion?: CompactionCompletedDraft;
};

export type AgentSessionEventRecorderOptions = {
  restoredEntries?: readonly AgentTranscriptEntry[];
  uuid?: () => string;
};

export type InboxMutationDraft = Omit<
  AgentInboxMutationTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type CompactionStartedDraft = Omit<
  AgentCompactionStartedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type CompactionCompletedDraft = Omit<
  AgentCompactionCompletedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type CompactionFailedDraft = Omit<
  AgentCompactionFailedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type QuestionStartedDraft = Omit<
  AgentQuestionStartedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type QuestionCompletedDraft = Omit<
  AgentQuestionCompletedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type QuestionFailedDraft = Omit<
  AgentQuestionFailedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type PermissionStartedDraft = Omit<
  AgentPermissionStartedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type PermissionCompletedDraft = Omit<
  AgentPermissionCompletedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type PermissionFailedDraft = Omit<
  AgentPermissionFailedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type TurnEnqueuedDraft = Omit<
  AgentTurnEnqueuedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export type TurnDiscardedDraft = Omit<
  AgentTurnDiscardedTranscriptEntry,
  "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"
>;

export class AgentSessionEventRecorder {
  private readonly turns = new Map<string, TurnRecordingState>();
  private readonly pendingCompactions = new Map<string, PendingCompaction[]>();
  private instructionBaselineRecorded = false;
  private instructionLayers = new Map<string, AgentInstructionLayerSnapshot>();
  private completedTurnId: string | undefined;
  private readonly uuid: () => string;

  constructor(
    private readonly transcript: AgentTranscriptWriter,
    options: AgentSessionEventRecorderOptions = {},
  ) {
    this.uuid = options.uuid ?? randomUUID;
    this.restoreInstructionState(options.restoredEntries ?? []);
  }

  nextCompactionOperationId(): string {
    return this.uuid();
  }

  recordSubagentDescriptor(
    sessionId: string,
    turnId: string,
    descriptor: AgentSubagentDescriptorData,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "subagent_descriptor",
      descriptor,
    });
  }

  async startTurn(sessionId: string, turnId: string, inboxItemId?: string): Promise<void> {
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "turn_started",
      ...(inboxItemId ? { inboxItemId } : {}),
    });
    this.completedTurnId = undefined;
    this.turns.set(turnId, { nextStep: 1 });
  }

  recordTurnEnqueued(
    sessionId: string,
    turnId: string,
    draft: TurnEnqueuedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "agent_turn_enqueued",
      ...draft,
    });
  }

  recordTurnDiscarded(
    sessionId: string,
    turnId: string,
    draft: TurnDiscardedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "agent_turn_discarded",
      ...draft,
    });
  }

  /**
   * Returns the step identity that the next model-admission fact will use.
   * This is deliberately a read-only preview: the durable step is opened only
   * when context/model facts are successfully committed.
   */
  peekAdmissionStep(turnId: string): number {
    const state = this.requireTurn(turnId);
    return state.openStep !== undefined && !state.modelRequested
      ? state.openStep
      : state.nextStep;
  }

  /** Return the currently open step after admission has started. */
  currentStep(turnId: string): number {
    const step = this.requireTurn(turnId).openStep;
    if (step === undefined) throw new Error(`Durable turn ${turnId} has no open step.`);
    return step;
  }

  async recordModelRequest(
    sessionId: string,
    turnId: string,
    prepared: PreparedModelInvocation,
  ): Promise<number> {
    const state = this.requireTurn(turnId);
    if (state.openStep === undefined || state.modelRequested) {
      await this.openNextStep(sessionId, turnId);
    }
    const step = this.requireOpenStep(turnId);
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "model_request",
      step,
      request: prepared.request,
    });
    state.modelRequested = true;
    return step;
  }

  async recordContextMaterialization(
    sessionId: string,
    turnId: string,
    materialization: ContextMaterialization,
  ): Promise<void> {
    const state = this.requireTurn(turnId);
    const admissionStep = this.peekAdmissionStep(turnId);
    if (materialization.stepId !== undefined && materialization.stepId !== admissionStep) {
      throw new Error(
        `Context materialization step ${materialization.stepId} does not match durable admission step ${admissionStep}.`,
      );
    }
    if (state.openStep === undefined || state.modelRequested) {
      await this.openNextStep(sessionId, turnId);
    }
    const step = this.requireOpenStep(turnId);
    if (!state.contextRecorded) {
      await this.transcript.recordSessionEvent(sessionId, turnId, {
        type: "context_snapshot",
        step,
        ...(materialization.promptGeneration !== undefined
          ? { promptGeneration: materialization.promptGeneration }
          : {}),
        contexts: materialization.runtimeContexts.map((context) => ({ ...context })),
        ...(materialization.runtimeContextMessages
          ? { runtimeContextMessages: materialization.runtimeContextMessages.map((message) => structuredClone(message)) }
          : {}),
      });
      state.contextRecorded = true;
    }

    if (materialization.instructionLayers === undefined) return;
    const nextLayers = new Map(
      materialization.instructionLayers.map((layer) => [instructionLayerKey(layer), { ...layer }]),
    );
    const baseline = !this.instructionBaselineRecorded;
    const changes = baseline
      ? [...nextLayers.values()].map((layer): AgentInstructionChange => ({
          action: "set",
          ...layer,
        }))
      : diffInstructionLayers(this.instructionLayers, nextLayers);
    if (!baseline && changes.length === 0) return;

    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "agent_instructions",
      step,
      baseline,
      ...(baseline ? { layers: [...nextLayers.values()].map((layer) => ({ ...layer })) } : {}),
      changes,
    });
    this.instructionBaselineRecorded = true;
    this.instructionLayers = nextLayers;
  }

  async recordModelEvent(
    sessionId: string,
    turnId: string,
    event: CanonicalModelEvent,
  ): Promise<void> {
    const step = this.requireOpenStep(turnId);
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "model_stream_event",
      step,
      event: stripRawFields(event) as CanonicalModelEvent,
    });
  }

  async recordToolCalls(
    sessionId: string,
    turnId: string,
    calls: readonly PilotDeckToolCall[],
  ): Promise<void> {
    const step = this.requireOpenStep(turnId);
    for (const call of calls) {
      await this.transcript.recordSessionEvent(sessionId, turnId, {
        type: "tool_call",
        step,
        call: stripRawFields(call) as PilotDeckToolCall,
      });
    }
  }

  async recordToolResults(
    sessionId: string,
    turnId: string,
    results: readonly PilotDeckToolResult[],
  ): Promise<void> {
    const step = this.requireOpenStep(turnId);
    for (const result of results) {
      await this.transcript.recordSessionEvent(sessionId, turnId, {
        type: "tool_result",
        step,
        result: stripRawFields(result) as PilotDeckToolResult,
      });
    }
    await this.completeStep(sessionId, turnId, "completed");
  }

  recordInboxMutation(
    sessionId: string,
    turnId: string,
    mutation: InboxMutationDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "inbox_mutation",
      ...mutation,
    });
  }

  async recordCompactionStarted(
    sessionId: string,
    turnId: string,
    draft: CompactionStartedDraft,
  ): Promise<void> {
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "compaction_started",
      ...draft,
    });
    const key = compactionKey(sessionId, turnId);
    const pending = this.pendingCompactions.get(key) ?? [];
    pending.push({ sessionId, turnId, operationId: draft.operationId });
    this.pendingCompactions.set(key, pending);
  }

  async recordCompactionCompleted(
    sessionId: string,
    turnId: string,
    draft: CompactionCompletedDraft,
  ): Promise<void> {
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "compaction_completed",
      ...draft,
    });
    this.removePendingCompaction(sessionId, turnId, draft.operationId);
  }

  async recordCompactionFailed(
    sessionId: string,
    turnId: string,
    draft: CompactionFailedDraft,
  ): Promise<void> {
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "compaction_failed",
      ...draft,
    });
    this.removePendingCompaction(sessionId, turnId, draft.operationId);
  }

  /**
   * Hold the terminal lifecycle fact until a compact replacement surface has
   * been durably committed. This keeps provider success from being reported
   * when the model-visible replacement was never persisted.
   */
  deferCompactionCompletion(
    sessionId: string,
    turnId: string,
    draft: CompactionCompletedDraft,
  ): void {
    const pending = this.findPendingCompaction(sessionId, turnId, draft.operationId);
    pending.completion = draft;
  }

  async commitDeferredCompaction(sessionId: string, turnId: string): Promise<void> {
    const pending = this.findDeferredCompaction(sessionId, turnId);
    if (!pending?.completion) return;
    await this.recordCompactionCompleted(sessionId, turnId, pending.completion);
  }

  async failDeferredCompaction(sessionId: string, turnId: string, error: unknown): Promise<void> {
    const pending = this.findDeferredCompaction(sessionId, turnId);
    if (!pending) return;
    await this.recordCompactionFailed(sessionId, turnId, {
      operationId: pending.operationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  recordQuestionStarted(
    sessionId: string,
    turnId: string,
    draft: QuestionStartedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "question_started",
      ...draft,
    });
  }

  recordQuestionCompleted(
    sessionId: string,
    turnId: string,
    draft: QuestionCompletedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "question_completed",
      ...draft,
    });
  }

  recordQuestionFailed(
    sessionId: string,
    turnId: string,
    draft: QuestionFailedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "question_failed",
      ...draft,
    });
  }

  recordPermissionStarted(
    sessionId: string,
    turnId: string,
    draft: PermissionStartedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "permission_started",
      ...draft,
    });
  }

  recordPermissionCompleted(
    sessionId: string,
    turnId: string,
    draft: PermissionCompletedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "permission_completed",
      ...draft,
    });
  }

  recordPermissionFailed(
    sessionId: string,
    turnId: string,
    draft: PermissionFailedDraft,
  ): void | Promise<void> {
    return this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "permission_failed",
      ...draft,
    });
  }

  private findPendingCompaction(
    sessionId: string,
    turnId: string,
    operationId: string,
  ): PendingCompaction {
    const pending = this.pendingCompactions.get(compactionKey(sessionId, turnId)) ?? [];
    const match = pending.find((candidate) => candidate.operationId === operationId);
    if (!match) {
      throw new Error(`Compaction ${operationId} has no pending durable lifecycle.`);
    }
    return match;
  }

  private findDeferredCompaction(sessionId: string, turnId: string): PendingCompaction | undefined {
    const pending = this.pendingCompactions.get(compactionKey(sessionId, turnId)) ?? [];
    return pending.find((candidate) => candidate.completion !== undefined);
  }

  private removePendingCompaction(sessionId: string, turnId: string, operationId: string): void {
    const key = compactionKey(sessionId, turnId);
    const pending = this.pendingCompactions.get(key);
    if (!pending) return;
    const remaining = pending.filter((candidate) => candidate.operationId !== operationId);
    if (remaining.length === 0) this.pendingCompactions.delete(key);
    else this.pendingCompactions.set(key, remaining);
  }

  async completeTurn(result: AgentTurnResult): Promise<void> {
    if (this.completedTurnId === result.turnId) return;
    const outcome = result.type === "aborted"
      ? "aborted"
      : result.type === "error"
        ? "failed"
        : "completed";
    await this.completeStep(result.sessionId, result.turnId, outcome);
    await this.transcript.recordTurnResult(result.sessionId, result.turnId, result);
    this.turns.delete(result.turnId);
    this.completedTurnId = result.turnId;
  }

  private async completeStep(
    sessionId: string,
    turnId: string,
    outcome: "completed" | "failed" | "aborted",
  ): Promise<void> {
    const state = this.requireTurn(turnId);
    if (state.openStep === undefined) return;
    const step = state.openStep;
    await this.transcript.recordSessionEvent(sessionId, turnId, {
      type: "step_completed",
      step,
      outcome,
    });
    state.openStep = undefined;
    state.contextRecorded = false;
    state.modelRequested = false;
  }

  private async openNextStep(sessionId: string, turnId: string): Promise<number> {
    const state = this.requireTurn(turnId);
    if (state.openStep !== undefined) {
      await this.completeStep(sessionId, turnId, "completed");
    }
    const step = state.nextStep;
    await this.transcript.recordSessionEvent(sessionId, turnId, { type: "step_started", step });
    state.openStep = step;
    state.contextRecorded = false;
    state.modelRequested = false;
    state.nextStep += 1;
    return step;
  }

  private restoreInstructionState(entries: readonly AgentTranscriptEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "agent_instructions") continue;
      if (entry.baseline) {
        this.instructionBaselineRecorded = true;
        this.instructionLayers = new Map(
          (entry.layers ?? []).map((layer) => [instructionLayerKey(layer), { ...layer }]),
        );
      }
      for (const change of entry.changes) {
        const key = instructionLayerKey(change);
        if (change.action === "remove") {
          this.instructionLayers.delete(key);
        } else {
          this.instructionLayers.set(key, {
            scope: change.scope,
            path: change.path,
            content: change.content ?? "",
          });
        }
      }
    }
  }

  private requireTurn(turnId: string): TurnRecordingState {
    const state = this.turns.get(turnId);
    if (!state) throw new Error(`Durable turn ${turnId} has not started.`);
    return state;
  }

  private requireOpenStep(turnId: string): number {
    const step = this.requireTurn(turnId).openStep;
    if (step === undefined) throw new Error(`Durable turn ${turnId} has no open step.`);
    return step;
  }
}

function instructionLayerKey(layer: { scope: string; path: string }): string {
  return `${layer.scope}\u0000${layer.path}`;
}

function compactionKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function diffInstructionLayers(
  previous: ReadonlyMap<string, AgentInstructionLayerSnapshot>,
  next: ReadonlyMap<string, AgentInstructionLayerSnapshot>,
): AgentInstructionChange[] {
  const changes: AgentInstructionChange[] = [];
  for (const [key, layer] of next) {
    const prior = previous.get(key);
    if (!prior) {
      changes.push({ action: "set", ...layer });
    } else if (prior.content !== layer.content) {
      changes.push({ action: "replace", ...layer });
    }
  }
  for (const [key, layer] of previous) {
    if (!next.has(key)) {
      changes.push({ action: "remove", scope: layer.scope, path: layer.path });
    }
  }
  return changes.sort((left, right) =>
    left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : left.path.localeCompare(right.path)
  );
}

function stripRawFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRawFields);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "raw") sanitized[key] = stripRawFields(child);
  }
  return sanitized;
}
