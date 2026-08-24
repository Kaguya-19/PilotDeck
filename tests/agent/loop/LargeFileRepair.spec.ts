import assert from "node:assert/strict";
import test from "node:test";

import { LargeFileRepair } from "../../../src/agent/loop/LargeFileRepair.js";
import type { PilotDeckToolResult } from "../../../src/tool/index.js";

const NO_TRUNCATION = {
  outputTruncated: false,
  repairedToolCalls: false,
  finishReason: "tool_call",
};

function success(toolName: string, data?: unknown): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: `call-${toolName}`,
    toolName,
    content: [],
    data,
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.001Z",
  };
}

function failure(
  toolName: string,
  message: string,
  options: {
    code?: "invalid_tool_input" | "result_too_large" | "permission_denied" | "permission_cancelled";
    details?: Record<string, unknown>;
  } = {},
): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: `call-${toolName}`,
    toolName,
    error: {
      code: options.code ?? "invalid_tool_input",
      message,
      details: options.details,
    },
    content: [],
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.001Z",
  };
}

test("ordinary edit failures after a successful write do not enter large-file repair", () => {
  const repair = new LargeFileRepair();

  assert.equal(
    repair.analyzeToolResults(
      [success("write_file", { filePath: "/workspace/report.xlsx" })],
      NO_TRUNCATION,
    ),
    undefined,
  );

  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(
      repair.analyzeToolResults(
        [failure("edit_file", "String to replace not found in file.")],
        NO_TRUNCATION,
      ),
      undefined,
    );
  }

  assert.equal(repair.hasPendingRepair, false);
});

test("an explicit post-draft large-file failure starts bounded recovery", () => {
  const repair = new LargeFileRepair();
  repair.analyzeToolResults(
    [success("write_file", { filePath: "/workspace/report.xlsx" })],
    NO_TRUNCATION,
  );

  for (let attempt = 1; attempt <= 5; attempt++) {
    const decision = repair.analyzeToolResults(
      [failure("edit_file", "Tool output was truncated.", { code: "result_too_large" })],
      NO_TRUNCATION,
    );
    assert.equal(decision?.type, "continue");
    assert.match(decision?.type === "continue" ? decision.prompt : "", new RegExp(`${attempt}/5`));
  }

  const stopped = repair.analyzeToolResults(
    [failure("edit_file", "Tool output was truncated.", { code: "result_too_large" })],
    NO_TRUNCATION,
  );
  assert.equal(stopped?.type, "stop");
  assert.match(stopped?.type === "stop" ? stopped.reason : "", /after 5 post-draft attempts/);
});

test("successful focused write clears an active large-file repair episode", () => {
  const repair = new LargeFileRepair();

  const started = repair.analyzeToolResults(
    [failure("write_file", "The required parameter `content` is missing", {
      details: { issues: [{ path: "$.content", code: "required" }] },
    })],
    NO_TRUNCATION,
  );
  assert.equal(started?.type, "continue");
  assert.equal(repair.hasPendingRepair, true);

  const completed = repair.analyzeToolResults(
    [
      success("write_file", { filePath: "/workspace/report.xlsx" }),
      failure("bash", "verification command failed"),
    ],
    NO_TRUNCATION,
  );
  assert.equal(completed, undefined);
  assert.equal(repair.hasPendingRepair, false);
});

test("permission failures are never reclassified as large-file recovery", () => {
  const repair = new LargeFileRepair();
  repair.analyzeToolResults(
    [success("write_file", { filePath: "/workspace/report.xlsx" })],
    NO_TRUNCATION,
  );

  assert.equal(
    repair.analyzeToolResults(
      [failure("edit_file", "Permission denied", { code: "permission_denied" })],
      { ...NO_TRUNCATION, outputTruncated: true },
    ),
    undefined,
  );
  assert.equal(
    repair.analyzeToolResults(
      [failure("edit_file", "Permission request cancelled", { code: "permission_cancelled" })],
      { ...NO_TRUNCATION, outputTruncated: true },
    ),
    undefined,
  );
});

test("initial repair state has no pending work and exposes the bounded output recommendation", () => {
  const repair = new LargeFileRepair();
  assert.equal(repair.hasPendingRepair, false);
  assert.equal(repair.recommendedMaxOutputTokens, 16_384);
  assert.equal(repair.onInvalidToolInput(), undefined);
  assert.equal(repair.onNoToolCalls(), undefined);
});

test("pre-draft risk handles required fields, truncation evidence and bounded retries", () => {
  const repair = new LargeFileRepair();
  const first = repair.analyzeToolResults(
    [failure("write_file", "content is missing", { details: { issues: [{ path: "content", code: "required" }] } })],
    NO_TRUNCATION,
  );
  assert.equal(first?.type, "continue");
  assert.match(first?.type === "continue" ? first.prompt : "", /1\/5/);
  assert.equal(repair.onInvalidToolInput()?.type, "continue");
  assert.equal(repair.onNoToolCalls()?.type, "continue");

  const other = new LargeFileRepair();
  assert.equal(other.analyzeToolResults([failure("bash", "large file output")], NO_TRUNCATION), undefined);
  const truncated = other.analyzeToolResults(
    [failure("edit_file", "required parameter content is missing", { details: { issues: [{ code: "required", path: "content" }] } })],
    { ...NO_TRUNCATION, outputTruncated: true },
  );
  assert.equal(truncated?.type, "continue");
});

test("repaired truncation starts pre/post recovery and stops after the recovery cap", () => {
  const call = { id: "write-1", name: "write_file", input: { file_path: "x" } };
  const pre = new LargeFileRepair();
  const preDecision = pre.recoverFromRepairedTruncation([call]);
  assert.equal(preDecision?.type, "continue");
  assert.equal(preDecision?.type === "continue" && preDecision.strip, "assistant");
  assert.equal(new LargeFileRepair().recoverFromRepairedTruncation([{ ...call, name: "read_file" }]), undefined);

  const post = new LargeFileRepair();
  post.analyzeToolResults([success("write_file", { filePath: "/workspace/a.txt" })], NO_TRUNCATION);
  const postDecision = post.recoverFromRepairedTruncation([call]);
  assert.equal(postDecision?.type, "continue");
  assert.equal(postDecision?.type === "continue" && postDecision.strip, "assistant");
  for (let index = 0; index < 10; index += 1) {
    post.recoverFromRepairedTruncation([call]);
  }
  assert.equal(post.recoverFromRepairedTruncation([call]), undefined);
});

test("post-draft repair tracks the five most recent file paths without duplicates", () => {
  const repair = new LargeFileRepair();
  const paths = ["a", "b", "c", "d", "e", "f"];
  for (const filePath of paths) {
    repair.analyzeToolResults([success("write_file", { filePath })], NO_TRUNCATION);
  }
  const decision = repair.analyzeToolResults(
    [failure("edit_file", "large artifact output")],
    { ...NO_TRUNCATION, finishReason: "length" },
  );
  assert.equal(decision?.type, "continue");
  assert.match(decision?.type === "continue" ? decision.prompt : "", /f, e, d, c, b/);
});
