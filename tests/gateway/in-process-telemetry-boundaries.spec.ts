import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function telemetryRecorder(calls: Array<{ kind: string; value: unknown }>): never {
  return {
    trackFeatureLoopStage: (value: unknown) => calls.push({ kind: "stage", value }),
    trackError: (value: unknown, metadata: unknown) => calls.push({ kind: "error", value: { value, metadata } }),
  } as never;
}

test("InProcessGateway records deterministic telemetry for model, tool, permission and subagent events", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const session: AgentSession = {
    async *submit() {
      yield { type: "model_event", sessionId: "s", turnId: "run", event: { type: "request_started", provider: "p", model: "m", providerBaseUrl: "http://provider" } };
      yield { type: "model_event", sessionId: "s", turnId: "run", event: { type: "message_end", finishReason: "stop" } };
      yield { type: "model_event", sessionId: "s", turnId: "run", event: { type: "error", error: { code: "rate_limit_error", message: "limited", provider: "p" } } };
      yield { type: "tool_calls_detected", sessionId: "s", turnId: "run", calls: [{ id: "call", name: "bash", input: {} }] };
      yield { type: "pre_tool_execute", sessionId: "s", turnId: "run", toolCallId: "call", toolName: "bash" };
      yield { type: "post_tool_execute", sessionId: "s", turnId: "run", toolCallId: "call", toolName: "bash", success: false };
      yield { type: "tool_result", sessionId: "s", turnId: "run", result: { type: "error", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "bad" }], error: { code: "invalid_arguments", message: "bad" }, startedAt: "", completedAt: "" } };
      yield { type: "permission_requested", sessionId: "s", turnId: "run", toolCallId: "call", toolName: "bash" };
      yield { type: "permission_denied", sessionId: "s", turnId: "run", toolName: "bash", reason: "no" };
      yield { type: "subagent_model_event", sessionId: "s", turnId: "run", subagentId: "a", subagentType: "explore", event: { type: "request_started", provider: "p", model: "m", providerBaseUrl: "http://provider" } };
      yield { type: "subagent_model_event", sessionId: "s", turnId: "run", subagentId: "a", subagentType: "explore", event: { type: "message_end", finishReason: "stop" } };
      yield { type: "subagent_model_event", sessionId: "s", turnId: "run", subagentId: "a", subagentType: "explore", event: { type: "error", error: { code: "server_error", message: "down", provider: "p" } } };
      yield { type: "subagent_tool_calls_detected", sessionId: "s", turnId: "run", subagentId: "a", subagentType: "explore", calls: [{ id: "sub-call", name: "read_file", input: {} }] };
      yield { type: "subagent_tool_result", sessionId: "s", turnId: "run", subagentId: "a", subagentType: "explore", result: { type: "error", toolCallId: "sub-call", toolName: "read_file", content: [{ type: "text", text: "bad" }], error: { code: "parse_error", message: "bad" }, startedAt: "", completedAt: "" } };
      yield { type: "turn_failed", sessionId: "s", turnId: "run", error: { code: "turn_failed", message: "failed", provider: "p" } };
      yield { type: "session_aborted", sessionId: "s", reason: "stop" };
      yield { type: "turn_completed", sessionId: "s", turnId: "run", result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" } };
    },
    abort: () => undefined,
    snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: async () => session });
  const gateway = new InProcessGateway(router, { telemetry: telemetryRecorder(calls) as never });
  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "hello",
    runId: "run",
    telemetry: { ownerModule: "session", executionKind: "user_session", phase: "test" },
  }));
  assert.equal(events.some((event) => (event as { type?: string }).type === "turn_completed"), true);
  assert.equal(calls.filter((call) => call.kind === "stage").length >= 8, true);
  assert.equal(calls.filter((call) => call.kind === "error").length >= 4, true);
  router.shutdown();
});

test("InProcessGateway isolates config refresh, attachment resolution and model-selection callbacks", async (t) => {
  let receivedInput: unknown;
  let receivedOptions: unknown;
  let cwd: unknown;
  const statusCalls: unknown[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  t.after(() => { console.warn = originalWarn; });
  const session: AgentSession = {
    async *submit(input, options) {
      receivedInput = input;
      receivedOptions = options;
      yield {
        type: "context_budget",
        sessionId: "s",
        turnId: "run",
        snapshot: { tokens: 5, maxContextTokens: 10, warningRatio: .8, blockingRatio: .9, ratio: .5, state: "ok" },
      };
      yield {
        type: "model_event",
        sessionId: "s",
        turnId: "run",
        event: { type: "request_started", provider: "chosen", model: "model" },
      };
      yield {
        type: "turn_completed",
        sessionId: "s",
        turnId: "run",
        result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" },
      };
    },
    abort: () => undefined,
    snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: async () => session });
  const gateway = new InProcessGateway(router, {
    refreshConfigBeforeTurn: async () => { throw new Error("transient config read"); },
    setSessionCwd: (sessionKey, receivedCwd) => { cwd = { sessionKey, cwd: receivedCwd }; },
    resolveUploadedAttachments: async ({ projectKey, uploads }) => {
      assert.equal(projectKey, "/project");
      assert.equal(uploads.length, 1);
      return [{ type: "text", content: "uploaded text" }];
    },
    resolveTurnModelSelection: async () => ({ selection: { provider: "chosen", model: "model", reasoning: .6, temperature: .2 }, source: "session" }),
    recordAgentStatusMessage: async (input) => { statusCalls.push(input); throw new Error("status store unavailable"); },
  });
  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    projectKey: "/project",
    workspaceCwd: "/project/worktree",
    message: "hello",
    uploadedAttachments: [{ uploadId: "upload-1", name: "note.txt", mimeType: "text/plain", size: 12 }],
    runId: "run",
  }));
  assert.equal(events.some((event) => (event as { type?: string }).type === "model_selection_changed"), true);
  assert.deepEqual(cwd, { sessionKey: "s", cwd: "/project/worktree" });
  assert.equal((receivedInput as { type?: string }).type, "blocks");
  assert.equal((receivedOptions as { turnId?: string; modelOverride?: { thinking?: { mode?: string } } }).turnId, "run");
  assert.equal((receivedOptions as { modelOverride?: { thinking?: { mode?: string } } }).modelOverride?.thinking?.mode, "medium");
  assert.equal(statusCalls.length, 1);
  assert.equal(warnings.length, 1);
  router.shutdown();
});
