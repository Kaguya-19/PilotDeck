import assert from "node:assert/strict";
import test from "node:test";

import { createHostContextRuntime } from "../../../src/agent/modules/context/index.js";
import type { HostContextModuleMethod } from "../../../src/agent/modules/protocol.js";

const binding = { runId: "run-1", operationId: "operation-1", idempotencyKey: "stable-1" };

test("host context consumer requires prepare_for_model", () => {
  assert.throws(
    () => createHostContextRuntime(async () => response({}), binding, ["capture_turn"]),
    /must support prepare_for_model/,
  );
});

test("host context consumer exposes only advertised optional operations", () => {
  const runtime = createHostContextRuntime(
    async () => response({}),
    binding,
    ["prepare_for_model", "capture_turn"],
  );

  assert.equal(typeof runtime.prepareForModel, "function");
  assert.equal(typeof runtime.captureTurn, "function");
  assert.equal(runtime.applyToolResults, undefined);
  assert.equal(runtime.recoverFromModelError, undefined);
});

test("host context consumer serializes input and preserves execution identity", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = createHostContextRuntime(async (request) => {
    calls.push(request as unknown as Record<string, unknown>);
    return response({
      messages: [],
      systemPromptParts: [],
      tools: [],
      diagnostics: [],
      boundaries: [],
      materialization: {
        promptGeneration: 4,
        runtimeContexts: [{ name: "host", text: "host context" }],
      },
    });
  }, binding, ["prepare_for_model"], () => "fixed");

  const prepared = await runtime.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    runtimeContextSurface: "user_message",
    provider: "provider",
    model: "model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
    abortSignal: new AbortController().signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.runId, "run-1");
  assert.equal(calls[0]?.operationId, "operation-1");
  assert.equal(calls[0]?.idempotencyKey, "stable-1");
  assert.equal(calls[0]?.requestId, "context-prepare_for_model-fixed");
  assert.equal(calls[0]?.module, "context");
  assert.equal(calls[0]?.recordFailure, true);
  const input = ((calls[0]?.payload as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
  assert.equal("abortSignal" in input, false);
  assert.equal(input.runtimeContextSurface, "user_message");
  assert.deepEqual(prepared.materialization, {
    promptGeneration: 4,
    runtimeContexts: [{ name: "host", text: "host context" }],
  });
});

test("host context consumer maps every advertised operation", async () => {
  const operations: HostContextModuleMethod[] = [];
  const methods: HostContextModuleMethod[] = [
    "prepare_for_model",
    "apply_tool_results",
    "recover_from_model_error",
    "capture_turn",
    "try_auto_compact",
  ];
  const runtime = createHostContextRuntime(async (request) => {
    operations.push((request.payload.operation ?? "") as HostContextModuleMethod);
    return response(request.payload.operation === "recover_from_model_error" ? { type: "none" } : {});
  }, binding, methods);

  await runtime.prepareForModel({} as never);
  await runtime.applyToolResults?.({} as never);
  await runtime.recoverFromModelError?.({} as never);
  await runtime.captureTurn?.({} as never);
  await runtime.tryAutoCompact?.({ messages: [] });

  assert.deepEqual(operations, methods);
});

test("host context consumer forwards auto compaction without local evaluator state", async () => {
  let captured: Record<string, unknown> | undefined;
  const runtime = createHostContextRuntime(async (request) => {
    captured = request as unknown as Record<string, unknown>;
    return response({ type: "skipped", snapshot: { tokens: 10, maxContextTokens: 100, ratio: 0.1 } });
  }, binding, ["prepare_for_model", "try_auto_compact"], () => "compact");

  const result = await runtime.tryAutoCompact?.({
    messages: [],
    budgetEvaluator: async () => { throw new Error("must not cross module boundary"); },
  });
  assert.equal(result?.type, "skipped");
  assert.equal(captured?.requestId, "context-try_auto_compact-compact");
  const input = ((captured?.payload as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
  assert.equal("budgetEvaluator" in input, false);
  assert.deepEqual(input.budgetProjection, {
    stage: "pre_route",
    trigger: "auto",
  });
});

test("host context consumer preserves module failure code", async () => {
  const runtime = createHostContextRuntime(async () => ({
    kind: "response",
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: false,
    code: "CONTEXT_FAILED",
    error: { message: "host context failed" },
  }), binding, ["prepare_for_model"]);

  await assert.rejects(
    () => runtime.prepareForModel({} as never),
    (error: Error & { code?: string }) => error.message === "host context failed" && error.code === "CONTEXT_FAILED",
  );
});

function response(result: unknown) {
  return {
    kind: "response" as const,
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: true,
    payload: { result },
  };
}
