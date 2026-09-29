import assert from "node:assert/strict";
import test from "node:test";

import { createNativeOneShotSubagentPort } from "../../../src/agent/sub/OneShotSubagentPort.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { ResolvedSubagentRunRequest, SubagentProvider } from "../../../src/agent/sub/SubagentProvider.js";
import { ToolRegistry } from "../../../src/tool/index.js";

function config(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("one-shot subagent port selects the provider and retains parent lifecycle ownership", async () => {
  const events: unknown[] = [];
  const transcript: string[] = [];
  const lifecycle: string[] = [];
  let received: ResolvedSubagentRunRequest | undefined;
  const provider: SubagentProvider = {
    name: "fixture-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async (request) => {
      received = request;
      return {
        result: Promise.resolve({
          subagentId: request.subagentId,
          definitionId: request.definition.id,
          markdown: "Scope: test\nResult: complete",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          turns: 1,
          durationMs: 5,
        }),
        dispose: async () => undefined,
      };
    },
  };
  const dependencies: AgentRuntimeDependencies = {
    router: {} as AgentRuntimeDependencies["router"],
    tools: { registry: new ToolRegistry(), scheduler: {} as never },
    subagentProvider: provider,
    eventEmitter: (event) => events.push(event),
    lifecycle: {
      dispatch: async (input: { event: string }) => {
        lifecycle.push(input.event);
        return {
          effects: [],
          messages: [],
          events: [],
          blockingErrors: [],
          nonBlockingErrors: [],
        };
      },
    } as never,
    subagentTranscript: {
      recordSubagentStarted: async () => { transcript.push("started"); },
      recordSubagentCompleted: async () => { transcript.push("completed"); },
      subagentTranscriptResolver: (subagentId) => ({
        recordAcceptedInput: async () => undefined,
        recordDurableMessage: async () => undefined,
        transcriptRelativePath: `session/subagents/${subagentId}.jsonl`,
      }),
    },
  };
  const port = createNativeOneShotSubagentPort({
    config: config(),
    dependencies,
  });
  const fork = port.createForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
  });

  const report = await fork.fork({
    definitionId: "explore",
    directive: "Inspect the module boundary.",
    subagentId: "child-1",
    toolCallId: "call-1",
    timeoutMs: 1_000,
  });

  assert.equal(received?.descriptor.provider, "fixture-provider");
  assert.equal(received?.parentSessionId, "parent-session");
  assert.equal(received?.parentTurnId, "parent-turn");
  assert.equal(received?.parentConfig.subagentDepth, 1);
  assert.equal(report.markdown, "Scope: test\nResult: complete");
  assert.equal(report.subagentSessionId, `${process.cwd()}::sub::child-1`);
  assert.equal(report.transcriptRelativePath, "session/subagents/child-1.jsonl");
  assert.deepEqual(transcript, ["started", "completed"]);
  assert.deepEqual(lifecycle, ["SubagentStart", "SubagentStop"]);
  assert.deepEqual(events.map((event: any) => event.type), ["subagent_started", "subagent_completed"]);
});

test("one-shot subagent port disposes a selected sidechain once before recording parent completion", async () => {
  const order: string[] = [];
  let sidechainDisposals = 0;
  const provider = settledProvider();
  const port = createNativeOneShotSubagentPort({
    config: config(),
    dependencies: oneShotDependencies({
      provider,
      onCompletion: () => order.push(`completion-after-${sidechainDisposals}`),
      resolveSidechain: () => ({
        recordAcceptedInput: async () => undefined,
        recordDurableMessage: async () => undefined,
        transcriptRelativePath: "subagents/child.jsonl",
        dispose: async () => { sidechainDisposals += 1; },
      }),
    }),
  });

  await port.createForkApi({ sessionId: "parent", turnId: "turn" }).fork({
    definitionId: "explore",
    directive: "Inspect the boundary.",
    subagentId: "child",
    toolCallId: "call",
  });

  assert.equal(sidechainDisposals, 1);
  assert.deepEqual(order, ["completion-after-1"]);
});

test("one-shot subagent port disposes a selected sidechain once on provider failure", async () => {
  let sidechainDisposals = 0;
  const port = createNativeOneShotSubagentPort({
    config: config(),
    dependencies: oneShotDependencies({
      provider: failingProvider(new Error("provider failed")),
      resolveSidechain: () => ({
        recordAcceptedInput: async () => undefined,
        recordDurableMessage: async () => undefined,
        transcriptRelativePath: "subagents/child.jsonl",
        dispose: async () => { sidechainDisposals += 1; },
      }),
    }),
  });

  await assert.rejects(
    port.createForkApi({ sessionId: "parent", turnId: "turn" }).fork({
      definitionId: "explore",
      directive: "Inspect the boundary.",
      subagentId: "child",
      toolCallId: "call",
    }),
    /provider failed/,
  );

  assert.equal(sidechainDisposals, 1);
});

test("one-shot subagent port disposes a selected sidechain once on timeout and parent abort", async (t) => {
  for (const mode of ["timeout", "parent_abort"] as const) {
    await t.test(mode, async () => {
      let sidechainDisposals = 0;
      const parent = new AbortController();
      const port = createNativeOneShotSubagentPort({
        config: config(),
        dependencies: oneShotDependencies({
          provider: abortAwareProvider(),
          resolveSidechain: () => ({
            recordAcceptedInput: async () => undefined,
            recordDurableMessage: async () => undefined,
            transcriptRelativePath: "subagents/child.jsonl",
            dispose: async () => { sidechainDisposals += 1; },
          }),
        }),
      });
      const result = port.createForkApi({ sessionId: "parent", turnId: "turn" }).fork({
        definitionId: "explore",
        directive: "Inspect the boundary.",
        subagentId: "child",
        toolCallId: "call",
        ...(mode === "timeout" ? { timeoutMs: 5 } : { abortSignal: parent.signal }),
      });
      if (mode === "parent_abort") parent.abort("parent closed");

      await assert.rejects(
        result,
        mode === "timeout" ? /timed out/ : /parent closed/,
      );
      assert.equal(sidechainDisposals, 1);
    });
  }
});

function oneShotDependencies(input: {
  provider: SubagentProvider;
  resolveSidechain: NonNullable<AgentRuntimeDependencies["subagentTranscript"]>["subagentTranscriptResolver"];
  onCompletion?: () => void;
}): AgentRuntimeDependencies {
  return {
    router: {} as AgentRuntimeDependencies["router"],
    tools: { registry: new ToolRegistry(), scheduler: {} as never },
    subagentProvider: input.provider,
    subagentTranscript: {
      recordSubagentStarted: async () => undefined,
      recordSubagentCompleted: async () => input.onCompletion?.(),
      subagentTranscriptResolver: input.resolveSidechain,
    },
  };
}

function settledProvider(): SubagentProvider {
  return {
    name: "settled-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async (request) => ({
      result: Promise.resolve({
        subagentId: request.subagentId,
        definitionId: request.definition.id,
        markdown: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
      }),
      dispose: async () => undefined,
    }),
  };
}

function failingProvider(error: Error): SubagentProvider {
  return {
    name: "failing-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async () => ({
      result: Promise.reject(error),
      dispose: async () => undefined,
    }),
  };
}

function abortAwareProvider(): SubagentProvider {
  return {
    name: "abort-aware-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async (request) => ({
      result: new Promise((_, reject) => {
        if (request.abortSignal?.aborted) {
          reject(request.abortSignal.reason);
          return;
        }
        request.abortSignal?.addEventListener("abort", () => reject(request.abortSignal?.reason), {
          once: true,
        });
      }),
      dispose: async () => undefined,
    }),
  };
}
