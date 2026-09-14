import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AgentLoopInput,
  type AgentLoopRunResult,
  type AgentEvent,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
} from "../../src/agent/index.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";

test("local gateway wires continuable tools through live and cold follow-up paths", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-continuation-project-"));
  const pilotHome = projectRoot;
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let childSessionId: string | undefined;
  const createRunner = ({ config, dependencies }: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
  }) =>
    createScriptedRunner(async (input) => {
      if (input.sessionId !== "gateway-session") return;
      const name = childSessionId ? "send_message" : "subagent";
      const toolInput = childSessionId
        ? { subagent_id: childSessionId, message: "Continue the durable checks." }
        : { description: "Inspect the runtime", prompt: "Inspect the runtime." };
      const results = await executeTools(dependencies, config, input, [{
        id: `call-${input.turnId}`,
        name,
        input: toolInput,
      }]);
      const result = results[0];
      const data = result?.type === "success" ? result.data as { subagentId?: string } : undefined;
      if (!childSessionId) childSessionId = data?.subagentId;
      assert.ok(result?.type === "success", JSON.stringify(result));
      assert.ok(childSessionId);
    });

  const first = createLocalGateway({
    projectRoot,
    pilotHome,
    permissionMode: "bypassPermissions",
    __testAgentLoopFactory: createRunner,
  });
  const firstEvents = await collect(first.gateway.submitTurn({
    sessionKey: "gateway-session",
    channelKey: "test",
    message: "Start the child.",
    runId: "parent-turn-1",
    canPrompt: false,
  }));
  assert.ok(childSessionId, JSON.stringify(firstEvents));
  await first.dispose();

  const second = createLocalGateway({
    projectRoot,
    pilotHome,
    permissionMode: "bypassPermissions",
    __testAgentLoopFactory: createRunner,
  });
  try {
    await drain(second.gateway.submitTurn({
      sessionKey: "gateway-session",
      channelKey: "test",
      message: "Follow up on the child.",
      runId: "parent-turn-2",
      canPrompt: false,
    }));
  } finally {
    await second.dispose();
  }
});

test("closing a gateway parent session drains a running continuable child first", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-continuation-close-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const childStarted = deferred<void>();
  let childAborted = false;
  const runner = ({ config, dependencies }: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
  }) => ({
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      if (input.sessionId === "close-parent") {
        const results = await executeTools(dependencies, config, input, [{
          id: `call-${input.turnId}`,
          name: "subagent",
          input: { description: "Block until closed", prompt: "Wait for parent shutdown." },
        }]);
        assert.equal(results[0]?.type, "success", JSON.stringify(results[0]));
        const completed = completeResult(input, "success");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: completed.result };
        return completed;
      }

      childStarted.resolve();
      await waitForAbort(input.abortSignal);
      childAborted = true;
      const aborted = completeResult(input, "aborted");
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: aborted.result };
      return aborted;
    },
  });

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    permissionMode: "bypassPermissions",
    __testAgentLoopFactory: runner,
  });
  try {
    await drain(local.gateway.submitTurn({
      sessionKey: "close-parent",
      channelKey: "test",
      message: "Start blocking child.",
      runId: "parent-turn",
      canPrompt: false,
    }));
    await childStarted.promise;
    await local.gateway.closeSession({ sessionKey: "close-parent", reason: "test_close" });
    assert.equal(childAborted, true);
  } finally {
    await local.dispose();
  }
});

test("gateway binds a depth-authorized native child to its own continuation port", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-nested-continuation-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), NESTED_TEST_CONFIG, "utf8");

  let childSessionId: string | undefined;
  let grandchildSessionId: string | undefined;
  const grandchildStarted = deferred<void>();
  let grandchildAborted = false;
  const runner = ({ config, dependencies }: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
  }) => ({
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      if (input.sessionId === "nested-root" || input.sessionId === childSessionId) {
        const results = await executeTools(dependencies, config, input, [{
          id: `call-${input.turnId}`,
          name: "subagent",
          input: {
            description: input.sessionId === "nested-root" ? "Create child" : "Create grandchild",
            prompt: "Wait for parent shutdown.",
            subagent_type: "general-purpose",
          },
        }]);
        assert.equal(results[0]?.type, "success", JSON.stringify(results[0]));
        const data = results[0]?.type === "success"
          ? results[0].data as { subagentId?: string }
          : undefined;
        if (input.sessionId === "nested-root") childSessionId = data?.subagentId;
        else grandchildSessionId = data?.subagentId;
        assert.ok(data?.subagentId);
        const completed = completeResult(input, "success");
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: completed.result };
        return completed;
      }

      grandchildStarted.resolve();
      await waitForAbort(input.abortSignal);
      grandchildAborted = true;
      const aborted = completeResult(input, "aborted");
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: aborted.result };
      return aborted;
    },
  });

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    permissionMode: "bypassPermissions",
    __testAgentLoopFactory: runner,
  });
  try {
    await drain(local.gateway.submitTurn({
      sessionKey: "nested-root",
      channelKey: "test",
      message: "Create nested child.",
      runId: "nested-turn",
      canPrompt: false,
    }));
    await grandchildStarted.promise;
    assert.ok(childSessionId);
    assert.ok(grandchildSessionId);
    await local.gateway.closeSession({ sessionKey: "nested-root", reason: "test_close" });
    assert.equal(grandchildAborted, true);
  } finally {
    await local.dispose();
  }
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // The scripted runner emits a terminal event; drain the gateway stream.
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function executeTools(
  dependencies: AgentRuntimeDependencies,
  config: AgentRuntimeConfig,
  input: AgentLoopInput,
  calls: Parameters<AgentRuntimeDependencies["tools"]["scheduler"]["executeAll"]>[0],
) {
  return dependencies.tools.scheduler.executeAll(calls, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    canPrompt: false,
    currentToolCallId: `call-${input.turnId}`,
  } as never);
}

function createScriptedRunner(onRun: (input: AgentLoopInput) => Promise<void>) {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await onRun(input);
      const finalMessage: CanonicalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      };
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

function completeResult(
  input: AgentLoopInput,
  type: "success" | "aborted",
): AgentLoopRunResult {
  const finalMessage: CanonicalMessage = {
    role: "assistant",
    content: [{ type: "text", text: type === "success" ? "done" : "stopped" }],
  };
  return {
    result: {
      type,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(type === "success" ? { finalMessage } : {}),
      stopReason: type === "success" ? "completed" : "aborted_streaming",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    messages: type === "success" ? [...input.messages, finalMessage] : input.messages,
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

const NESTED_TEST_CONFIG = TEST_CONFIG.replace(
  "  maxOutputTokens: 1024",
  "  maxOutputTokens: 1024\n  subagents:\n    maxDepth: 2",
);
