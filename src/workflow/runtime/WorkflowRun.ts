import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventStore,
  WorkflowExecutionAdapter,
  WorkflowExecutionContext,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowStepDefinition,
  WorkflowStepSnapshot,
  WorkflowStepStatus,
  WorkflowRunHandle,
  WorkflowEventObserver,
} from "../protocol/types.js";
import { cloneWorkflowDefinition, validateWorkflowDefinition } from "./WorkflowDefinition.js";

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set(["completed", "failed", "cancelled", "unknown"]);

type MutableStep = { id: string; status: WorkflowStepStatus; output?: unknown; error?: { code: string; message: string } };

export type WorkflowRunOptions = {
  runId: string;
  ownerId: string;
  definition: WorkflowDefinition;
  input: unknown;
  /** Absolute epoch deadline. Timeout is a failed settlement, not cancellation. */
  deadlineAt?: number | Date;
  eventStore: WorkflowEventStore;
  adapter: WorkflowExecutionAdapter;
  /** Optional live observer. It receives committed event snapshots only. */
  eventObserver?: WorkflowEventObserver;
};

export type WorkflowRunRestoreOptions = Omit<WorkflowRunOptions, "definition" | "input"> & {
  /** Optional compatibility assertion. Durable run_created data remains authoritative. */
  definition?: WorkflowDefinition;
  /** Optional compatibility assertion. Durable run_created data remains authoritative. */
  input?: unknown;
};

export class WorkflowRunBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunBindingError";
  }
}

export class WorkflowRun implements WorkflowRunHandle {
  private readonly definition: WorkflowDefinition;
  private readonly steps: MutableStep[];
  private status: WorkflowStatus = "created";
  private readonly abortController = new AbortController();
  private execution: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private cancelPromise: Promise<void> | undefined;
  private settlement: Promise<void> | undefined;
  private eventTail: Promise<void> = Promise.resolve();
  private activeStepId: string | undefined;
  private readonly deadlineAt: number | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineRequested = false;
  private disposed = false;
  private pauseRequested = false;
  private cancelRequested = false;

  private constructor(private readonly options: WorkflowRunOptions, restoredEvents: readonly WorkflowEvent[] = []) {
    this.definition = cloneWorkflowDefinition(options.definition);
    this.deadlineAt = normalizeDeadline(options.deadlineAt);
    this.steps = this.definition.steps.map((step) => ({ id: step.id, status: "pending" }));
    this.applyEvents(restoredEvents);
  }

  static async create(options: WorkflowRunOptions): Promise<WorkflowRun> {
    validateWorkflowDefinition(options.definition);
    const run = new WorkflowRun(options);
    const created = await options.eventStore.create({
      runId: options.runId,
      ownerId: options.ownerId,
      type: "run_created",
      definition: cloneWorkflowDefinition(options.definition),
      input: structuredClone(options.input),
      ...(run.deadlineAt === undefined ? {} : { deadlineAt: run.deadlineAt }),
    });
    run.notify(created);
    return run;
  }

  static async restore(options: WorkflowRunRestoreOptions): Promise<WorkflowRun> {
    const events = await options.eventStore.read(options.runId);
    if (events.length === 0) throw new Error(`Workflow run ${options.runId} has no durable events.`);
    if (events.some((event) => event.ownerId !== options.ownerId)) {
      throw new Error(`Workflow run ${options.runId} belongs to a different owner.`);
    }
    const created = events.find((event) => event.type === "run_created");
    if (!created?.definition || !("input" in created)) {
      throw new WorkflowRunBindingError(`Workflow run ${options.runId} has no durable definition and input binding.`);
    }
    const definition = cloneWorkflowDefinition(created.definition);
    const input = structuredClone(created.input);
    const deadlineAt = created.deadlineAt;
    if (options.definition && !sameValue(options.definition, definition)) {
      throw new WorkflowRunBindingError(`Workflow run ${options.runId} definition does not match its durable binding.`);
    }
    if (Object.hasOwn(options, "input") && !sameValue(options.input, input)) {
      throw new WorkflowRunBindingError(`Workflow run ${options.runId} input does not match its durable binding.`);
    }
    const run = new WorkflowRun({ ...options, definition, input, ...(deadlineAt === undefined ? {} : { deadlineAt }) }, events);
    await run.recoverInterruptedExecution();
    return run;
  }

  getSnapshot(): WorkflowSnapshot {
    return {
      runId: this.options.runId,
      ownerId: this.options.ownerId,
      status: this.status,
      definitionId: this.definition.id,
      definitionVersion: this.definition.version,
      input: structuredClone(this.options.input),
      ...(this.deadlineAt === undefined ? {} : { deadlineAt: this.deadlineAt }),
      steps: this.steps.map((step) => ({
        id: step.id,
        status: step.status,
        ...(step.output === undefined ? {} : { output: structuredClone(step.output) }),
        ...(step.error ? { error: { ...step.error } } : {}),
      })),
    };
  }

  start(): Promise<void> {
    if (this.disposed || TERMINAL.has(this.status) || this.cancelRequested) return this.cancelPromise ?? Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.status === "running" || this.status === "cancelling") return this.execution ?? Promise.resolve();
    const wasPaused = this.status === "paused";
    this.pauseRequested = false;
    const start = (async () => {
      try {
        await this.append(wasPaused ? "run_resumed" : "run_started");
        if (this.cancelRequested) {
          await this.settle("cancelled");
          return;
        }
        this.status = "running";
        this.armDeadline();
        this.execution = this.executeLoop();
        await this.execution;
      } catch (error) {
        this.markUnknownAfterPersistenceFailure(error);
        throw error;
      }
    })();
    this.startPromise = start;
    void start.finally(() => {
      if (this.startPromise === start) this.startPromise = undefined;
    }).catch(() => undefined);
    return start;
  }

  pause(): Promise<void> {
    if (this.disposed || this.status !== "running") return Promise.resolve();
    this.pauseRequested = true;
    return Promise.resolve();
  }

  resume(): Promise<void> {
    return this.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!TERMINAL.has(this.status)) {
      await this.cancel();
      await this.execution;
      await this.startPromise;
    }
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
  }

  cancel(): Promise<void> {
    if (TERMINAL.has(this.status) || this.settlement) return this.settlement ?? Promise.resolve();
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelRequested = true;
    this.cancelPromise = (async () => {
      try {
        await this.append("run_cancel_requested");
        this.status = "cancelling";
        this.abortController.abort("workflow_cancelled");
        if (this.startPromise && !this.execution) await this.startPromise;
        if (this.execution) return;
        await this.settle("cancelled");
      } catch (error) {
        this.markUnknownAfterPersistenceFailure(error);
        throw error;
      }
    })();
    return this.cancelPromise;
  }

  private async executeLoop(): Promise<void> {
    try {
      while (this.status === "running" || this.status === "cancelling") {
      if (this.deadlineRequested) {
        await this.settle("failed", "WORKFLOW_DEADLINE_EXCEEDED", "Workflow deadline exceeded.");
        return;
      }
      if (this.cancelRequested || this.abortController.signal.aborted) {
        await this.settle("cancelled");
        return;
      }
      const next = this.nextStep();
      if (!next) {
        if (this.steps.every((step) => step.status === "completed")) await this.settle("completed");
        return;
      }
      await this.append("step_started", next);
      const stepState = this.steps.find((step) => step.id === next.id)!;
      stepState.status = "running";
      this.activeStepId = next.id;
      let result;
      try {
        result = await this.options.adapter.execute(next, this.executionContext());
      } catch (error) {
        result = { outcome: "failed" as const, code: "WORKFLOW_STEP_ERROR", message: error instanceof Error ? error.message : String(error) };
      }
      if (this.deadlineRequested) {
        await this.settle("failed", "WORKFLOW_DEADLINE_EXCEEDED", "Workflow deadline exceeded.");
        return;
      }
      if (this.cancelRequested || this.abortController.signal.aborted) {
        await this.settle("cancelled");
        return;
      }
      if (result.outcome === "completed") {
        stepState.status = "completed";
        stepState.output = result.output;
        await this.append("step_completed", next, result.output);
        this.activeStepId = undefined;
      } else if (result.outcome === "unknown") {
        stepState.status = "unknown";
        stepState.error = { code: result.code, message: result.message };
        await this.append("step_unknown", next, undefined, result.code, result.message);
        this.activeStepId = undefined;
        await this.settle("unknown", result.code, result.message);
        return;
      } else {
        stepState.status = "failed";
        stepState.error = { code: result.code, message: result.message };
        await this.append("step_failed", next, undefined, result.code, result.message);
        this.activeStepId = undefined;
        await this.settle("failed", result.code, result.message);
        return;
      }
      if (this.pauseRequested) {
        this.pauseRequested = false;
        await this.append("run_paused");
        this.status = "paused";
        return;
      }
    }
    } catch (error) {
      this.markUnknownAfterPersistenceFailure(error);
      throw error;
    }
  }

  private nextStep(): WorkflowStepDefinition | undefined {
    const completed = new Set(this.steps.filter((step) => step.status === "completed").map((step) => step.id));
    return this.definition.steps.find((step) => {
      const state = this.steps.find((candidate) => candidate.id === step.id)!;
      return state.status === "pending" && (step.dependsOn ?? []).every((dependency) => completed.has(dependency));
    });
  }

  private executionContext(): WorkflowExecutionContext {
    return {
      runId: this.options.runId,
      ownerId: this.options.ownerId,
      workflow: this.definition,
      input: structuredClone(this.options.input),
      completed: new Map(this.steps.filter((step) => step.status === "completed").map((step) => [step.id, structuredClone(step.output)])),
      signal: this.abortController.signal,
    };
  }

  private settle(status: Extract<WorkflowStatus, "completed" | "failed" | "cancelled" | "unknown">, code?: string, message?: string): Promise<void> {
    if (this.settlement) return this.settlement;
    if (TERMINAL.has(this.status)) return Promise.resolve();
    this.settlement = this.append(`run_${status}`, undefined, undefined, code, message).then(() => {
      this.status = status;
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    });
    return this.settlement;
  }

  private append(type: WorkflowEvent["type"], step?: WorkflowStepDefinition, output?: unknown, code?: string, message?: string): Promise<void> {
    const append = this.eventTail.then(async () => {
      const committed = await this.options.eventStore.append({
      runId: this.options.runId,
      ownerId: this.options.ownerId,
      type,
      ...(step ? { stepId: step.id } : {}),
      ...(output === undefined ? {} : { output: structuredClone(output) }),
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
      });
      this.notify(committed);
    });
    // Preserve event ordering while allowing a caller to observe an append failure.
    this.eventTail = append.catch(() => undefined);
    return append;
  }

  private notify(event: WorkflowEvent): void {
    const observer = this.options.eventObserver;
    if (!observer) return;
    try {
      void Promise.resolve(observer(structuredClone(event))).catch(() => undefined);
    } catch {
      // Observers are live projections and must never affect durable state.
    }
  }

  private async recoverInterruptedExecution(): Promise<void> {
    if (TERMINAL.has(this.status) || (this.status !== "running" && this.status !== "cancelling")) return;
    for (const step of this.steps.filter((candidate) => candidate.status === "running")) {
      await this.append("step_unknown", { id: step.id }, undefined, "WORKFLOW_INTERRUPTED", "Workflow process ended before the step settled.");
      step.status = "unknown";
      step.error = { code: "WORKFLOW_INTERRUPTED", message: "Workflow process ended before the step settled." };
    }
    await this.settle("unknown", "WORKFLOW_INTERRUPTED", "Workflow process ended before the run settled.");
  }

  private armDeadline(): void {
    if (this.deadlineAt === undefined || this.deadlineTimer || TERMINAL.has(this.status)) return;
    const delay = Math.max(0, this.deadlineAt - Date.now());
    this.deadlineTimer = setTimeout(() => {
      this.deadlineRequested = true;
      this.abortController.abort("workflow_deadline_exceeded");
    }, delay);
    if (delay === 0) this.deadlineRequested = true;
  }

  private markUnknownAfterPersistenceFailure(error: unknown): void {
    if (TERMINAL.has(this.status)) return;
    const message = error instanceof Error ? error.message : String(error);
    const activeStep = this.activeStepId ? this.steps.find((step) => step.id === this.activeStepId) : undefined;
    if (activeStep) {
      activeStep.status = "unknown";
      activeStep.error = { code: "WORKFLOW_EVENT_STORE_FAILURE", message };
    }
    this.status = "unknown";
  }

  private applyEvents(events: readonly WorkflowEvent[]): void {
    for (const event of events) {
      if (event.type === "run_started" || event.type === "run_resumed") this.status = "running";
      else if (event.type === "run_paused") this.status = "paused";
      else if (event.type === "run_cancel_requested") {
        this.status = "cancelling";
        this.cancelRequested = true;
      }
      else if (event.type.startsWith("run_")) this.status = event.type.slice(4) as WorkflowStatus;
      if (!event.stepId) continue;
      const step = this.steps.find((candidate) => candidate.id === event.stepId);
      if (!step) continue;
      if (event.type === "step_started") step.status = "running";
      else if (event.type === "step_completed") {
        step.status = "completed";
        step.output = structuredClone(event.output);
      } else if (event.type === "step_failed" || event.type === "step_unknown") {
        step.status = event.type === "step_failed" ? "failed" : "unknown";
        step.error = { code: event.code ?? "WORKFLOW_STEP_ERROR", message: event.message ?? "Workflow step did not complete." };
      }
    }
  }
}

function normalizeDeadline(value: number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const deadline = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(deadline) || deadline < 0) throw new TypeError("Workflow deadlineAt must be a finite epoch timestamp.");
  return deadline;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}
