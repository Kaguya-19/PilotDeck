import assert from "node:assert/strict";
import test from "node:test";

import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";

test("default sidecar factory maps host-neutral execution payloads", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      sessionId: "session-1",
      turnId: "turn-1",
      operationDeadline: "2026-09-02T00:01:00.000Z",
      payload: {
        agent: {
          provider: "provider-a",
          model: "model-a",
          cwd: "/workspace",
          systemPrompt: "Use the host tools.",
          maxTurns: 2,
          runMode: "ask",
          modelOverride: { provider: "provider-b", model: "model-b" },
        },
        task: { prompt: "Inspect the input." },
        messages: [
          { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
          { role: "assistant", content: "Acknowledged" },
        ],
        permissionContext: {
          mode: "plan",
          canPrompt: true,
          bypassAvailable: false,
          rules: { deny: [{ toolName: "shell" }] },
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "session-1");
  assert.equal(execution.input.turnId, "turn-1");
  assert.equal(execution.input.maxTurns, 2);
  assert.equal(execution.input.runMode, "ask");
  assert.equal(execution.input.permissionMode, "plan");
  assert.equal(execution.input.canPrompt, true);
  assert.deepEqual(execution.input.modelOverride, { provider: "provider-b", model: "model-b" });
  assert.deepEqual(execution.input.execution, {
    runId: "run-1",
    operationId: "operation-1",
    idempotencyKey: undefined,
    operationDeadline: "2026-09-02T00:01:00.000Z",
  });
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Inspect the input." }] },
    { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
    { role: "assistant", content: [{ type: "text", text: "Acknowledged" }] },
  ]);
});

test("default sidecar factory validates and restores generic seed state", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        task: { prompt: "Resumed task" },
        seedState: { allowedReadFiles: ["/workspace/input.txt"] },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "operation-1");
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Resumed task" }] },
  ]);
  assert.deepEqual(execution.loop.snapshotFileState().allowedReadFiles, ["/workspace/input.txt"]);
});

test("default sidecar factory rejects malformed generic seed state", async () => {
  await assert.rejects(
    async () => createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-1",
        method: "execute",
        runId: "run-1",
        operationId: "operation-1",
        requestId: "request-1",
        payload: { seedState: { allowedReadFiles: [42] } },
      },
      abortSignal: new AbortController().signal,
      callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
    }),
    /allowedReadFiles/,
  );
});
