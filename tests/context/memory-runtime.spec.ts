import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAttachmentBuilder } from "../../src/context/memory/MemoryAttachmentBuilder.js";
import { canonicalMessagesToMemoryMessages, type MemoryResolver } from "../../src/context/memory/MemoryResolver.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const input = {
  query: "find relevant context",
  sessionId: "session-1",
  projectRoot: "/workspace/project",
  recentMessages: [] as CanonicalMessage[],
};

function resolver(overrides: Partial<MemoryResolver> = {}): MemoryResolver {
  return {
    retrieve: async () => ({ systemContext: undefined, diagnostics: [] }),
    captureTurn: async () => undefined,
    ...overrides,
  };
}

test("canonicalMessagesToMemoryMessages groups text and tool content while preserving stable ids", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: " first " }, { type: "text", text: "second" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call", content: [{ type: "text", text: "tool output" }, { type: "image", source: "base64", data: "x", mimeType: "image/png" }] }] },
    { role: "user", content: [{ type: "tool_result_reference", toolCallId: "ref", path: "/tmp/ref", originalBytes: 10, preview: "reference", hasMore: true }] },
    { role: "assistant", content: [{ type: "media_reference", toolCallId: "media", path: "/tmp/a.png", originalBytes: 3, preview: "media", hasMore: false, mimeType: "image/png", mediaType: "image" }] },
  ];
  const converted = canonicalMessagesToMemoryMessages(messages);
  assert.deepEqual(converted, [
    { msgId: "message-0", role: "user", content: "first\nsecond" },
    { msgId: "message-1", role: "assistant", content: "answer" },
    { msgId: "message-2", role: "tool", content: "tool output\n[image]" },
    { msgId: "message-3", role: "tool", content: "reference" },
    { msgId: "message-4", role: "tool", content: "media" },
  ]);
});

test("canonicalMessagesToMemoryMessages filters fork carryover and empty blocks", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", metadata: { forkCarryover: { sourceSessionId: "old" } }, content: [{ type: "text", text: "fork" }] },
    { role: "user", content: [{ type: "text", text: "  " }] },
    { role: "assistant", content: [{ type: "text", text: "kept" }] },
  ];
  assert.deepEqual(canonicalMessagesToMemoryMessages(messages, { includeForkCarryover: false }), [
    { msgId: "message-2", role: "assistant", content: "kept" },
  ]);
});

test("MemoryAttachmentBuilder returns a trimmed memory context and diagnostics", async () => {
  let receivedSignal: AbortSignal | undefined;
  const build = new MemoryAttachmentBuilder(resolver({
    retrieve: async (request) => {
      receivedSignal = request.signal;
      return { systemContext: "  remembered fact  ", diagnostics: [{ code: "memory_context_empty", severity: "info", message: "not empty" }] };
    },
  }));
  const result = await build.build(input);
  assert.ok(receivedSignal);
  assert.deepEqual(result.attachments, [{ role: "user", content: [{ type: "text", text: "<memory-context>\nremembered fact\n</memory-context>" }] }]);
  assert.equal(result.diagnostics[0]?.code, "memory_context_empty");
});

test("MemoryAttachmentBuilder handles empty, aborted and failed providers without throwing", async () => {
  const empty = await new MemoryAttachmentBuilder(resolver({
    retrieve: async () => ({ systemContext: "  ", diagnostics: [] }),
  })).build(input);
  assert.deepEqual(empty, { attachments: [], diagnostics: [] });

  const controller = new AbortController();
  controller.abort("stop");
  const aborted = await new MemoryAttachmentBuilder(resolver({
    retrieve: async () => { throw new Error("must not call"); },
  })).build({ ...input, signal: controller.signal });
  assert.deepEqual(aborted, { attachments: [], diagnostics: [] });

  const failed = await new MemoryAttachmentBuilder(resolver({
    retrieve: async () => { throw new Error("provider down"); },
  })).build(input);
  assert.equal(failed.attachments.length, 0);
  assert.equal(failed.diagnostics[0]?.code, "memory_provider_error");
  assert.match(failed.diagnostics[0]?.message ?? "", /provider down/);
});

test("MemoryAttachmentBuilder reports a bounded retrieval timeout and clears it after completion", async () => {
  const result = await new MemoryAttachmentBuilder(resolver({
    retrieve: async () => await new Promise(() => undefined),
  })).build({ ...input, timeoutMs: 1 });
  assert.equal(result.attachments.length, 0);
  assert.equal(result.diagnostics[0]?.code, "memory_provider_error");
  assert.match(result.diagnostics[0]?.message ?? "", /timed out after 1ms/);
});

test("MemoryAttachmentBuilder forwards an external abort and releases the resolver barrier", async () => {
  const controller = new AbortController();
  let resolverSignal: AbortSignal | undefined;
  let rejectRetrieval: ((error: unknown) => void) | undefined;
  const pending = new Promise<never>((_, reject) => {
    rejectRetrieval = reject;
  });
  const build = new MemoryAttachmentBuilder(resolver({
    retrieve: async (request) => {
      resolverSignal = request.signal;
      request.signal?.addEventListener("abort", () => rejectRetrieval?.(request.signal?.reason ?? new Error("aborted")), { once: true });
      return await pending;
    },
  }));
  const resultPromise = build.build({ ...input, signal: controller.signal });
  while (!resolverSignal) await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort("user stop");
  const result = await resultPromise;
  assert.deepEqual(result, { attachments: [], diagnostics: [] });
  assert.equal(resolverSignal.aborted, true);
});
