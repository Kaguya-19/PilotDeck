import type {
  PilotDeckToolErrorResult,
  PilotDeckToolResult,
} from "../protocol/result.js";
import { toolError } from "../protocol/errors.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { PilotDeckToolScheduler } from "./ToolScheduler.js";

export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 32;
export const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 8;

export type ConcurrentToolSchedulerOptions = {
  maxToolCallsPerTurn?: number;
  maxConcurrentToolCalls?: number;
  dedupeSameTurnReadOnlyToolCalls?: boolean;
};

/**
 * Executes concurrency-safe tool calls in parallel and serializes the rest.
 *
 * Ordering: concurrency-safe calls run first through a bounded pool, then
 * non-safe calls run sequentially. Results are returned in the original call
 * order regardless of execution order.
 */
export class ConcurrentToolScheduler implements PilotDeckToolScheduler {
  private readonly maxToolCallsPerTurn: number;
  private readonly maxConcurrentToolCalls: number;
  private readonly dedupeSameTurnReadOnlyToolCalls: boolean;

  constructor(
    private readonly runtime: ToolRuntime,
    private readonly registry: ToolRegistry,
    options: ConcurrentToolSchedulerOptions = {},
  ) {
    this.maxToolCallsPerTurn = normalizePositiveInteger(
      options.maxToolCallsPerTurn,
      DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    );
    this.maxConcurrentToolCalls = normalizePositiveInteger(
      options.maxConcurrentToolCalls,
      DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
    );
    this.dedupeSameTurnReadOnlyToolCalls = options.dedupeSameTurnReadOnlyToolCalls ?? true;
  }

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
  ): Promise<PilotDeckToolResult[]> {
    const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
    const executableCallCount = Math.min(calls.length, this.maxToolCallsPerTurn);

    for (let i = executableCallCount; i < calls.length; i++) {
      const result = createTooManyToolCallsResult(calls[i], context, this.maxToolCallsPerTurn);
      resultSlots[i] = result;
      await recordToolAudit(result, context);
    }

    const concurrentIndices: number[] = [];
    const sequentialIndices: number[] = [];
    const duplicateTargetsByCanonicalIndex = new Map<number, number[]>();
    const canonicalIndexByDedupeKey = new Map<string, number>();

    for (let i = 0; i < executableCallCount; i++) {
      const call = calls[i];
      const tool = this.registry.get(call.name);
      const isConcurrencySafe = tool?.isConcurrencySafe(call.input) === true;
      const isReadOnly = tool?.isReadOnly(call.input) === true;
      if (
        this.dedupeSameTurnReadOnlyToolCalls &&
        tool &&
        isConcurrencySafe &&
        isReadOnly
      ) {
        const dedupeKey = buildDedupeKey(tool.name, call.input);
        const canonicalIndex = canonicalIndexByDedupeKey.get(dedupeKey);
        if (canonicalIndex !== undefined) {
          const duplicates = duplicateTargetsByCanonicalIndex.get(canonicalIndex) ?? [];
          duplicates.push(i);
          duplicateTargetsByCanonicalIndex.set(canonicalIndex, duplicates);
          continue;
        }
        canonicalIndexByDedupeKey.set(dedupeKey, i);
      }

      if (isConcurrencySafe) {
        concurrentIndices.push(i);
      } else {
        sequentialIndices.push(i);
      }
    }

    // Phase 1: run concurrency-safe calls through a bounded pool
    if (concurrentIndices.length > 0) {
      await runWithConcurrency(concurrentIndices, this.maxConcurrentToolCalls, async (idx) => {
        const result = await this.runtime.execute(calls[idx], context);
        resultSlots[idx] = result;
        for (const duplicateIdx of duplicateTargetsByCanonicalIndex.get(idx) ?? []) {
          const duplicateResult = cloneResultForToolCall(result, calls[duplicateIdx]);
          resultSlots[duplicateIdx] = duplicateResult;
          await recordToolAudit(duplicateResult, context);
        }
      });
    }

    // Phase 2: run the rest sequentially
    for (const idx of sequentialIndices) {
      const result = await this.runtime.execute(calls[idx], context);
      resultSlots[idx] = result;
      for (const duplicateIdx of duplicateTargetsByCanonicalIndex.get(idx) ?? []) {
        const duplicateResult = cloneResultForToolCall(result, calls[duplicateIdx]);
        resultSlots[duplicateIdx] = duplicateResult;
        await recordToolAudit(duplicateResult, context);
      }
    }

    return resultSlots as PilotDeckToolResult[];
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  }));
}

function cloneResultForToolCall(
  result: PilotDeckToolResult,
  call: PilotDeckToolCall,
): PilotDeckToolResult {
  return {
    ...result,
    toolCallId: call.id,
    toolName: result.toolName,
  };
}

function createTooManyToolCallsResult(
  call: PilotDeckToolCall,
  context: PilotDeckToolRuntimeContext,
  maxToolCallsPerTurn: number,
): PilotDeckToolErrorResult {
  const timestamp = (context.now?.() ?? new Date()).toISOString();
  const message = `Too many tool calls in one turn: received more than ${maxToolCallsPerTurn}. Split the work across multiple turns and call fewer tools at once.`;
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: toolError("invalid_tool_input", message, {
      maxToolCallsPerTurn,
    }),
    content: [{ type: "text", text: message }],
    metadata: {
      synthetic: true,
      reason: "max_tool_calls_per_turn",
      maxToolCallsPerTurn,
    },
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function buildDedupeKey(toolName: string, input: unknown): string {
  return `${toolName}\0${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return stringifyPrimitive(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) =>
    `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
  ).join(",")}}`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function stringifyPrimitive(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function recordToolAudit(
  result: PilotDeckToolResult,
  context: PilotDeckToolRuntimeContext,
): Promise<void> {
  await context.auditRecorder?.recordTool({
    type: "tool",
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    status: result.type === "success" ? "success" : "error",
    errorCode: result.type === "error" ? result.error.code : undefined,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime(),
  });
}
