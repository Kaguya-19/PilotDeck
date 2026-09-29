export type OutputTokenRetryInput = {
  currentMaxOutputTokens?: number;
  modelMaxOutputTokens?: number;
};

/**
 * Returns the next explicit max output cap for the one-shot retry phase.
 *
 * When the request is using the catalog default (`currentMaxOutputTokens` is
 * undefined), it is already being sent at the selected model's known cap, so a
 * synthetic retry would only repeat the same request.
 */
export function resolveOutputTokenRetryBump(input: OutputTokenRetryInput): number | undefined {
  const current = input.currentMaxOutputTokens;
  if (current === undefined || !Number.isFinite(current) || current <= 0) {
    return undefined;
  }

  const modelCap = input.modelMaxOutputTokens;
  if (modelCap !== undefined && (!Number.isFinite(modelCap) || modelCap <= 0)) {
    return undefined;
  }

  if (modelCap !== undefined && current >= modelCap) {
    return undefined;
  }

  const doubled = current * 2;
  if (!Number.isFinite(doubled) || doubled <= current) {
    return undefined;
  }

  return modelCap !== undefined ? Math.min(doubled, modelCap) : doubled;
}
