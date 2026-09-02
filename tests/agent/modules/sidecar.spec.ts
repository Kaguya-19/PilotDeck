import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AgentLoopSidecarServer, type SidecarExecutionFactory } from "../../../src/agent/modules/sidecar.js";
import type { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";

test("sidecar server round-trips host module calls and emits one terminal event", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.method === "module_call") {
        input.write(`${JSON.stringify({
          kind: "response",
          messageId: "host-response",
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: true,
          final: true,
          outcome: "completed",
          payload: { events: [{ type: "text_delta", text: "host" }] },
        })}\n`);
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });

  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        const response = await callModule({
          runId: "run-1",
          operationId: "op-1",
          requestId: "module-1",
          module: "model",
          payload: {},
        });
        assert.equal(response.ok, true);
        yield { type: "warning", sessionId: "session-1", turnId: "turn-1", code: "TEST", message: "ok" };
        return {
          result: {
            type: "success",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-02T00:00:00.000Z",
            completedAt: "2026-09-02T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const server = new AgentLoopSidecarServer(factory, { moduleId: "test-sidecar" });
  const serving = server.serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "hello-1", method: "hello", payload: {} })}\n`);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-1",
    method: "execute",
    runId: "run-1",
    operationId: "op-1",
    requestId: "request-1",
    payload: {},
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.end();
  await serving;

  assert.equal(lines.some((message) => message.kind === "response" && message.inReplyTo === "hello-1"), true);
  assert.equal(lines.some((message) => message.kind === "request" && message.method === "module_call"), true);
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "completed");
});
