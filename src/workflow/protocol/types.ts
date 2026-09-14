/** Generic workflow contracts. Domain runtimes should adapt to these ports; they do not move their state here. */

export type WorkflowStatus =
  | "created"
  | "running"
  | "paused"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type WorkflowStepDefinition = {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly capability?: string;
};

export type WorkflowDefinition = {
  readonly id: string;
  readonly version: string;
  readonly steps: readonly WorkflowStepDefinition[];
};

export type WorkflowStepResult =
  | { readonly outcome: "completed"; readonly output?: unknown }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string; readonly retryable?: boolean }
  | { readonly outcome: "unknown"; readonly code: string; readonly message: string };

export type WorkflowExecutionContext = {
  readonly runId: string;
  readonly ownerId: string;
  readonly workflow: WorkflowDefinition;
  readonly input: unknown;
  readonly completed: ReadonlyMap<string, unknown>;
  readonly signal: AbortSignal;
};

export type WorkflowExecutionAdapter = {
  execute(
    step: WorkflowStepDefinition,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowStepResult>;
};

export type WorkflowEventType =
  | "run_created"
  | "run_started"
  | "run_paused"
  | "run_resumed"
  | "run_cancel_requested"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "step_unknown"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_unknown";

export type WorkflowEvent = {
  readonly sequence: number;
  readonly runId: string;
  readonly ownerId: string;
  readonly type: WorkflowEventType;
  /** Present only on run_created and is the durable binding used by restore. */
  readonly definition?: WorkflowDefinition;
  /** Present only on run_created and is the durable input used by restore. */
  readonly input?: unknown;
  readonly deadlineAt?: number;
  readonly stepId?: string;
  readonly output?: unknown;
  readonly code?: string;
  readonly message?: string;
};

/** Read-only live projection hook; observer failures never change run state. */
export type WorkflowEventObserver = (event: WorkflowEvent) => void | Promise<void>;

export type WorkflowEventStore = {
  /** Atomically creates a run. Providers must reject an existing runId. */
  create(event: Omit<WorkflowEvent, "sequence"> & {
    readonly type: "run_created";
    readonly definition: WorkflowDefinition;
  }): Promise<WorkflowEvent>;
  append(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent>;
  read(runId: string): Promise<readonly WorkflowEvent[]>;
};

export type WorkflowStepSnapshot = {
  readonly id: string;
  readonly status: WorkflowStepStatus;
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
};

export type WorkflowSnapshot = {
  readonly runId: string;
  readonly ownerId: string;
  readonly status: WorkflowStatus;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly input: unknown;
  readonly deadlineAt?: number;
  readonly steps: readonly WorkflowStepSnapshot[];
};

/** Caller-held live handle; it carries no ambient Session/Gateway ownership. */
export type WorkflowRunHandle = {
  getSnapshot(): WorkflowSnapshot;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};

/** Minimal control consumer for a caller-facing workflow run. */
export type WorkflowControlConsumer = {
  start(): Promise<void>;
  status(): WorkflowSnapshot;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};
