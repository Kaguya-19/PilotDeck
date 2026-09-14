import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import {
  createGatewayBackgroundTaskCompletionProjection,
  type GatewayEvent,
} from "../../src/gateway/index.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import type { DetachedShellPort } from "../../src/tool/execution-world/DetachedShellPort.js";
import type { ExecutionWorldBundle } from "../../src/tool/execution-world/ExecutionWorldBundle.js";

test("Gateway background-task projection is session-filtered and preserves the existing live status shape", () => {
  const emitted: GatewayEvent[] = [];
  const project = createGatewayBackgroundTaskCompletionProjection({
    sessionKey: "session-a",
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  });

  project({
    sessionId: "session-b",
    taskId: "other-task",
    status: "failed",
    exitCode: 2,
    outputPreview: "other output\n",
    totalBytes: 13,
    startedAt: "2026-09-09T00:00:00.000Z",
    endedAt: "2026-09-09T00:00:01.000Z",
  });
  project({
    sessionId: "session-a",
    taskId: "task-1",
    status: "completed",
    exitCode: 0,
    outputPreview: "done\n",
    totalBytes: 5,
    startedAt: "2026-09-09T00:00:00.000Z",
    endedAt: "2026-09-09T00:00:01.000Z",
  });

  assert.deepEqual(emitted, [{
    type: "agent_status",
    event: "background_task_completed",
    detail: {
      taskId: "task-1",
      status: "completed",
      exitCode: 0,
      totalBytes: 5,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:01.000Z",
      outputPreview: "done",
    },
  }]);
});

test("local Gateway projects a scope-owned task completion into its active turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-task-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let settleExit!: () => void;
  const shell: DetachedShellPort = {
    async start(request) {
      request.onStdout?.("task finished\n");
      const exit = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
        settleExit = () => resolve({ exitCode: 0, exitSignal: null });
      });
      return { pid: 9010, exit, terminate() { settleExit(); } };
    },
  };
  const backgroundTasks = new BackgroundTaskRuntime({ shell });
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testExecutionWorldBundleFactory: () => ({
      backgroundTasks,
      dispose: () => backgroundTasks.dispose(),
    }) as ExecutionWorldBundle,
    __testAgentLoopFactory: () => createRunner(backgroundTasks, root, () => settleExit()),
  });
  t.after(() => local.dispose());

  const events: GatewayEvent[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "task-stream",
    channelKey: "test",
    projectKey: root,
    message: "run task",
    runId: "task-run",
  })) {
    events.push(event);
  }

  const statuses = events.filter((event): event is Extract<GatewayEvent, { type: "agent_status" }> =>
    event.type === "agent_status" && event.event === "background_task_completed",
  );
  assert.equal(statuses.length, 1);
  const status = statuses[0];
  assert.ok(status);
  const detail = status.detail;
  assert.ok(detail);
  assert.match(String(detail.taskId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(detail, {
    taskId: detail.taskId,
    status: "completed",
    exitCode: 0,
    totalBytes: 14,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    outputPreview: "task finished",
  });
});

function createRunner(backgroundTasks: BackgroundTaskRuntime, cwd: string, settleTask: () => void) {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await backgroundTasks.start({
        command: "echo task",
        cwd,
        sessionId: input.sessionId,
      });
      settleTask();
      await new Promise<void>((resolve) => setImmediate(resolve));
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
