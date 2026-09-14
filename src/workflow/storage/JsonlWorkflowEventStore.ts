import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { WorkflowEvent, WorkflowEventStore } from "../protocol/types.js";

const WORKFLOW_EVENT_TYPES: ReadonlySet<WorkflowEvent["type"]> = new Set([
  "run_created",
  "run_started",
  "run_paused",
  "run_resumed",
  "run_cancel_requested",
  "step_started",
  "step_completed",
  "step_failed",
  "step_unknown",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_unknown",
]);

export type JsonlWorkflowEventStoreOptions = {
  /** Caller-owned directory. One JSONL log is stored for each run identity. */
  directory: string;
};

/**
 * Local durable EventStore for a caller-owned workflow scope.
 *
 * It serializes writes made through this instance. Cross-process coordination
 * deliberately remains a caller concern; this provider does not claim a
 * distributed workflow lease.
 */
export class JsonlWorkflowEventStore implements WorkflowEventStore {
  private readonly directory: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: JsonlWorkflowEventStoreOptions) {
    this.directory = resolve(options.directory);
  }

  create(event: Omit<WorkflowEvent, "sequence"> & { readonly type: "run_created"; readonly definition: NonNullable<WorkflowEvent["definition"]> }): Promise<WorkflowEvent> {
    return this.serialize(event.runId, async () => {
      await mkdir(this.directory, { recursive: true });
      const committed: WorkflowEvent = { ...structuredClone(event), sequence: 1 };
      try {
        await writeFile(this.filePath(event.runId), `${JSON.stringify(committed)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (isAlreadyExists(error)) throw new Error(`Workflow run ${event.runId} already exists.`);
        throw error;
      }
      return structuredClone(committed);
    });
  }

  append(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent> {
    if (event.type === "run_created") {
      return Promise.reject(new Error("Workflow run_created must use WorkflowEventStore.create()."));
    }
    return this.serialize(event.runId, async () => {
      const events = await this.readUnchecked(event.runId);
      const created = events[0];
      if (!created || created.type !== "run_created") {
        throw new Error(`Workflow run ${event.runId} has no durable creation event.`);
      }
      if (created.ownerId !== event.ownerId) {
        throw new Error(`Workflow run ${event.runId} belongs to a different owner.`);
      }
      const committed: WorkflowEvent = { ...structuredClone(event), sequence: events.at(-1)!.sequence + 1 };
      await appendFile(this.filePath(event.runId), `${JSON.stringify(committed)}\n`, "utf8");
      return structuredClone(committed);
    });
  }

  async read(runId: string): Promise<readonly WorkflowEvent[]> {
    await this.tails.get(runId);
    return this.readUnchecked(runId);
  }

  private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve();
    const result = previous.then(operation);
    this.tails.set(runId, result.then(() => undefined, () => undefined));
    return result;
  }

  private async readUnchecked(runId: string): Promise<WorkflowEvent[]> {
    let source: string;
    try {
      source = await readFile(this.filePath(runId), "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const events = source.split("\n").filter(Boolean).map((line, index) => parseEvent(line, runId, index + 1));
    validateSequence(events, runId);
    return structuredClone(events);
  }

  private filePath(runId: string): string {
    if (!runId) throw new TypeError("Workflow runId is required.");
    return join(this.directory, `${Buffer.from(runId, "utf8").toString("base64url")}.jsonl`);
  }
}

function parseEvent(line: string, expectedRunId: string, lineNumber: number): WorkflowEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Workflow event log for ${expectedRunId} contains invalid JSON at line ${lineNumber}.`, { cause: error });
  }
  if (
    !isRecord(value)
    || value.runId !== expectedRunId
    || typeof value.ownerId !== "string"
    || typeof value.type !== "string"
    || !WORKFLOW_EVENT_TYPES.has(value.type as WorkflowEvent["type"])
    || !Number.isSafeInteger(value.sequence)
    || typeof value.sequence !== "number"
    || value.sequence < 1
  ) {
    throw new Error(`Workflow event log for ${expectedRunId} contains an invalid event at line ${lineNumber}.`);
  }
  return value as WorkflowEvent;
}

function validateSequence(events: readonly WorkflowEvent[], runId: string): void {
  if (events.length === 0) return;
  if (events[0]?.type !== "run_created") {
    throw new Error(`Workflow event log for ${runId} does not begin with run_created.`);
  }
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new Error(`Workflow event log for ${runId} has a non-contiguous sequence at ${event.sequence}.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
