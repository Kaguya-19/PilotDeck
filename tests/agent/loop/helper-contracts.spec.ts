import assert from "node:assert/strict";
import test from "node:test";

import { createMissingToolResult, ensureToolResultPairing } from "../../../src/agent/loop/ensureToolResultPairing.js";
import { projectToolResults } from "../../../src/agent/loop/projectToolResults.js";
import { resolveOutputTokenRetryBump } from "../../../src/agent/loop/outputTokenRetry.js";
import { decideLoopContinuation } from "../../../src/agent/loop/decideLoopContinuation.js";
import type { CanonicalToolCall } from "../../../src/model/index.js";
import type { PilotDeckToolResult } from "../../../src/tool/index.js";

const now = () => new Date("2026-08-23T00:00:00.000Z");

function success(toolCallId: string, content: PilotDeckToolResult["content"] = []): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId,
    toolName: "read_file",
    content,
    startedAt: now().toISOString(),
    completedAt: now().toISOString(),
  };
}

function call(id: string, name = "read_file"): CanonicalToolCall {
  return { id, name, input: { path: "README.md" } };
}

test("ensureToolResultPairing preserves result order and consumes duplicate ids FIFO", () => {
  const first = success("call-1", [{ type: "text", text: "first" }]);
  const second = success("call-1", [{ type: "text", text: "second" }]);
  const paired = ensureToolResultPairing([call("call-1"), call("call-1")], [second, first], now);
  assert.deepEqual(paired, [second, first]);
});

test("ensureToolResultPairing creates recovery results for missing calls and ignores extras", () => {
  const paired = ensureToolResultPairing(
    [call("missing", "write_file")],
    [success("unmatched")],
    now,
    "executor dropped the result",
    { cwd: "/workspace/project", permissionMode: "bypassPermissions" },
  );
  assert.equal(paired.length, 1);
  assert.equal(paired[0]?.type, "error");
  assert.equal(paired[0]?.toolCallId, "missing");
  assert.equal(paired[0]?.toolName, "write_file");
  assert.equal(paired[0]?.startedAt, "2026-08-23T00:00:00.000Z");
  assert.match(paired[0]?.content[0]?.type === "text" ? paired[0].content[0].text : "", /executor dropped/);
});

test("createMissingToolResult uses safe defaults and includes recovery advice", () => {
  const result = createMissingToolResult(call("call-1", "bash"), now);
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "tool_execution_failed");
  assert.equal(result.metadata?.recovery !== undefined, true);
  assert.equal(result.startedAt, result.completedAt);
});

test("projectToolResults projects text, JSON, image, PDF and file supplemental content", () => {
  const result = success("call-1", [{ type: "json", value: { ok: true } }]);
  result.supplementalMessages = [{
    role: "user",
    content: [
      { type: "text", text: "context" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=", bytes: 5, detail: "high" },
      { type: "pdf", mimeType: "application/pdf", data: "JVBERi0=", bytes: 7, pages: 1 },
      { type: "file", path: "/workspace/out.txt", mimeType: "text/plain", description: "output" },
    ],
  }];

  const messages = projectToolResults([result]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content[0]?.type, "tool_result");
  assert.equal(messages[1]?.content.map((block) => block.type).join(","), "text,image,pdf,text");
  assert.deepEqual(messages[1]?.content[1], {
    type: "image", source: "base64", data: "aGVsbG8=", mimeType: "image/png", bytes: 5, detail: "high",
  });
  assert.deepEqual(messages[1]?.content[2], {
    type: "pdf", source: "base64", data: "JVBERi0=", mimeType: "application/pdf", bytes: 7, pages: 1,
  });
});

test("projectToolResults emits an empty primary message for no results", () => {
  const messages = projectToolResults([]);
  assert.deepEqual(messages, [{ role: "user", content: [] }]);
});

test("resolveOutputTokenRetryBump handles explicit caps, model caps and invalid values", () => {
  assert.equal(resolveOutputTokenRetryBump({}), undefined);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: 0 }), undefined);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: Number.NaN }), undefined);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: 100, modelMaxOutputTokens: 0 }), undefined);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: 100, modelMaxOutputTokens: 150 }), 150);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: 150, modelMaxOutputTokens: 150 }), undefined);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: 100 }), 200);
  assert.equal(resolveOutputTokenRetryBump({ currentMaxOutputTokens: Number.MAX_VALUE }), undefined);
});

test("decideLoopContinuation distinguishes tool-call and terminal assistant messages", () => {
  assert.deepEqual(decideLoopContinuation({
    role: "assistant",
    content: [{ type: "text", text: "done" }, { type: "tool_call", id: "call-1", name: "read_file", input: {} }],
  }), { type: "continue", reason: "tool_results" });
  assert.deepEqual(decideLoopContinuation({ role: "assistant", content: [{ type: "text", text: "done" }] }), {
    type: "stop",
    reason: "no_tool_calls",
  });
});
