import assert from "node:assert/strict";
import test from "node:test";

import { ContextOverflowRecovery } from "../../src/context/recovery/ContextOverflowRecovery.js";
import type { CanonicalModelError } from "../../src/model/index.js";

function error(overrides: Partial<CanonicalModelError> = {}): CanonicalModelError {
  return {
    provider: "test",
    model: "model",
    protocol: "openai",
    code: "prompt_too_long",
    message: "context overflow",
    retryable: false,
    ...overrides,
  };
}

test("ContextOverflowRecovery strips images before other recovery paths", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(recovery.decide({ error: error({ recoverableViaImageStrip: true }), hasAttemptedCompact: false }), {
    type: "strip_images_and_retry", reason: "multimodal-processor-error",
  });
  assert.deepEqual(recovery.decide({ error: error({ code: "image_too_large" }), hasAttemptedCompact: false }), {
    type: "strip_images_and_retry", reason: "image-too-large",
  });
});

test("ContextOverflowRecovery adjusts output for provider-reported available output", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(recovery.decide({ error: error({ availableOutputTokens: 2, maxContextTokens: 8 }), hasAttemptedCompact: false }), {
    type: "compact_and_retry", maxContextTokens: 8, maxOutputTokens: 4096, reason: "provider-available-output-too-small",
  });
  assert.deepEqual(recovery.decide({ error: error({ availableOutputTokens: 2 }), hasAttemptedCompact: true }), {
    type: "truncate_head_and_retry", keepRatio: 0.25, reason: "provider-available-output-too-small-after-compact",
  });
  assert.deepEqual(recovery.decide({ error: error({ availableOutputTokens: 5123.9 }), hasAttemptedCompact: false }), {
    type: "adjust_output_and_retry", maxOutputTokens: 5123, reason: "provider-output-cap", scope: "attempt",
  });
});

test("ContextOverflowRecovery handles explicit hard caps and non-recoverable errors", () => {
  const recovery = new ContextOverflowRecovery({ truncateFirstKeepRatio: 0.6, truncateSecondKeepRatio: 0.2 });
  assert.deepEqual(recovery.decide({ error: error({ maxOutputTokens: 12.8 }), hasAttemptedCompact: false }), {
    type: "adjust_output_and_retry", maxOutputTokens: 12, reason: "provider-output-cap", scope: "hard_cap",
  });
  assert.deepEqual(recovery.decide({ error: error({ code: "auth_error" }), hasAttemptedCompact: false }), {
    type: "give_up", reason: "non_recoverable_model_error:auth_error",
  });
});

test("ContextOverflowRecovery uses context caps and one-shot truncation semantics", () => {
  const recovery = new ContextOverflowRecovery({ truncateFirstKeepRatio: 0.6, truncateSecondKeepRatio: 0.2 });
  assert.deepEqual(recovery.decide({ error: error({ maxContextTokens: 8192 }), hasAttemptedCompact: false }), {
    type: "compact_and_retry", maxContextTokens: 8192, reason: "provider-context-cap",
  });
  assert.deepEqual(recovery.decide({ error: error({}), hasAttemptedCompact: false }), {
    type: "truncate_head_and_retry", keepRatio: 0.6, reason: "ptl-first-attempt",
  });
  assert.deepEqual(recovery.decide({ error: error({}), hasAttemptedCompact: true }), {
    type: "truncate_head_and_retry", keepRatio: 0.2, reason: "ptl-second-attempt",
  });
  assert.deepEqual(recovery.decide({ error: error({ code: "context_overflow" }), hasAttemptedCompact: false }), {
    type: "truncate_head_and_retry", keepRatio: 0.6, reason: "ptl-first-attempt",
  });
});
