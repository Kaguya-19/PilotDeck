/**
 * Host-independent interaction vocabulary shared by approval and question
 * consumers. Transport adapters may map these outcomes to their existing wire
 * payloads, but they must not invent a second timeout/cancellation contract.
 */
export type InteractionOutcome =
  | "allow"
  | "deny"
  | "ask"
  | "cancel"
  | "timeout"
  | "reconnect"
  | "failed"
  | "result_unknown";

export type InteractionRequestKind = "permission" | "question";

export type InteractionDeadline = {
  /** A finite, non-negative duration. `undefined` means no local deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Normalize adapter input without changing the existing `0ms` semantics. */
export function normalizeInteractionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined;
  return Math.floor(timeoutMs);
}

/** Canonical outcome used when an interaction deadline expires. */
export function interactionTimeoutOutcome(): Extract<InteractionOutcome, "timeout"> {
  return "timeout";
}
