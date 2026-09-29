import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { PilotDeckLoadedPlugin } from "../../src/extension/index.js";
import { createGatewayHookExecutionProjection } from "../../src/gateway/index.js";
import type { GatewayEvent } from "../../src/gateway/index.js";

test("Gateway hook projection is session-filtered and never exposes hook output", () => {
  const emitted: GatewayEvent[] = [];
  const project = createGatewayHookExecutionProjection({
    sessionKey: "session-a",
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  });

  project({
    type: "response",
    sessionId: "session-b",
    hookName: "other",
    hookEvent: "SessionStart",
    stdout: "must-not-leak",
    stderr: "must-not-leak",
    exitCode: 2,
    outcome: "blocking",
  });
  project({
    type: "started",
    sessionId: "session-a",
    hookName: "project-hook",
    hookEvent: "SessionStart",
  });
  project({
    type: "response",
    sessionId: "session-a",
    hookName: "project-hook",
    hookEvent: "SessionStart",
    stdout: "must-not-leak",
    stderr: "must-not-leak",
    exitCode: 2,
    outcome: "blocking",
  });

  assert.deepEqual(emitted, [
    {
      type: "agent_status",
      event: "hook_execution_started",
      detail: { hookName: "project-hook", hookEvent: "SessionStart" },
    },
    {
      type: "agent_status",
      event: "hook_execution_completed",
      detail: {
        hookName: "project-hook",
        hookEvent: "SessionStart",
        outcome: "blocking",
        exitCode: 2,
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(emitted), /must-not-leak/);
});

test("local Gateway projects a session hook lifecycle into the active turn stream", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-hook-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testBuiltinPlugins: [hookPlugin()],
    __testAgentLoopFactory: () => createRunner(),
  });
  t.after(() => local.dispose());

  const events: GatewayEvent[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "hook-stream",
    channelKey: "test",
    projectKey: root,
    message: "continue",
    runId: "hook-run",
  })) {
    events.push(event);
  }

  const statuses = events.filter((event): event is Extract<GatewayEvent, { type: "agent_status" }> =>
    event.type === "agent_status" && event.event.startsWith("hook_execution_"),
  );
  assert.deepEqual(statuses.map((event) => event.event), [
    "hook_execution_started",
    "hook_execution_completed",
  ]);
  assert.deepEqual(statuses[0]?.detail, {
    hookName: "hook-observer:prompt",
    hookEvent: "SessionStart",
  });
  assert.deepEqual(statuses[1]?.detail, {
    hookName: "hook-observer:prompt",
    hookEvent: "SessionStart",
    outcome: "non_blocking_error",
  });
  assert.doesNotMatch(JSON.stringify(statuses), /private hook prompt/);
});

function hookPlugin(): PilotDeckLoadedPlugin {
  return {
    name: "hook-observer",
    path: "/plugins/hook-observer",
    source: "builtin",
    manifest: { name: "hook-observer", version: "1.0.0" },
    hookContributions: [{
      hooks: {
        SessionStart: [{ hooks: [{ type: "prompt", prompt: "private hook prompt" }] }],
      },
    }],
  };
}

function createRunner() {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
      const result: AgentLoopRunResult = {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          finalMessage,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        messages: [...input.messages, finalMessage],
      };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: result.result };
      return result;
    },
  };
}

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;
