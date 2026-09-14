import type {
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckTaskOutputSlice,
} from "../protocol/types.js";

/** Provider-neutral request accepted by the background-task tool consumer. */
export type StartTaskSpec = {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  sessionId?: string;
  agentId?: string;
  kind?: PilotDeckBackgroundTaskKind;
};

export type StopTaskOptions = {
  graceMs?: number;
};

/** Exact session identity used to fence model-facing task control calls. */
export type BackgroundTaskAccess = {
  sessionId: string;
};

export type WaitTaskOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type WaitTaskResult = {
  task: PilotDeckBackgroundBashTask;
  timedOut: boolean;
  outcome: "completed" | "timeout" | "aborted" | "unknown";
  waitedMs: number;
};

/**
 * Minimal task-control capability consumed by the `task_*` tools.
 *
 * Task process ownership and provider disposal intentionally stay outside this
 * port: those belong to the project-scoped execution-world composition.
 */
export type BackgroundTaskPort = {
  start(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask>;
  list(
    filter?: PilotDeckBackgroundTaskListFilter,
    access?: BackgroundTaskAccess,
  ): readonly PilotDeckBackgroundBashTask[];
  get(taskId: string, access?: BackgroundTaskAccess): PilotDeckBackgroundBashTask | undefined;
  getOutput(
    taskId: string,
    offset: number,
    maxBytes?: number,
    access?: BackgroundTaskAccess,
  ): PilotDeckTaskOutputSlice;
  wait(
    taskId: string,
    options?: WaitTaskOptions,
    access?: BackgroundTaskAccess,
  ): Promise<WaitTaskResult | undefined>;
  stop(taskId: string, options?: StopTaskOptions, access?: BackgroundTaskAccess): Promise<void>;
};
