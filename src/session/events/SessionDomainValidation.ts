import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";

export type SessionDomainValidationErrorCode =
  | "duplicate_turn_start"
  | "event_outside_turn"
  | "invalid_step"
  | "invalid_compaction"
  | "invalid_question"
  | "invalid_permission"
  | "step_already_open"
  | "step_not_open"
  | "duplicate_model_request"
  | "duplicate_context_snapshot"
  | "context_after_model_request"
  | "instructions_after_model_request"
  | "model_request_missing"
  | "duplicate_tool_call"
  | "tool_result_without_call"
  | "step_has_open_tool_calls"
  | "turn_has_open_step"
  | "turn_has_pending_compaction"
  | "turn_has_pending_question"
  | "turn_has_pending_permission"
  | "turn_has_pending_inbox"
  | "invalid_inbox_mutation"
  | "invalid_plan_todo"
  | "invalid_goal";

export class SessionDomainValidationError extends Error {
  constructor(
    readonly code: SessionDomainValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionDomainValidationError";
  }
}

type StepState = {
  number: number;
  contextRecorded: boolean;
  modelRequested: boolean;
  openToolCallIds: Set<string>;
};

type TurnState = {
  closed: boolean;
  lastStep: number;
  openStep?: StepState;
  compactions: Set<string>;
  questions: Set<string>;
  permissions: Set<string>;
  inbox: Map<string, "pending" | "claimed" | "cancelled">;
};

export type SessionDomainValidationState = {
  goalRevision: number;
  turns: Map<string, TurnState>;
  turnInbox: Map<string, string>;
  turnInboxByTurnId: Map<string, string>;
  turnInboxItemIds: Set<string>;
  turnInboxTurnIds: Set<string>;
};

export function createSessionDomainValidationState(): SessionDomainValidationState {
  return {
    goalRevision: 0,
    turns: new Map(),
    turnInbox: new Map(),
    turnInboxByTurnId: new Map(),
    turnInboxItemIds: new Set(),
    turnInboxTurnIds: new Set(),
  };
}

export function validateSessionDomainLog(
  entries: readonly AgentTranscriptEntry[],
): SessionDomainValidationState {
  let state = createSessionDomainValidationState();
  for (const entry of entries) state = validateSessionDomainEvent(state, entry);
  return state;
}

export function validateSessionDomainEvent(
  state: SessionDomainValidationState,
  entry: AgentTranscriptEntry,
): SessionDomainValidationState {
  if (entry.type === "agent_turn_enqueued") {
    const next = cloneState(state);
    validateTurnEnqueued(next, entry);
    return next;
  }
  if (entry.type === "agent_turn_discarded") {
    const next = cloneState(state);
    validateTurnDiscarded(next, entry);
    return next;
  }
  const claimedInboxItemId = durableInboxItemId(entry);
  if (claimedInboxItemId) {
    const turn = state.turns.get(entry.turnId);
    if (!turn) return state;
    if (turn.closed || turn.inbox.get(claimedInboxItemId) !== "claimed") {
      throw domainError(
        "invalid_inbox_mutation",
        `Durable inbox message ${claimedInboxItemId} does not follow a claim in turn ${entry.turnId}.`,
      );
    }
    const next = cloneState(state);
    next.turns.get(entry.turnId)!.inbox.delete(claimedInboxItemId);
    return next;
  }
  if (!isDomainEntry(entry)) return state;
  const next = cloneState(state);

  if (entry.type === "turn_started") {
    if (next.turns.has(entry.turnId)) {
      throw domainError("duplicate_turn_start", `Turn ${entry.turnId} has already started.`);
    }
    const queuedItemId = next.turnInboxByTurnId.get(entry.turnId);
    if (entry.inboxItemId !== undefined) {
      const firstQueuedItemId = next.turnInbox.keys().next().value as string | undefined;
      if (!entry.inboxItemId || next.turnInbox.get(entry.inboxItemId) !== entry.turnId) {
        throw domainError(
          "invalid_inbox_mutation",
          `Turn ${entry.turnId} cannot claim queued item ${entry.inboxItemId || "(empty)"}.`,
        );
      }
      if (queuedItemId !== entry.inboxItemId) {
        throw domainError(
          "invalid_inbox_mutation",
          `Turn ${entry.turnId} does not own queued item ${entry.inboxItemId}.`,
        );
      }
      if (firstQueuedItemId !== entry.inboxItemId) {
        throw domainError(
          "invalid_inbox_mutation",
          `Turn ${entry.turnId} cannot bypass queued item ${firstQueuedItemId}.`,
        );
      }
      next.turnInbox.delete(entry.inboxItemId);
      next.turnInboxByTurnId.delete(entry.turnId);
    } else if (queuedItemId !== undefined) {
      throw domainError(
        "invalid_inbox_mutation",
        `Turn ${entry.turnId} must claim its queued item ${queuedItemId}.`,
      );
    }
    next.turns.set(entry.turnId, {
      closed: false,
      lastStep: 0,
      compactions: new Set(),
      questions: new Set(),
      permissions: new Set(),
      inbox: new Map(),
    });
    return next;
  }

  const turn = next.turns.get(entry.turnId);
  if (!turn) {
    // Legacy transcripts can contain turn_result without the WP9B boundary.
    if (entry.type === "turn_result") return next;
    throw domainError("event_outside_turn", `${entry.type} requires an active turn ${entry.turnId}.`);
  }
  if (turn.closed) {
    throw domainError("event_outside_turn", `${entry.type} cannot follow the result for turn ${entry.turnId}.`);
  }

  switch (entry.type) {
    case "compaction_started":
      validateCompactionStarted(entry);
      if (!entry.operationId) {
        throw domainError("invalid_compaction", "Compaction operationId must be non-empty.");
      }
      if (turn.compactions.has(entry.operationId)) {
        throw domainError("invalid_compaction", `Compaction ${entry.operationId} already started.`);
      }
      turn.compactions.add(entry.operationId);
      break;
    case "compaction_completed":
      validateCompactionCompleted(entry);
      // fall through: both terminal forms close the same bracket.
    case "compaction_failed":
      if (entry.type === "compaction_failed") validateCompactionFailed(entry);
      if (!turn.compactions.delete(entry.operationId)) {
        throw domainError("invalid_compaction", `Compaction ${entry.operationId} has no open lifecycle bracket.`);
      }
      break;
    case "question_started":
      validateQuestionStarted(entry);
      if (turn.questions.has(entry.operationId)) {
        throw domainError("invalid_question", `Question ${entry.operationId} already started.`);
      }
      turn.questions.add(entry.operationId);
      break;
    case "question_completed":
      validateQuestionCompleted(entry);
      if (!turn.questions.delete(entry.operationId)) {
        throw domainError("invalid_question", `Question ${entry.operationId} has no open lifecycle bracket.`);
      }
      break;
    case "question_failed":
      validateQuestionFailed(entry);
      if (!turn.questions.delete(entry.operationId)) {
        throw domainError("invalid_question", `Question ${entry.operationId} has no open lifecycle bracket.`);
      }
      break;
    case "permission_started":
      validatePermissionStarted(entry);
      requirePermissionStep(turn, entry.step, entry.turnId, entry.operationId);
      if (turn.permissions.has(entry.operationId)) {
        throw domainError("invalid_permission", `Permission ${entry.operationId} already started.`);
      }
      turn.permissions.add(entry.operationId);
      break;
    case "permission_completed":
      validatePermissionCompleted(entry);
      requirePermissionStep(turn, entry.step, entry.turnId, entry.operationId);
      if (!turn.permissions.delete(entry.operationId)) {
        throw domainError("invalid_permission", `Permission ${entry.operationId} has no open lifecycle bracket.`);
      }
      break;
    case "permission_failed":
      validatePermissionFailed(entry);
      requirePermissionStep(turn, entry.step, entry.turnId, entry.operationId);
      if (!turn.permissions.delete(entry.operationId)) {
        throw domainError("invalid_permission", `Permission ${entry.operationId} has no open lifecycle bracket.`);
      }
      break;
    case "step_started": {
      if (!Number.isSafeInteger(entry.step) || entry.step <= turn.lastStep) {
        throw domainError("invalid_step", `Step ${entry.step} must increase within turn ${entry.turnId}.`);
      }
      if (turn.openStep) {
        throw domainError("step_already_open", `Turn ${entry.turnId} already has open step ${turn.openStep.number}.`);
      }
      turn.lastStep = entry.step;
      turn.openStep = {
        number: entry.step,
        contextRecorded: false,
        modelRequested: false,
        openToolCallIds: new Set(),
      };
      break;
    }
    case "context_snapshot": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (step.contextRecorded) {
        throw domainError("duplicate_context_snapshot", `Step ${entry.step} already has a context snapshot.`);
      }
      if (step.modelRequested) {
        throw domainError("context_after_model_request", `Step ${entry.step} context must precede its model request.`);
      }
      step.contextRecorded = true;
      break;
    }
    case "agent_instructions": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (step.modelRequested) {
        throw domainError("instructions_after_model_request", `Step ${entry.step} instructions must precede its model request.`);
      }
      break;
    }
    case "model_request": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (step.modelRequested) {
        throw domainError("duplicate_model_request", `Step ${entry.step} already has a model request.`);
      }
      step.modelRequested = true;
      break;
    }
    case "model_stream_event": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (!step.modelRequested) {
        throw domainError("model_request_missing", `Step ${entry.step} emitted a model event before its request.`);
      }
      break;
    }
    case "tool_call": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (!step.modelRequested) {
        throw domainError("model_request_missing", `Step ${entry.step} emitted tool call ${entry.call.id} before its request.`);
      }
      if (step.openToolCallIds.has(entry.call.id)) {
        throw domainError("duplicate_tool_call", `Tool call ${entry.call.id} is already open.`);
      }
      step.openToolCallIds.add(entry.call.id);
      break;
    }
    case "tool_result": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (!step.openToolCallIds.delete(entry.result.toolCallId)) {
        throw domainError(
          "tool_result_without_call",
          `Tool result ${entry.result.toolCallId} has no open call in step ${entry.step}.`,
        );
      }
      break;
    }
    case "step_completed": {
      const step = requireStep(turn, entry.turnId, entry.step, entry.type);
      if (entry.outcome === "completed" && step.openToolCallIds.size > 0) {
        throw domainError(
          "step_has_open_tool_calls",
          `Step ${entry.step} completed with unresolved tool calls.`,
        );
      }
      turn.openStep = undefined;
      break;
    }
    case "inbox_mutation":
      validateInboxMutation(turn, entry);
      break;
    case "plan_todo_plan_changed":
      validatePlanTodoPlanChanged(entry);
      break;
    case "plan_todo_written":
      validatePlanTodoWritten(entry);
      break;
    case "plan_todo_progressed":
      validatePlanTodoProgressed(entry);
      break;
    case "goal_changed":
      validateGoalChanged(next, entry);
      break;
    case "turn_result":
      if (turn.openStep) {
        throw domainError("turn_has_open_step", `Turn ${entry.turnId} closed with step ${turn.openStep.number} open.`);
      }
      if (turn.compactions.size > 0) {
        throw domainError(
          "turn_has_pending_compaction",
          `Turn ${entry.turnId} closed with pending compaction ${[...turn.compactions].join(", ")}.`,
        );
      }
      if (turn.questions.size > 0) {
        throw domainError(
          "turn_has_pending_question",
          `Turn ${entry.turnId} closed with pending question ${[...turn.questions].join(", ")}.`,
        );
      }
      if (turn.permissions.size > 0) {
        throw domainError(
          "turn_has_pending_permission",
          `Turn ${entry.turnId} closed with pending permission ${[...turn.permissions].join(", ")}.`,
        );
      }
      if ([...turn.inbox.values()].some((value) => value === "pending" || value === "claimed")) {
        throw domainError("turn_has_pending_inbox", `Turn ${entry.turnId} closed with pending inbox items.`);
      }
      turn.closed = true;
      break;
  }

  return next;
}

function validateCompactionStarted(
  entry: Extract<AgentTranscriptEntry, { type: "compaction_started" }>,
): void {
  if (!entry.operationId || !Number.isSafeInteger(entry.messageCount) || entry.messageCount < 0) {
    throw domainError("invalid_compaction", `Compaction ${entry.operationId || "(unknown)"} has invalid start metadata.`);
  }
  if (entry.maxContextTokens !== undefined
    && (!Number.isSafeInteger(entry.maxContextTokens) || entry.maxContextTokens <= 0)) {
    throw domainError("invalid_compaction", `Compaction ${entry.operationId} has invalid maxContextTokens.`);
  }
}

function validateCompactionCompleted(
  entry: Extract<AgentTranscriptEntry, { type: "compaction_completed" }>,
): void {
  if (!entry.operationId || !Number.isSafeInteger(entry.messageCount) || entry.messageCount < 0) {
    throw domainError("invalid_compaction", `Compaction ${entry.operationId || "(unknown)"} has invalid completion metadata.`);
  }
}

function validateCompactionFailed(
  entry: Extract<AgentTranscriptEntry, { type: "compaction_failed" }>,
): void {
  if (!entry.operationId || entry.error.length === 0) {
    throw domainError("invalid_compaction", `Compaction ${entry.operationId || "(unknown)"} has invalid failure metadata.`);
  }
}

function validateQuestionStarted(
  entry: Extract<AgentTranscriptEntry, { type: "question_started" }>,
): void {
  if (!entry.operationId || !entry.toolCallId || !entry.toolName
    || !Number.isSafeInteger(entry.questionCount) || entry.questionCount <= 0) {
    throw domainError("invalid_question", `Question ${entry.operationId || "(unknown)"} has invalid start metadata.`);
  }
}

function validateQuestionCompleted(
  entry: Extract<AgentTranscriptEntry, { type: "question_completed" }>,
): void {
  if (!entry.operationId || !Number.isSafeInteger(entry.questionCount) || entry.questionCount <= 0) {
    throw domainError("invalid_question", `Question ${entry.operationId || "(unknown)"} has invalid completion metadata.`);
  }
}

function validateQuestionFailed(
  entry: Extract<AgentTranscriptEntry, { type: "question_failed" }>,
): void {
  if (!entry.operationId || entry.error.length === 0) {
    throw domainError("invalid_question", `Question ${entry.operationId || "(unknown)"} has invalid failure metadata.`);
  }
}

function validatePermissionStarted(
  entry: Extract<AgentTranscriptEntry, { type: "permission_started" }>,
): void {
  if (!entry.operationId || !entry.toolCallId || !entry.toolName
    || !Number.isSafeInteger(entry.step) || entry.step <= 0 || !entry.mode) {
    throw domainError("invalid_permission", `Permission ${entry.operationId || "(unknown)"} has invalid start metadata.`);
  }
}

function validatePermissionCompleted(
  entry: Extract<AgentTranscriptEntry, { type: "permission_completed" }>,
): void {
  if (!entry.operationId || !entry.toolCallId || !entry.toolName
    || !Number.isSafeInteger(entry.step) || entry.step <= 0 || !entry.mode || !entry.decision || !entry.reason) {
    throw domainError("invalid_permission", `Permission ${entry.operationId || "(unknown)"} has invalid completion metadata.`);
  }
}

function validatePermissionFailed(
  entry: Extract<AgentTranscriptEntry, { type: "permission_failed" }>,
): void {
  if (!entry.operationId || !entry.toolCallId || !entry.toolName
    || !Number.isSafeInteger(entry.step) || entry.step <= 0 || !entry.mode || entry.error.length === 0) {
    throw domainError("invalid_permission", `Permission ${entry.operationId || "(unknown)"} has invalid failure metadata.`);
  }
}

function requirePermissionStep(
  turn: TurnState,
  stepNumber: number,
  turnId: string,
  operationId: string,
): StepState {
  const step = requireStep(turn, turnId, stepNumber, "permission");
  if (!step.modelRequested) {
    throw domainError(
      "model_request_missing",
      `Permission ${operationId} was recorded before the model request for step ${stepNumber}.`,
    );
  }
  return step;
}

function durableInboxItemId(entry: AgentTranscriptEntry): string | undefined {
  if (
    entry.type !== "durable_message"
    && entry.type !== "assistant_message"
    && entry.type !== "tool_result_message"
  ) {
    return undefined;
  }
  const itemId = entry.message.metadata?.queueItemId;
  return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
}

function validateInboxMutation(
  turn: TurnState,
  entry: Extract<AgentTranscriptEntry, { type: "inbox_mutation" }>,
): void {
  if (!entry.itemId) {
    throw domainError("invalid_inbox_mutation", "Inbox mutation itemId must be non-empty.");
  }
  const current = turn.inbox.get(entry.itemId);
  switch (entry.mutation) {
    case "insert":
      if (!entry.message || current !== undefined) {
        throw domainError("invalid_inbox_mutation", `Inbox item ${entry.itemId} cannot be inserted in its current state.`);
      }
      turn.inbox.set(entry.itemId, "pending");
      return;
    case "cancel":
      if (current === "claimed") {
        throw domainError("invalid_inbox_mutation", `Claimed inbox item ${entry.itemId} cannot be cancelled.`);
      }
      turn.inbox.set(entry.itemId, "cancelled");
      return;
    case "claim":
      if (current !== "pending") {
        throw domainError("invalid_inbox_mutation", `Inbox item ${entry.itemId} must be pending before claim.`);
      }
      turn.inbox.set(entry.itemId, "claimed");
      return;
    case "discard":
      if (current !== "pending" && current !== "claimed") {
        throw domainError("invalid_inbox_mutation", `Inbox item ${entry.itemId} cannot be discarded in its current state.`);
      }
      turn.inbox.delete(entry.itemId);
  }
}

function validatePlanTodoPlanChanged(
  entry: Extract<AgentTranscriptEntry, { type: "plan_todo_plan_changed" }>,
): void {
  if (entry.plan !== null && (typeof entry.plan !== "string" || entry.plan.trim().length === 0)) {
    throw domainError("invalid_plan_todo", "Plan/todo plan must be a non-empty string or null.");
  }
}

function validatePlanTodoWritten(
  entry: Extract<AgentTranscriptEntry, { type: "plan_todo_written" }>,
): void {
  if (
    (entry.mode !== "markdown" && entry.mode !== "structured")
    || typeof entry.merge !== "boolean"
    || (entry.markdown !== undefined && typeof entry.markdown !== "string")
    || (entry.reason !== undefined && typeof entry.reason !== "string")
    || !Array.isArray(entry.todos)
  ) {
    throw domainError("invalid_plan_todo", "Plan/todo write has invalid metadata.");
  }
  const ids = new Set<string>();
  for (const todo of entry.todos) {
    if (
      typeof todo.id !== "string"
      || todo.id.trim().length === 0
      || typeof todo.content !== "string"
      || todo.content.trim().length === 0
      || !["pending", "in_progress", "completed", "cancelled"].includes(todo.status)
      || (todo.priority !== undefined && typeof todo.priority !== "string")
      || ids.has(todo.id)
    ) {
      throw domainError("invalid_plan_todo", "Plan/todo write contains an invalid todo item.");
    }
    ids.add(todo.id);
  }
}

function validatePlanTodoProgressed(
  entry: Extract<AgentTranscriptEntry, { type: "plan_todo_progressed" }>,
): void {
  if (!entry.toolName.trim()) {
    throw domainError("invalid_plan_todo", "Plan/todo progress requires a tool name.");
  }
}

function validateGoalChanged(
  state: SessionDomainValidationState,
  entry: Extract<AgentTranscriptEntry, { type: "goal_changed" }>,
): void {
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    throw domainError("invalid_goal", "Goal revision must be a positive integer.");
  }
  if (entry.revision !== state.goalRevision + 1) {
    throw domainError("invalid_goal", `Goal revision must increase from ${state.goalRevision} to ${state.goalRevision + 1}.`);
  }
  if (entry.goal === null) {
    state.goalRevision = entry.revision;
    return;
  }
  const goal = entry.goal;
  if (
    typeof goal.id !== "string" || goal.id.trim().length === 0
    || typeof goal.objective !== "string" || goal.objective.trim().length === 0
    || goal.revision !== entry.revision
    || !["active", "paused", "blocked", "complete"].includes(goal.phase)
    || (goal.blockedReason !== undefined && typeof goal.blockedReason !== "string")
    || (goal.maxGoalRounds !== undefined && (!Number.isSafeInteger(goal.maxGoalRounds) || goal.maxGoalRounds < 1))
  ) {
    throw domainError("invalid_goal", "Goal snapshot is invalid.");
  }
  if (goal.phase === "blocked" && !goal.blockedReason?.trim()) {
    throw domainError("invalid_goal", "Blocked goals require a reason.");
  }
  state.goalRevision = entry.revision;
}

function validateTurnEnqueued(
  state: SessionDomainValidationState,
  entry: Extract<AgentTranscriptEntry, { type: "agent_turn_enqueued" }>,
): void {
  if (!entry.itemId || !entry.turnId || !isAgentInput(entry.input) || !isPlainRecord(entry.submitOptions)) {
    throw domainError("invalid_inbox_mutation", `Queued turn ${entry.itemId || "(empty)"} has invalid input.`);
  }
  if (state.turnInboxItemIds.has(entry.itemId)) {
    throw domainError("invalid_inbox_mutation", `Queued turn item ${entry.itemId} has already been used.`);
  }
  if (state.turns.has(entry.turnId) || state.turnInboxTurnIds.has(entry.turnId)) {
    throw domainError("invalid_inbox_mutation", `Queued turn id ${entry.turnId} is already in use.`);
  }
  state.turnInbox.set(entry.itemId, entry.turnId);
  state.turnInboxByTurnId.set(entry.turnId, entry.itemId);
  state.turnInboxItemIds.add(entry.itemId);
  state.turnInboxTurnIds.add(entry.turnId);
}

function validateTurnDiscarded(
  state: SessionDomainValidationState,
  entry: Extract<AgentTranscriptEntry, { type: "agent_turn_discarded" }>,
): void {
  if (
    !entry.itemId
    || (entry.reason !== "cancelled" && entry.reason !== "agent_disposed")
    || state.turnInbox.get(entry.itemId) !== entry.turnId
  ) {
    throw domainError("invalid_inbox_mutation", `Queued turn ${entry.itemId || "(empty)"} is not pending.`);
  }
  state.turnInbox.delete(entry.itemId);
  state.turnInboxByTurnId.delete(entry.turnId);
}

function isAgentInput(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  return value.type === "blocks" && Array.isArray(value.content);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireStep(
  turn: TurnState,
  turnId: string,
  stepNumber: number,
  eventType: string,
): StepState {
  const step = turn.openStep;
  if (!step || step.number !== stepNumber) {
    throw domainError("step_not_open", `${eventType} requires open step ${stepNumber} in turn ${turnId}.`);
  }
  return step;
}

function cloneState(state: SessionDomainValidationState): SessionDomainValidationState {
  return {
    goalRevision: state.goalRevision,
    turnInbox: new Map(state.turnInbox),
    turnInboxByTurnId: new Map(state.turnInboxByTurnId),
    turnInboxItemIds: new Set(state.turnInboxItemIds),
    turnInboxTurnIds: new Set(state.turnInboxTurnIds),
    turns: new Map([...state.turns].map(([turnId, turn]) => [turnId, {
      closed: turn.closed,
      lastStep: turn.lastStep,
      ...(turn.openStep ? {
        openStep: {
          number: turn.openStep.number,
          contextRecorded: turn.openStep.contextRecorded,
          modelRequested: turn.openStep.modelRequested,
          openToolCallIds: new Set(turn.openStep.openToolCallIds),
        },
      } : {}),
      compactions: new Set(turn.compactions),
      questions: new Set(turn.questions),
      permissions: new Set(turn.permissions),
      inbox: new Map(turn.inbox),
    }])),
  };
}

function isDomainEntry(entry: AgentTranscriptEntry): boolean {
  return entry.type === "turn_started"
    || entry.type === "step_started"
    || entry.type === "step_completed"
    || entry.type === "context_snapshot"
    || entry.type === "agent_instructions"
    || entry.type === "model_request"
    || entry.type === "model_stream_event"
    || entry.type === "tool_call"
    || entry.type === "tool_result"
    || entry.type === "compaction_started"
    || entry.type === "compaction_completed"
    || entry.type === "compaction_failed"
    || entry.type === "question_started"
    || entry.type === "question_completed"
    || entry.type === "question_failed"
    || entry.type === "permission_started"
    || entry.type === "permission_completed"
    || entry.type === "permission_failed"
    || entry.type === "inbox_mutation"
    || entry.type === "plan_todo_plan_changed"
    || entry.type === "plan_todo_written"
    || entry.type === "plan_todo_progressed"
    || entry.type === "goal_changed"
    || entry.type === "turn_result";
}

function domainError(
  code: SessionDomainValidationErrorCode,
  message: string,
): SessionDomainValidationError {
  return new SessionDomainValidationError(code, message);
}
