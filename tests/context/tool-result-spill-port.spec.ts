import test from "node:test";
import assert from "node:assert/strict";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import type { ToolResultSpillPort } from "../../src/context/budget/ToolResultSpillPort.js";

type SpillCall =
  | { type: "write"; path: string; content: string }
  | { type: "copy"; sourcePath: string; destinationPath: string };

function createFakeSpillPort(initialFiles: ReadonlyMap<string, string> = new Map()): {
  calls: SpillCall[];
  files: Map<string, string>;
  port: ToolResultSpillPort;
} {
  const calls: SpillCall[] = [];
  const files = new Map(initialFiles);
  return {
    calls,
    files,
    port: {
      async writeTextIfAbsent(path, content) {
        calls.push({ type: "write", path, content });
        if (files.has(path)) return { created: false };
        files.set(path, content);
        return { created: true };
      },
      async copyFileIfAbsent(sourcePath, destinationPath) {
        calls.push({ type: "copy", sourcePath, destinationPath });
        if (files.has(destinationPath)) return { created: false };
        const source = files.get(sourcePath);
        if (source === undefined) throw new Error(`missing fake spill source: ${sourcePath}`);
        files.set(destinationPath, source);
        return { created: true };
      },
    },
  };
}

function largeTextToolResult(toolCallId: string, text = `head\n${"x".repeat(120)}\ntail`) {
  return {
    role: "user" as const,
    content: [{
      type: "tool_result" as const,
      toolCallId,
      content: [{ type: "text" as const, text }],
    }],
  };
}

function createBudget(port: ToolResultSpillPort): ToolResultBudget {
  return new ToolResultBudget({
    toolResultsDir: "/workspace/.pilotdeck/tool-results/session-1",
    maxResultSizeChars: 32,
    maxResultSizeTokens: 8,
    previewBytes: 24,
    spillPort: port,
  });
}

test("ToolResultBudget persists large text through its injected spill provider", async () => {
  const fake = createFakeSpillPort();
  const body = `head\n${"x".repeat(120)}\ntail`;
  const applied = await createBudget(fake.port).applyToMessage(
    largeTextToolResult("call-1", body),
    { turnId: "turn-1" },
  );

  const reference = applied.content.find((block) => block.type === "tool_result_reference");
  assert.ok(reference);
  assert.equal(reference.path, "/workspace/.pilotdeck/tool-results/session-1/turn-1-call-1.txt");
  assert.equal(reference.readFilePath, ".pilotdeck/tool-results/refs/result-0001.txt");
  assert.equal(fake.files.get(reference.path), body);
  assert.equal(fake.files.get("/workspace/.pilotdeck/tool-results/refs/result-0001.txt"), body);
  assert.deepEqual(fake.calls.map((call) => call.type), ["write", "copy"]);
});

test("ToolResultBudget advances the read_file alias after a spill-provider collision", async () => {
  const firstAlias = "/workspace/.pilotdeck/tool-results/refs/result-0001.txt";
  const fake = createFakeSpillPort(new Map([[firstAlias, "existing artifact"]]));
  const applied = await createBudget(fake.port).applyToMessage(
    largeTextToolResult("call-2"),
    { turnId: "turn-1" },
  );

  const reference = applied.content.find((block) => block.type === "tool_result_reference");
  assert.ok(reference);
  assert.equal(reference.readFilePath, ".pilotdeck/tool-results/refs/result-0002.txt");
  assert.equal(fake.files.get(firstAlias), "existing artifact");
  assert.equal(
    fake.files.get("/workspace/.pilotdeck/tool-results/refs/result-0002.txt"),
    `head\n${"x".repeat(120)}\ntail`,
  );
  assert.deepEqual(fake.calls.filter((call) => call.type === "copy").map((call) => call.destinationPath), [
    firstAlias,
    "/workspace/.pilotdeck/tool-results/refs/result-0002.txt",
  ]);
});

test("ToolResultBudget writes oversized supplemental media through the spill provider", async () => {
  const fake = createFakeSpillPort();
  const applied = await createBudget(fake.port).applyToSupplementalMessage({
    role: "user",
    content: [{
      type: "image",
      source: "base64",
      data: "a".repeat(80),
      mimeType: "image/png",
    }],
  }, "call-media", { turnId: "turn-1" });

  const reference = applied.content[0];
  assert.equal(reference?.type, "media_reference");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.type, "write");
  if (fake.calls[0]?.type === "write") {
    assert.match(fake.calls[0].path, /turn-1-call-media-image-0-[0-9a-f]+\.png\.b64$/);
    assert.equal(fake.calls[0].content, "a".repeat(80));
  }
});

test("spill provider failures retain the existing ContextRuntime persistence diagnostic", async () => {
  const failure = new Error("spill storage unavailable");
  const port: ToolResultSpillPort = {
    async writeTextIfAbsent() {
      throw failure;
    },
    async copyFileIfAbsent() {
      throw failure;
    },
  };
  const budget = createBudget(port);

  await assert.rejects(
    budget.applyToMessage(largeTextToolResult("call-failure"), { turnId: "turn-1" }),
    failure,
  );

  const original = largeTextToolResult("call-failure");
  const applied = await new DefaultContextRuntime({ toolResultBudget: budget }).applyToolResults({
    sessionId: "session-1",
    turnId: "turn-1",
    toolResultMessage: original,
    messages: [],
  });
  assert.deepEqual(applied.diagnostics, [{
    code: "tool_result_persistence_failed",
    severity: "error",
    message: "Failed to persist large tool result: spill storage unavailable",
  }]);
  assert.deepEqual(applied.appendedMessages, [original]);
});
