import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { PilotDeckBackgroundBashTask } from "../protocol/types.js";

export const BACKGROUND_TASK_SNAPSHOT_VERSION = 1;

export type PersistedBackgroundTask = {
  task: Omit<PilotDeckBackgroundBashTask, "startedAt" | "endedAt"> & {
    startedAt: string;
    endedAt?: string;
  };
  output: {
    totalBytes: number;
    persisted: boolean;
  };
};

/**
 * Project-scoped durable metadata for detached tasks. The provider deliberately
 * does not own a child process, completion subscription, Gateway state, or
 * Session state. A restored non-terminal task is reconciled by the runtime,
 * never by this storage layer.
 */
export type BackgroundTaskSnapshotStore = {
  load(): readonly PersistedBackgroundTask[];
  write(snapshot: PersistedBackgroundTask): Promise<void>;
  flush(): Promise<void>;
};

export class BackgroundTaskSnapshotRecoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackgroundTaskSnapshotRecoveryError";
  }
}

export type JsonFileBackgroundTaskSnapshotStoreOptions = {
  filePath: string;
};

/**
 * Node provider for a compact project-level snapshot. Loading is synchronous
 * because project runtime composition is synchronous; writes are serialized
 * and atomically replaced so a restart observes either the previous complete
 * snapshot or the next complete snapshot.
 */
export class JsonFileBackgroundTaskSnapshotStore implements BackgroundTaskSnapshotStore {
  private readonly filePath: string;
  private readonly entries = new Map<string, PersistedBackgroundTask>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: JsonFileBackgroundTaskSnapshotStoreOptions) {
    this.filePath = resolve(options.filePath);
    for (const entry of loadSnapshotFile(this.filePath)) {
      this.entries.set(entry.task.taskId, entry);
    }
  }

  load(): readonly PersistedBackgroundTask[] {
    return [...this.entries.values()].map(cloneSnapshot);
  }

  write(snapshot: PersistedBackgroundTask): Promise<void> {
    const stable = validateSnapshot(cloneSnapshot(snapshot));
    this.entries.set(stable.task.taskId, stable);
    const write = this.writeTail.then(() => this.writeCurrent());
    // A failed write must reject its caller, but later attempts still need a
    // chance to persist a newly settled task.
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private async writeCurrent(): Promise<void> {
    const payload = JSON.stringify({
      version: BACKGROUND_TASK_SNAPSHOT_VERSION,
      tasks: [...this.entries.values()],
    });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, payload, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function loadSnapshotFile(filePath: string): PersistedBackgroundTask[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new BackgroundTaskSnapshotRecoveryError(
      `Could not read background task snapshot ${filePath}.`,
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BackgroundTaskSnapshotRecoveryError(
      `Background task snapshot ${filePath} is not valid JSON; recovery is required.`,
      { cause: error },
    );
  }
  if (!isRecord(value) || value.version !== BACKGROUND_TASK_SNAPSHOT_VERSION || !Array.isArray(value.tasks)) {
    throw new BackgroundTaskSnapshotRecoveryError(
      `Background task snapshot ${filePath} has an unsupported schema; recovery is required.`,
    );
  }

  const seen = new Set<string>();
  return value.tasks.map((entry, index) => {
    let snapshot: PersistedBackgroundTask;
    try {
      snapshot = validateSnapshot(entry);
    } catch (error) {
      throw new BackgroundTaskSnapshotRecoveryError(
        `Background task snapshot ${filePath} has an invalid task at index ${index}; recovery is required.`,
        { cause: error },
      );
    }
    if (seen.has(snapshot.task.taskId)) {
      throw new BackgroundTaskSnapshotRecoveryError(
        `Background task snapshot ${filePath} repeats taskId ${JSON.stringify(snapshot.task.taskId)}; recovery is required.`,
      );
    }
    seen.add(snapshot.task.taskId);
    return snapshot;
  });
}

function validateSnapshot(value: unknown): PersistedBackgroundTask {
  if (!isRecord(value) || !isRecord(value.task) || !isRecord(value.output)) {
    throw new TypeError("Background task snapshot must contain task and output objects.");
  }
  const task = value.task;
  const output = value.output;
  assertNonEmptyString(task.taskId, "task.taskId");
  if (task.type !== "local_bash") throw new TypeError("task.type must be local_bash.");
  if (task.kind !== "bash" && task.kind !== "monitor") throw new TypeError("task.kind is invalid.");
  assertNonEmptyString(task.command, "task.command");
  assertNonEmptyString(task.cwd, "task.cwd");
  if (!isTaskStatus(task.status)) throw new TypeError("task.status is invalid.");
  assertBoolean(task.completionStatusSentInAttachment, "task.completionStatusSentInAttachment");
  assertNonNegativeSafeInteger(task.lastReportedTotalLines, "task.lastReportedTotalLines");
  assertBoolean(task.isBackgrounded, "task.isBackgrounded");
  assertBoolean(task.interrupted, "task.interrupted");
  assertIsoDate(task.startedAt, "task.startedAt");
  if (task.endedAt !== undefined) assertIsoDate(task.endedAt, "task.endedAt");
  if (task.agentId !== undefined) assertString(task.agentId, "task.agentId");
  if (task.sessionId !== undefined) assertString(task.sessionId, "task.sessionId");
  if (task.pid !== undefined) assertNonNegativeSafeInteger(task.pid, "task.pid");
  if (task.exitCode !== undefined && task.exitCode !== null) assertSafeInteger(task.exitCode, "task.exitCode");
  assertNonNegativeSafeInteger(task.outputBytes, "task.outputBytes");
  assertNonNegativeSafeInteger(output.totalBytes, "output.totalBytes");
  assertBoolean(output.persisted, "output.persisted");
  if (task.outputBytes !== output.totalBytes) {
    throw new TypeError("task.outputBytes must equal output.totalBytes.");
  }
  if (output.totalBytes > 0 && !output.persisted) {
    throw new TypeError("non-empty task output must have durable output storage.");
  }
  return value as unknown as PersistedBackgroundTask;
}

function cloneSnapshot(snapshot: PersistedBackgroundTask): PersistedBackgroundTask {
  return structuredClone(snapshot);
}

function isTaskStatus(value: unknown): boolean {
  return value === "pending"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "unknown";
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (!value) throw new TypeError(`${name} must be non-empty.`);
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
}

function assertSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer.`);
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  assertSafeInteger(value, name);
  if (value < 0) throw new TypeError(`${name} must be non-negative.`);
}

function assertIsoDate(value: unknown, name: string): asserts value is string {
  assertNonEmptyString(value, name);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
