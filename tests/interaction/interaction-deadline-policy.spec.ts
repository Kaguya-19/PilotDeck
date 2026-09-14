import assert from "node:assert/strict";
import test from "node:test";

import { createStaticInteractionDeadlinePolicy } from "../../src/interaction/index.js";

test("static interaction deadline policy selects an independently normalized timeout per request kind", () => {
  const policy = createStaticInteractionDeadlinePolicy({
    permissionTimeoutMs: 25.9,
    questionTimeoutMs: 0,
  });

  assert.equal(policy.resolve({ kind: "permission" }), 25);
  assert.equal(policy.resolve({ kind: "question" }), 0);
});

test("static interaction deadline policy leaves invalid or omitted deadlines disabled", () => {
  const policy = createStaticInteractionDeadlinePolicy({
    permissionTimeoutMs: -1,
    questionTimeoutMs: Number.NaN,
  });

  assert.equal(policy.resolve({ kind: "permission" }), undefined);
  assert.equal(policy.resolve({ kind: "question" }), undefined);
});
