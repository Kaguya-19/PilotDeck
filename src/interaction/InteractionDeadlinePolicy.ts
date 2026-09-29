import type { InteractionRequestKind } from "./InteractionContract.js";

/** Input to the profile-selected timeout provider for one interaction request. */
export type InteractionDeadlinePolicyInput = {
  kind: InteractionRequestKind;
};

/**
 * Host-independent deadline Definition shared by approval and question
 * consumers. Returning `undefined` deliberately leaves a request without a
 * local timer; consumers still honor their request abort and teardown paths.
 */
export type InteractionDeadlinePolicy = {
  resolve(input: InteractionDeadlinePolicyInput): number | undefined;
};

export type StaticInteractionDeadlinePolicyOptions = {
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
};

/**
 * Native profile provider. Values are normalized once at composition time so
 * every consumer of the same scope observes identical timeout semantics.
 */
export function createStaticInteractionDeadlinePolicy(
  options: StaticInteractionDeadlinePolicyOptions = {},
): InteractionDeadlinePolicy {
  const timeoutByKind: Record<InteractionRequestKind, number | undefined> = {
    permission: normalizeTimeout(options.permissionTimeoutMs),
    question: normalizeTimeout(options.questionTimeoutMs),
  };
  return {
    resolve: ({ kind }) => timeoutByKind[kind],
  };
}

function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined;
  return Math.floor(timeoutMs);
}
