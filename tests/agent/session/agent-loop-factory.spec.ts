import test from "node:test";
import assert from "node:assert/strict";

import { createAgentSession } from "../../../src/agent/session/createAgentSession.js";
import type { AgentLoopRunResult, AgentLoopSeedState } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";

test("createAgentSession can run a turn through an injected AgentLoop transport", async () => {
  let factoryCalls = 0;
  let runCalls = 0;
  const seedState: AgentLoopSeedState = { allowedReadFiles: ["fixture.txt"] };
  const session = createAgentSession({
    sessionId: "session-sidecar",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
    seedState,
    __agentLoopFactory: (input) => {
      factoryCalls += 1;
      assert.equal(input.seedState, seedState);
      return {
        snapshotFileState: () => seedState,
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          runCalls += 1;
          const result: AgentLoopRunResult = {
            result: {
              type: "success",
              sessionId: options.sessionId,
              turnId: options.turnId,
              finalMessage: { role: "assistant", content: [{ type: "text", text: "sidecar" }] },
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-03T00:00:00.000Z",
              completedAt: "2026-09-03T00:00:00.001Z",
            },
            messages: options.messages,
          };
          yield {
            type: "turn_completed",
            sessionId: options.sessionId,
            turnId: options.turnId,
            result: result.result,
          };
          return result;
        },
      };
    },
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "hello" }, { turnId: "turn-sidecar" })) {
    events.push(event);
  }

  assert.equal(factoryCalls, 1);
  assert.equal(runCalls, 1);
  assert.equal(events.some((event) => event.type === "turn_completed"), true);
  assert.deepEqual(session.snapshotForRuntimeReload().fileState, seedState);
});
