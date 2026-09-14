import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { InProcessGateway, mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayToolResultArtifactStore } from "../../src/gateway/client/GatewayToolResultArtifactStore.js";
import type { AgentSession } from "../../src/agent/index.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("tool-result artifact store writes a large result below its selected root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-result-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayToolResultArtifactStore({ rootDir: root, thresholdBytes: 4 });

  const path = store.persist({
    sessionId: "session/1",
    turnId: "turn:1",
    toolCallId: "tool call",
    text: "result payload",
  });

  assert.equal(path, join(root, "session-1", "turn-1", "tool-call.txt"));
  assert.equal(await readEventually(path!), "result payload");
  assert.equal(store.persist({
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "small",
    text: "tiny",
  }), undefined);
});

test("Gateway event projection delegates tool-result persistence to its configured store", () => {
  const persisted: Array<{ sessionId: string; turnId: string; toolCallId: string; text: string }> = [];
  const [frame] = mapAgentEvent(toolResultEvent("large output"), "run-1", {
    persist(input) {
      persisted.push(input);
      return "/configured-root/session-1/turn-1/tool-1.txt";
    },
  });

  assert.equal(frame?.type, "tool_call_finished");
  assert.equal(frame?.type === "tool_call_finished" ? frame.resultPath : undefined,
    "/configured-root/session-1/turn-1/tool-1.txt");
  assert.deepEqual(persisted, [{
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    text: "large output",
  }]);
});

test("InProcessGateway honors toolResultsDir for a streamed tool result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-result-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const largeOutput = "x".repeat(5_000);
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession([toolResultEvent(largeOutput)]),
  });
  const gateway = new InProcessGateway(router, { toolResultsDir: root });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "web",
    message: "run tool",
  })) {
    events.push(event);
  }

  const frame = events.find((event) => event.type === "tool_call_finished");
  assert.ok(frame && frame.type === "tool_call_finished");
  assert.ok(frame.resultPath?.startsWith(root));
  assert.equal(await readEventually(frame.resultPath!), largeOutput);
});

function toolResultEvent(text: string): AgentEvent {
  return {
    type: "tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      type: "success",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text }],
      startedAt: "2026-09-10T00:00:00.000Z",
      completedAt: "2026-09-10T00:00:01.000Z",
    },
  };
}

function fakeSession(events: AgentEvent[]): AgentSession {
  return {
    async *submit() {
      yield { type: "turn_started", sessionId: "session-1", turnId: "turn-1" };
      for (const event of events) yield event;
      yield {
        type: "turn_completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: {
          type: "success",
          sessionId: "session-1",
          turnId: "turn-1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:01.000Z",
        },
      };
    },
    abort() {},
    snapshot() {
      return {
        sessionId: "session-1",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}

async function readEventually(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
