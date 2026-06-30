import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOutputTokenRetryBump } from "../../src/agent/loop/outputTokenRetry.js";

describe("output token retry cap resolution", () => {
  it("does not synthesize a low retry cap when the request uses the catalog default", () => {
    assert.equal(
      resolveOutputTokenRetryBump({
        currentMaxOutputTokens: undefined,
        modelMaxOutputTokens: 384 * 1024,
      }),
      undefined,
    );
  });

  it("doubles explicit caps up to the selected model cap", () => {
    assert.equal(
      resolveOutputTokenRetryBump({
        currentMaxOutputTokens: 8_192,
        modelMaxOutputTokens: 384 * 1024,
      }),
      16_384,
    );

    assert.equal(
      resolveOutputTokenRetryBump({
        currentMaxOutputTokens: 96_000,
        modelMaxOutputTokens: 100_000,
      }),
      100_000,
    );
  });

  it("skips the one-shot retry when an explicit cap is already at the model cap", () => {
    assert.equal(
      resolveOutputTokenRetryBump({
        currentMaxOutputTokens: 100_000,
        modelMaxOutputTokens: 100_000,
      }),
      undefined,
    );
  });
});
