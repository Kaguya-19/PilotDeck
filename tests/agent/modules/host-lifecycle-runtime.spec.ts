import assert from "node:assert/strict";
import test from "node:test";

import { createHostLifecycleRuntime } from "../../../src/agent/modules/lifecycle/index.js";

test("host lifecycle consumer sends only the hook event and business payload", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const runtime = createHostLifecycleRuntime(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    return {
      kind: "response",
      messageId: "lifecycle-response",
      inReplyTo: "call",
      ok: true,
      payload: {
        result: {
          effects: [{ type: "additional_context", content: "host hook", source: "test" }],
          messages: [],
          events: [],
          blockingErrors: [],
          nonBlockingErrors: [],
        },
      },
    };
  }, {
    runId: "run-1",
    operationId: "operation-1",
  }, () => "1");

  const result = await runtime.dispatch({
    event: "Stop",
    baseInput: {
      sessionId: "sidecar-session",
      transcriptPath: "/private/transcript.jsonl",
      cwd: "/workspace",
      permissionMode: "default",
    },
    payload: { lastAssistantMessage: "done" },
    matchQuery: "not-forwarded",
    env: { HOST_SECRET: "not-forwarded" },
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "host hook", source: "test" }]);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.module, "lifecycle");
  assert.equal(request.runId, "run-1");
  assert.equal(request.operationId, "operation-1");
  assert.deepEqual(request.payload, {
    operation: "dispatch",
    event: "Stop",
    payload: { lastAssistantMessage: "done" },
  });
});

test("host lifecycle consumer rejects malformed host dispatch results", async () => {
  const runtime = createHostLifecycleRuntime(async () => ({
    kind: "response",
    messageId: "lifecycle-response",
    inReplyTo: "call",
    ok: true,
    payload: { result: { effects: [] } },
  }), {
    runId: "run-1",
    operationId: "operation-1",
  });

  await assert.rejects(
    () => runtime.dispatch({
      event: "Stop",
      baseInput: { sessionId: "session", transcriptPath: "", cwd: "/workspace" },
    }),
    /invalid dispatch result/,
  );
});
