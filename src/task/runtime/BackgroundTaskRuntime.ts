/**
 * `BackgroundTaskRuntime` — the central registry + spawn / kill orchestrator
 * for C5 background bash tasks (§6.5). Mirrors the legacy upstream
 * LocalShellTask behaviour (T1-T11).
 *
 * Process model:
 *   - `start(spec)` asks the injected detached-shell provider to spawn a
 *     *detached* child and immediately returns a task handle so the PilotDeck
 *     process can exit without waiting for the child. (T11)
 *   - stdout / stderr are piped into a `TaskOutputStore` (1 MB ring buffer
 *     + optional disk spill). The runtime never blocks on the stream — the
 *     child runs free until either it exits or `stop` is called.
 *   - `stop(taskId)` issues SIGTERM and, after `graceMs` (default 5000),
 *     escalates to SIGKILL.
 *   - `killForAgent(agentId)` and `killAll()` provide the SessionRouter
 *     hooks the cron-PR coordination notes call for (priority window
 *     200-299, see §6.5.5 step 7 of the deferred-feature guide).
 *
 * Platform support: macOS, Linux, and Windows. On Windows, `child.kill()`
 * maps SIGTERM/SIGKILL to TerminateProcess; `detached` creates a new
 * console group rather than a Unix process group.
 */

import { randomUUID } from "node:crypto";
import { TaskOutputStore } from "../storage/TaskOutputStore.js";
import type {
  BackgroundTaskSnapshotStore,
  PersistedBackgroundTask,
} from "../storage/BackgroundTaskSnapshotStore.js";
import {
  createNodeDetachedShellPort,
  type DetachedShellHandle,
  type DetachedShellPort,
} from "../../tool/execution-world/DetachedShellPort.js";
import type {
  BackgroundTaskPort,
  BackgroundTaskAccess,
  StartTaskSpec,
  StopTaskOptions,
  WaitTaskOptions,
  WaitTaskResult,
} from "./BackgroundTaskPort.js";
import {
  BackgroundTaskCompletionEventBus,
  type BackgroundTaskCompletionEvent,
  type BackgroundTaskCompletionHandler,
  type BackgroundTaskCompletionSubscription,
} from "./BackgroundTaskCompletionEvents.js";
import type {
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckTaskOutputSlice,
} from "../protocol/types.js";

/** Compatibility exports for consumers that imported task request types from the native provider. */
export type {
  BackgroundTaskPort,
  BackgroundTaskAccess,
  StartTaskSpec,
  StopTaskOptions,
  WaitTaskOptions,
  WaitTaskResult,
} from "./BackgroundTaskPort.js";
export type {
  BackgroundTaskCompletionEvent,
  BackgroundTaskCompletionHandler,
  BackgroundTaskCompletionSubscription,
} from "./BackgroundTaskCompletionEvents.js";

export type BackgroundTaskRuntimeOptions = {
  /** Optional dir under which to spill output (default: in-memory only). */
  diskSpillDir?: string;
  /** Override `now()` for deterministic tests. */
  now?: () => Date;
  /** Execution-world detached shell provider. */
  shell?: DetachedShellPort;
  /** Compatibility override for the native provider's spawn function. */
  spawn?: typeof import("node:child_process").spawn;
  /** Hard cap on simultaneous tasks (default: 32). */
  maxTasks?: number;
  /** Optional completion sink for hosts that want one-shot background task notifications. */
  onCompletion?: BackgroundTaskCompletionHandler;
  /** Optional diagnostic sink for failures from live completion observers. */
  onCompletionSubscriberError?: (error: unknown, event: BackgroundTaskCompletionEvent) => void;
  /** Maximum bytes included in completion output previews (default: 4000). */
  completionPreviewBytes?: number;
  /** Project-owned durable metadata and output-recovery boundary. */
  snapshotStore?: BackgroundTaskSnapshotStore;
  /** Fail-closed persistence diagnostics; live task cleanup still continues. */
  onDiagnostic?: (error: unknown) => void;
};

type RuntimeEntry = {
  task: PilotDeckBackgroundBashTask;
  child?: DetachedShellHandle;
  output: TaskOutputStore;
  /** Resolved when the child has fully exited (success, failure, or kill). */
  done: Promise<void>;
};

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_TASKS = 32;
const DEFAULT_COMPLETION_PREVIEW_BYTES = 4_000;

export class BackgroundTaskStateUnknownError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} has an unknown restored state and cannot be waited or stopped.`);
    this.name = "BackgroundTaskStateUnknownError";
  }
}

export class BackgroundTaskRuntime implements BackgroundTaskPort {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly completionEvents: BackgroundTaskCompletionEventBus;
  private state: "active" | "draining" | "disposed" = "active";
  private activeStarts = 0;
  private startDrainPromise?: Promise<void>;
  private resolveStartDrain?: () => void;
  private disposePromise?: Promise<void>;
  private readonly options: Required<
    Pick<BackgroundTaskRuntimeOptions, "now" | "maxTasks" | "shell">
  > &
    Pick<
      BackgroundTaskRuntimeOptions,
      "diskSpillDir" | "onCompletion" | "completionPreviewBytes" | "snapshotStore" | "onDiagnostic"
    >;

  constructor(options: BackgroundTaskRuntimeOptions = {}) {
    if (options.snapshotStore && !options.diskSpillDir) {
      throw new TypeError("Background task durable recovery requires diskSpillDir for output recovery.");
    }
    this.options = {
      now: options.now ?? (() => new Date()),
      shell: options.shell ?? createNodeDetachedShellPort(options.spawn),
      maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
      diskSpillDir: options.diskSpillDir,
      onCompletion: options.onCompletion,
      completionPreviewBytes: options.completionPreviewBytes ?? DEFAULT_COMPLETION_PREVIEW_BYTES,
      snapshotStore: options.snapshotStore,
      onDiagnostic: options.onDiagnostic,
    };
    this.completionEvents = new BackgroundTaskCompletionEventBus({
      onSubscriberError: options.onCompletionSubscriberError,
    });
    this.restoreSnapshots();
  }

  /** Subscribe to volatile task settlement events without exposing process internals. */
  subscribeCompletionEvents(handler: BackgroundTaskCompletionHandler): BackgroundTaskCompletionSubscription {
    if (this.state !== "active") {
      throw new Error(`Cannot subscribe to background task completion events; runtime is ${this.state}.`);
    }
    return this.completionEvents.subscribe(handler);
  }

  list(
    filter: PilotDeckBackgroundTaskListFilter = {},
    access?: BackgroundTaskAccess,
  ): PilotDeckBackgroundBashTask[] {
    const result: PilotDeckBackgroundBashTask[] = [];
    for (const entry of this.entries.values()) {
      if (!canAccessTask(entry.task, access)) continue;
      if (filter.agentId && entry.task.agentId !== filter.agentId) continue;
      if (filter.kind && entry.task.kind !== filter.kind) continue;
      if (filter.status) {
        const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!wanted.includes(entry.task.status)) continue;
      }
      result.push(entry.task);
    }
    return result;
  }

  get(taskId: string, access?: BackgroundTaskAccess): PilotDeckBackgroundBashTask | undefined {
    return this.findEntry(taskId, access)?.task;
  }

  async wait(
    taskId: string,
    options: WaitTaskOptions = {},
    access?: BackgroundTaskAccess,
  ): Promise<WaitTaskResult | undefined> {
    const entry = this.findEntry(taskId, access);
    if (!entry) return undefined;

    const startedAt = Date.now();
    if (entry.task.status === "unknown") {
      return {
        task: entry.task,
        timedOut: false,
        outcome: "unknown",
        waitedMs: Date.now() - startedAt,
      };
    }
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 0));
    const timeoutPromise = timeoutMs > 0
      ? new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), timeoutMs).unref?.();
        })
      : undefined;
    let abortHandler: (() => void) | undefined;
    const abortPromise = options.abortSignal
      ? new Promise<"aborted">((resolve) => {
          if (options.abortSignal?.aborted) {
            resolve("aborted");
            return;
          }
          abortHandler = () => resolve("aborted");
          options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
        })
      : undefined;

    const waits: Array<Promise<void | "timeout" | "aborted">> = [entry.done];
    if (timeoutPromise) waits.push(timeoutPromise);
    if (abortPromise) waits.push(abortPromise);
    const result = await Promise.race(waits);
    if (abortHandler) {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    }

    const outcome = result === "timeout"
      ? "timeout"
      : result === "aborted"
        ? "aborted"
        : "completed";
    return {
      task: entry.task,
      timedOut: outcome === "timeout" || outcome === "aborted",
      outcome,
      waitedMs: Date.now() - startedAt,
    };
  }

  /**
   * Spawn the command in the background. Resolves once the child has been
   * forked (typically <10 ms). `task.status` flips to `running` on spawn
   * and `completed` / `failed` / `cancelled` later via the `exit` listener.
   */
  async start(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask> {
    if (this.state !== "active") {
      throw new Error(`Background task runtime is ${this.state}; refusing a new task.`);
    }
    this.activeStarts += 1;
    try {
      return await this.startTask(spec);
    } finally {
      this.activeStarts -= 1;
      if (this.activeStarts === 0) {
        this.resolveStartDrain?.();
        this.resolveStartDrain = undefined;
        this.startDrainPromise = undefined;
      }
    }
  }

  private async startTask(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask> {
    const activeTaskCount = [...this.entries.values()].filter((entry) =>
      entry.task.status === "pending" || entry.task.status === "running",
    ).length;
    if (activeTaskCount >= this.options.maxTasks) {
      throw new Error(
        `BackgroundTaskRuntime: max tasks (${this.options.maxTasks}) exceeded.`,
      );
    }

    const taskId = randomUUID();
    const startedAt = this.options.now();
    const task: PilotDeckBackgroundBashTask = {
      taskId,
      type: "local_bash",
      agentId: spec.agentId,
      sessionId: spec.sessionId,
      kind: spec.kind ?? "bash",
      command: spec.command,
      cwd: spec.cwd,
      status: "pending",
      completionStatusSentInAttachment: false,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
      interrupted: false,
      startedAt,
      outputBytes: 0,
    };

    const output = new TaskOutputStore({
      taskId,
      diskSpillDir: this.options.diskSpillDir,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const entry: RuntimeEntry = { task, output, done };
    this.entries.set(taskId, entry);
    try {
      // Admission becomes durable before a provider can create a child.
      await this.persistEntry(entry);
    } catch (error) {
      this.entries.delete(taskId);
      await output.close();
      throw error;
    }

    let child: DetachedShellHandle;
    try {
      child = await this.options.shell.start({
        command: spec.command,
        cwd: spec.cwd,
        env: spec.env,
        onStdout: (chunk) => this.appendOutput(entry, chunk),
        onStderr: (chunk) => this.appendOutput(entry, chunk),
        onError: (err) => this.appendOutput(entry, Buffer.from(`error: ${err.message}\n`)),
      });
    } catch (err) {
      task.status = "failed";
      task.completionStatusSentInAttachment = true;
      task.endedAt = this.options.now();
      const message = err instanceof Error ? err.message : String(err);
      this.appendOutput(entry, Buffer.from(`spawn error: ${message}\n`));
      await this.settleEntry(entry);
      resolveDone();
      return task;
    }

    entry.child = child;
    task.status = "running";
    task.pid = typeof child.pid === "number" ? child.pid : undefined;

    child.exit.then(
      ({ exitCode: code, exitSignal: signal }) => {
        task.endedAt = this.options.now();
        task.exitCode = code ?? null;
        task.outputBytes = output.totalBytes();
        if (task.interrupted || signal === "SIGTERM" || signal === "SIGKILL") {
          task.status = "cancelled";
        } else if (typeof code === "number" && code === 0) {
          task.status = "completed";
        } else {
          task.status = "failed";
        }
        task.completionStatusSentInAttachment = true;
        void this.settleEntry(entry).finally(resolveDone);
      },
      (error: unknown) => {
        task.endedAt = this.options.now();
        task.exitCode = null;
        task.status = "failed";
        const message = error instanceof Error ? error.message : String(error);
        this.appendOutput(entry, Buffer.from(`exit error: ${message}\n`));
        task.completionStatusSentInAttachment = true;
        void this.settleEntry(entry).finally(resolveDone);
      },
    );

    try {
      // Synchronous provider output may arrive before start() resolves.
      await this.persistEntry(entry, { flushOutput: true });
    } catch (error) {
      task.interrupted = true;
      this.reportDiagnostic(error);
      try {
        child.terminate("SIGTERM");
      } catch {
        // The provider may have already reported an exit.
      }
      throw error;
    }
    return task;
  }

  /**
   * Stop a task: SIGTERM, wait `graceMs`, then SIGKILL if still alive.
   * Idempotent: stopping an already-finished task is a no-op.
   */
  async stop(
    taskId: string,
    options: StopTaskOptions = {},
    access?: BackgroundTaskAccess,
  ): Promise<void> {
    const entry = this.findEntry(taskId, access);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    const { task, child, done } = entry;
    if (task.status === "unknown") throw new BackgroundTaskStateUnknownError(taskId);
    if (task.status !== "running") return;
    if (!child) return;
    task.interrupted = true;
    try {
      child.terminate("SIGTERM");
    } catch {
      // child already exited
    }
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          try {
            child.terminate("SIGKILL");
          } catch {
            // already exited between the timer firing and kill()
          }
          resolve();
        }, graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await done;
  }

  /** Kill every task created with `agentId`. */
  async killForAgent(agentId: string): Promise<void> {
    const targets = [...this.entries.values()].filter(
      (e) => e.task.agentId === agentId && e.task.status === "running",
    );
    await Promise.all(targets.map((e) => this.stop(e.task.taskId)));
  }

  /** Kill every running task (intended for SessionRouter onSessionEnd). */
  async killAll(): Promise<void> {
    const targets = [...this.entries.values()].filter((e) => e.task.status === "running");
    await Promise.all(targets.map((e) => this.stop(e.task.taskId)));
  }

  /**
   * Composition-owner lifecycle: stop admitting tasks, settle starts already
   * accepted by the detached-shell provider, then terminate and drain all
   * running children. Output remains readable until this promise resolves.
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state = "draining";
    this.disposePromise = (async () => {
      await this.whenStartsDrained();
      await this.killAll();
      await Promise.all([...this.entries.values()].map((entry) => entry.done));
      await Promise.all([...this.entries.values()].map((entry) => entry.output.close()));
      await this.options.snapshotStore?.flush();
      this.completionEvents.dispose();
      this.state = "disposed";
    })();
    return this.disposePromise;
  }

  getOutput(
    taskId: string,
    offset: number,
    maxBytes?: number,
    access?: BackgroundTaskAccess,
  ): PilotDeckTaskOutputSlice {
    const entry = this.findEntry(taskId, access);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    return entry.output.readSlice(offset, maxBytes);
  }

  /** Convenience used in tests: `await runtime.waitFor(taskId)`. */
  async waitFor(taskId: string): Promise<PilotDeckBackgroundBashTask> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    await entry.done;
    return entry.task;
  }

  private whenStartsDrained(): Promise<void> {
    if (this.activeStarts === 0) return Promise.resolve();
    if (!this.startDrainPromise) {
      this.startDrainPromise = new Promise<void>((resolve) => {
        this.resolveStartDrain = resolve;
      });
    }
    return this.startDrainPromise;
  }

  private findEntry(taskId: string, access?: BackgroundTaskAccess): RuntimeEntry | undefined {
    const entry = this.entries.get(taskId);
    return entry && canAccessTask(entry.task, access) ? entry : undefined;
  }

  private restoreSnapshots(): void {
    const store = this.options.snapshotStore;
    if (!store) return;
    for (const snapshot of store.load()) {
      const task = restoreTask(snapshot.task);
      const wasUnsettled = task.status === "pending" || task.status === "running";
      if (wasUnsettled) {
        task.status = "unknown";
        task.pid = undefined;
        task.exitCode = undefined;
        task.endedAt = undefined;
        task.completionStatusSentInAttachment = false;
      }
      const output = new TaskOutputStore({
        taskId: task.taskId,
        diskSpillDir: this.options.diskSpillDir,
        restore: { expectedTotalBytes: snapshot.output.totalBytes },
      });
      const entry: RuntimeEntry = { task, output, done: Promise.resolve() };
      this.entries.set(task.taskId, entry);
      if (wasUnsettled) {
        // The live runtime never exposes the old running state. Persisting the
        // reconciliation is best effort here; a later successful write keeps
        // future restarts fail-closed even after this process exits quickly.
        void this.persistEntry(entry).catch((error) => this.reportDiagnostic(error));
      }
    }
  }

  private appendOutput(entry: RuntimeEntry, chunk: Buffer | string): void {
    entry.output.append(chunk);
    entry.task.outputBytes = entry.output.totalBytes();
    void this.persistEntry(entry).catch((error) => this.reportDiagnostic(error));
  }

  private async settleEntry(entry: RuntimeEntry): Promise<void> {
    entry.task.outputBytes = entry.output.totalBytes();
    try {
      await this.persistEntry(entry, { flushOutput: true });
    } catch (error) {
      this.reportDiagnostic(error);
      return;
    }
    this.notifyCompletion(entry.task, entry.output);
  }

  private async persistEntry(
    entry: RuntimeEntry,
    options: { flushOutput?: boolean } = {},
  ): Promise<void> {
    const store = this.options.snapshotStore;
    if (!store) return;
    if (options.flushOutput) await entry.output.flush();
    entry.task.outputBytes = entry.output.totalBytes();
    await store.write({
      task: persistTask(entry.task),
      output: {
        totalBytes: entry.output.totalBytes(),
        persisted: entry.output.hasDurableOutput(),
      },
    });
  }

  private reportDiagnostic(error: unknown): void {
    try {
      this.options.onDiagnostic?.(error);
    } catch {
      // Diagnostic observers cannot change task cleanup or completion state.
    }
  }

  private notifyCompletion(task: PilotDeckBackgroundBashTask, output: TaskOutputStore): void {
    if (!task.endedAt || !isTerminalTaskStatus(task.status)) return;
    const previewBytes = Math.max(0, this.options.completionPreviewBytes ?? DEFAULT_COMPLETION_PREVIEW_BYTES);
    const totalBytes = output.totalBytes();
    const slice = output.readSlice(Math.max(0, totalBytes - previewBytes), previewBytes);
    const event: BackgroundTaskCompletionEvent = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: task.status as BackgroundTaskCompletionEvent["status"],
      exitCode: task.exitCode,
      outputPreview: slice.content,
      totalBytes,
      startedAt: task.startedAt.toISOString(),
      endedAt: task.endedAt.toISOString(),
    };
    try {
      this.options.onCompletion?.(event);
    } catch {
      // Completion notifications are best-effort and must never break task cleanup.
    }
    this.completionEvents.emit(event);
  }
}

function canAccessTask(
  task: PilotDeckBackgroundBashTask,
  access: BackgroundTaskAccess | undefined,
): boolean {
  return access === undefined || task.sessionId === access.sessionId;
}

function isTerminalTaskStatus(
  status: PilotDeckBackgroundBashTask["status"],
): status is Extract<PilotDeckBackgroundBashTask["status"], "completed" | "failed" | "cancelled"> {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function persistTask(task: PilotDeckBackgroundBashTask): PersistedBackgroundTask["task"] {
  const { startedAt, endedAt, ...rest } = task;
  return {
    ...rest,
    startedAt: startedAt.toISOString(),
    ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
  };
}

function restoreTask(snapshot: PersistedBackgroundTask["task"]): PilotDeckBackgroundBashTask {
  const { startedAt, endedAt, ...rest } = snapshot;
  return {
    ...rest,
    startedAt: new Date(startedAt),
    ...(endedAt ? { endedAt: new Date(endedAt) } : {}),
  };
}
