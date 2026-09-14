import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultInteractionPolicy } from "../../src/interaction/index.js";

import {
  interactionTimeoutOutcome,
  normalizeInteractionTimeout,
} from "../../src/interaction/index.js";

test("interaction deadline normalization is shared by host adapters", () => {
  assert.equal(normalizeInteractionTimeout(undefined), undefined);
  assert.equal(normalizeInteractionTimeout(-1), undefined);
  assert.equal(normalizeInteractionTimeout(Number.NaN), undefined);
  assert.equal(normalizeInteractionTimeout(4.9), 4);
  assert.equal(normalizeInteractionTimeout(0), 0);
  assert.equal(interactionTimeoutOutcome(), "timeout");
});

test("default interaction policy fails closed for disabled or answerer-less profiles", () => {
  const policy = createDefaultInteractionPolicy();
  assert.deepEqual(policy.decide({
    kind: "permission",
    mode: "disabled",
    hasAnswerer: false,
  }), {
    outcome: "deny",
    reason: "Interaction is disabled for this profile.",
  });
  assert.deepEqual(policy.decide({
    kind: "question",
    mode: "headless",
    hasAnswerer: false,
  }), {
    outcome: "cancel",
    reason: "No interaction answerer is available.",
  });
  assert.equal(policy.decide({
    kind: "question",
    mode: "headless",
    hasAnswerer: true,
  }).outcome, "ask");
});
