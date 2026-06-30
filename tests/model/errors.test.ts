import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeModelError } from "../../src/model/errors/normalizeModelError.js";

describe("normalizeModelError", () => {
  it("unwraps Google OpenAI-compatible array errors", () => {
    const error = normalizeModelError("google", "openai", [{
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. " +
          "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
          "limit: 20, model: gemini-2.5-flash. Please retry in 47.805054227s.",
        status: "RESOURCE_EXHAUSTED",
      },
    }], 429);

    assert.equal(error.code, "billing");
    assert.equal(error.status, 429);
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, 47805);
    assert.match(error.message, /exceeded your current quota/i);
    assert.match(error.userHint ?? "", /quota depleted/i);
  });
});
