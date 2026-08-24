import assert from "node:assert/strict";
import test from "node:test";

import { InputProcessor } from "../../src/context/input/InputProcessor.js";
import { NullContextRuntime } from "../../src/context/NullContextRuntime.js";
import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const extension: ExtensionResolver = {
  listCommands: () => [{ name: "review", description: "Review files" }],
  listSkills: () => [],
  listMcpInstructions: () => [],
};

test("InputProcessor preserves plain text and blocks while respecting metadata", () => {
  const processor = new InputProcessor({ extension });
  const plain = processor.process({ type: "text", text: "hello" });
  assert.equal(plain.shouldCallModel, true);
  assert.deepEqual(plain.diagnostics, []);
  assert.equal(plain.messages[0]?.content[0]?.type, "text");

  const blocks = [{ type: "text" as const, text: "hidden" }];
  const meta = processor.process({ type: "blocks", content: blocks, isMeta: true });
  assert.equal(meta.shouldCallModel, false);
  assert.notEqual(meta.messages[0]?.content, blocks);
  assert.deepEqual(meta.messages[0]?.content, blocks);
});

test("InputProcessor recognizes extension commands and forwards unknown commands with diagnostics", () => {
  const processor = new InputProcessor({ extension });
  const known = processor.process({ type: "text", text: "/review changed files" });
  assert.deepEqual(known.command, { name: "review", argument: "changed files", source: "extension" });
  assert.equal(known.messages[0]?.content[0]?.type, "text");
  assert.match((known.messages[0]?.content[0] as { text: string }).text, /Run plugin command/);

  const unknown = processor.process({ type: "text", text: "/missing arg" });
  assert.deepEqual(unknown.command, { name: "missing", argument: "arg", source: "unknown" });
  assert.equal(unknown.diagnostics[0]?.code, "unknown_command");
  assert.equal((unknown.messages[0]?.content[0] as { text: string }).text, "/missing arg");
});

test("NullContextRuntime returns an informational diagnostic and preserves tool pairs when truncating", async () => {
  const runtime = new NullContextRuntime({ maxMessages: 2 });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] }] },
    { role: "user", content: [{ type: "text", text: "last" }] },
  ];
  const input: ContextPrepareInput = {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    provider: "test",
    model: "test",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages,
    tools: [],
    maxMessages: 2,
  };
  const truncated = await runtime.prepareForModel(input);
  assert.equal(truncated.diagnostics[0]?.code, "context_truncated");
  assert.equal(truncated.messages[0]?.role, "assistant");
  assert.equal(truncated.messages[1]?.role, "user");

  const unchanged = await new NullContextRuntime().prepareForModel({ ...input, messages: [], maxMessages: undefined });
  assert.equal(unchanged.diagnostics[0]?.code, "context_budget_not_enforced");
});
