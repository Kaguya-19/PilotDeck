import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { CachedMicroCompactionEngine } from "../../src/context/compaction/CachedMicroCompactionEngine.js";
import { InstructionDiscovery, type InstructionLayer } from "../../src/context/instructions/InstructionDiscovery.js";
import type { MemoryResolver } from "../../src/context/memory/MemoryResolver.js";
import type { CanonicalMessage, CanonicalToolSchema } from "../../src/model/index.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";

const tool: CanonicalToolSchema = { name: "read_file", description: "read", inputSchema: { type: "object" } };

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    provider: "anthropic",
    model: "model-1",
    permissionMode: "default",
    runMode: "normal",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "find the file" }] }],
    tools: [tool],
    ...overrides,
  };
}

function memoryResolver(overrides: Partial<MemoryResolver> = {}): MemoryResolver {
  return {
    async retrieve() {
      return { systemContext: "remembered context", diagnostics: [{ code: "memory_context_empty", severity: "info", message: "fixture" }] };
    },
    async captureTurn() {},
    ...overrides,
  };
}

test("prepareForModel joins prompt, memory, instruction layers and cache breakpoints", async () => {
  const layers: InstructionLayer[] = [{ scope: "project", path: "/workspace/PILOTDECK.md", content: "be precise" }];
  const discovery = { async discover() { return layers; } } as unknown as InstructionDiscovery;
  const runtime = new DefaultContextRuntime({
    memoryResolver: memoryResolver(),
    instructionDiscovery: discovery,
    projectRoot: "/workspace",
    microcompactEngine: new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 0 }),
  });
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [{ type: "tool_call", id: "read-1", name: "read_file", input: { path: "a" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "read-1", content: [{ type: "text", text: "result" }] }] },
    { role: "user", content: [{ type: "text", text: "find the file" }] },
  ];
  const result = await runtime.prepareForModel(input({ messages }));
  assert.match(result.systemPrompt ?? "", /remembered context/);
  assert.match(result.systemPrompt ?? "", /be precise/);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "memory_context_empty"), true);
  assert.deepEqual(result.cacheBreakpoints, [0]);
  assert.deepEqual(result.tools, [tool]);
});

test("prepareForModel returns a stable partial context when the caller is already aborted", async () => {
  let retrieveCalls = 0;
  const controller = new AbortController();
  controller.abort("stop");
  const runtime = new DefaultContextRuntime({
    memoryResolver: memoryResolver({
      async retrieve() {
        retrieveCalls += 1;
        return { systemContext: "should not be used", diagnostics: [] };
      },
    }),
  });
  const result = await runtime.prepareForModel(input({ abortSignal: controller.signal }));
  assert.equal(retrieveCalls, 0);
  assert.equal(result.messages.length, 1);
  assert.doesNotMatch(result.systemPrompt ?? "", /should not be used/);
  assert.deepEqual(result.boundaries, []);
});

test("prepareForModel reports instruction discovery failures without failing the turn", async () => {
  const discovery = {
    async discover() {
      throw new Error("permission denied");
    },
  } as unknown as InstructionDiscovery;
  const result = await new DefaultContextRuntime({ instructionDiscovery: discovery }).prepareForModel(input());
  assert.equal(result.diagnostics[0]?.code, "instruction_discovery_failed");
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.match(result.systemPrompt ?? "", /workspace/);
});

test("applyToolResults appends supplemental messages and isolates persistence failures", async () => {
  const toolResult: CanonicalMessage = {
    role: "user",
    content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] }],
  };
  const supplemental: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "attachment" }],
  };
  const runtime = new DefaultContextRuntime({
    toolResultBudget: {
      async applyToMessage() {
        throw new Error("disk full");
      },
      async applyToSupplementalMessage(message: CanonicalMessage) {
        return { ...message, metadata: { synthetic: true } };
      },
    } as never,
  });
  const result = await runtime.applyToolResults({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [input().messages[0]!],
    toolResultMessage: toolResult,
    supplementalMessages: [{ toolCallId: "call-1", message: supplemental }],
  });
  assert.equal(result.diagnostics[0]?.code, "tool_result_persistence_failed");
  assert.equal(result.messages.length, 3);
  assert.equal(result.appendedMessages?.[1]?.metadata?.synthetic, undefined);
});

test("captureTurn skips absent and Always-On memory, filters fork carryover, and swallows provider errors", async () => {
  let captured: CanonicalMessage[] | undefined;
  const resolver = memoryResolver({
    async captureTurn(input) {
      captured = input.messages;
    },
  });
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, projectRoot: "/workspace" });
  const carryover: CanonicalMessage = {
    role: "user",
    metadata: { forkCarryover: { sourceSessionId: "parent" } },
    content: [{ type: "text", text: "carry" }],
  };
  await runtime.captureTurn({ sessionId: "session-1", turnId: "turn-1", messages: [carryover, input().messages[0]!], errored: false });
  assert.equal(captured?.length, 1);
  await runtime.captureTurn({ sessionId: "always-on/discovery:project", turnId: "turn-2", messages: [], errored: true });

  const failing = new DefaultContextRuntime({
    memoryResolver: memoryResolver({ async captureTurn() { throw new Error("provider down"); } }),
  });
  await assert.doesNotReject(() => failing.captureTurn({ sessionId: "session-1", turnId: "turn-1", messages: [], errored: true }));
});

test("recoverFromModelError uses injected recovery and conservative fallback decisions", async () => {
  const injected = new DefaultContextRuntime({
    overflowRecovery: { decide: async () => ({ type: "compact_and_retry", reason: "injected" }) } as never,
  });
  const injectedResult = await injected.recoverFromModelError({
    sessionId: "s", turnId: "t", messages: [], hasAttemptedCompact: false,
    error: { code: "other", message: "x", provider: "p", protocol: "openai", retryable: false },
  });
  assert.deepEqual(injectedResult, { type: "compact_and_retry", reason: "injected" });

  const fallback = new DefaultContextRuntime({ truncateFirstKeepRatio: 0.4 });
  const base = { sessionId: "s", turnId: "t", messages: [], hasAttemptedCompact: false };
  assert.equal((await fallback.recoverFromModelError({ ...base, error: { code: "image_too_large", message: "x", provider: "p", protocol: "openai", retryable: false } })).type, "strip_images_and_retry");
  assert.equal((await fallback.recoverFromModelError({ ...base, error: { code: "prompt_too_long", message: "x", provider: "p", protocol: "openai", retryable: false } })).keepRatio, 0.4);
  assert.equal((await fallback.recoverFromModelError({ ...base, hasAttemptedCompact: true, error: { code: "context_overflow", message: "x", provider: "p", protocol: "openai", retryable: false } })).type, "give_up");
  assert.equal((await fallback.recoverFromModelError({ ...base, error: { code: "server_error", message: "x", provider: "p", protocol: "openai", retryable: false } })).type, "give_up");
});

test("memory retrieval failure is diagnostic-only during prepare", async () => {
  const runtime = new DefaultContextRuntime({
    memoryResolver: memoryResolver({
      async retrieve() {
        throw new Error("memory unavailable");
      },
    }),
  });
  const result = await runtime.prepareForModel(input());
  assert.equal(result.diagnostics[0]?.code, "memory_provider_error");
  assert.match(result.diagnostics[0]?.message ?? "", /memory unavailable/);
});

test("context helper defaults do not require a memory provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-context-runtime-"));
  try {
    const runtime = new DefaultContextRuntime({ projectRoot: dir });
    await assert.doesNotReject(() => runtime.captureTurn({ sessionId: "session-1", turnId: "turn-1", messages: [], errored: false }));
    assert.equal((await runtime.recoverFromModelError({
      sessionId: "s", turnId: "t", messages: [], hasAttemptedCompact: false,
      error: { code: "image_processing_error", message: "x", provider: "p", protocol: "openai", retryable: false, recoverableViaImageStrip: true },
    })).type, "strip_images_and_retry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
