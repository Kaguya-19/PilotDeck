import assert from "node:assert/strict";
import test from "node:test";

import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  sortDiscoveryPlans,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
  type WebPlanRecord,
} from "../../src/always-on/web/DiscoveryPlanStatus.js";

function plan(overrides: Partial<WebPlanRecord> = {}): WebPlanRecord {
  return {
    id: "plan",
    title: "Plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    summary: "",
    rationale: "",
    dedupeKey: "plan",
    sourceDiscoverySessionId: "discovery",
    executionSessionId: "",
    executionStartedAt: "",
    executionLastActivityAt: "",
    executionStatus: "",
    latestSummary: "",
    contextRefs: { workingDirectory: [], memory: [], existingPlans: [], cronJobs: [], recentChats: [] },
    planFilePath: "plan.md",
    structureVersion: 1,
    ...overrides,
  };
}

test("DiscoveryPlanStatus normalizes timestamps, strings, lists and truncation", () => {
  assert.equal(toTimestampValue(undefined), null);
  assert.equal(toTimestampValue("invalid"), null);
  assert.equal(toIsoTimestamp("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(toIsoTimestamp("invalid"), "");
  assert.equal(pickLatestIsoTimestamp("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), "2026-01-02T00:00:00.000Z");
  assert.equal(normalizeString("  value "), "value");
  assert.equal(normalizeString(4, "fallback"), "fallback");
  assert.deepEqual(normalizeStringList([" a ", 1, "", "b"]), ["a", "b"]);
  assert.equal(truncateText("  a   b  ", 20), "a b");
  assert.equal(truncateText("123456789", 6), "123...");
});

test("DiscoveryPlanStatus derives execution and plan states with active-session precedence", () => {
  assert.equal(computeExecutionStatus(plan({ status: "archived" }), null, () => true), "");
  assert.equal(computeExecutionStatus(plan({ executionSessionId: "s" }), null, (id) => id === "s"), "running");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "failed" }), null, () => false), "failed");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "completed" }), null, () => false), "completed");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "queued", executionSessionId: "s" }), null, () => false), "queued");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "queued", executionSessionId: "s" }), { id: "s" }, () => false), "completed");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "running", executionSessionId: "s" }), null, () => false), "running");
  assert.equal(computeExecutionStatus(plan({ executionStatus: "running", executionSessionId: "s" }), { id: "s" }, () => false), "completed");
  assert.equal(computePlanStatus(plan({ status: "archived" }), null, () => false), "archived");
  assert.equal(computePlanStatus(plan({ status: "unknown" }), null, () => false), "unknown");
});

test("DiscoveryPlanStatus sorts by lifecycle order and newest update", () => {
  const sorted = sortDiscoveryPlans([
    { status: "completed", updatedAt: "2026-01-02T00:00:00Z", id: "done" },
    { status: "running", updatedAt: "2026-01-01T00:00:00Z", id: "run" },
    { status: "running", updatedAt: "2026-01-03T00:00:00Z", id: "new-run" },
    { status: "other", updatedAt: "2026-01-04T00:00:00Z", id: "other" },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["new-run", "run", "done", "other"]);
});
