import type {
  InteractionOutcome,
  InteractionRequestKind,
} from "./InteractionContract.js";

export type InteractionPolicyMode = "interactive" | "headless" | "disabled";

export type InteractionPolicyInput = {
  kind: InteractionRequestKind;
  mode: InteractionPolicyMode;
  /** Whether the current adapter can actually answer a request. */
  hasAnswerer: boolean;
  /** Permission/session-level prompt admission, when known. */
  canPrompt?: boolean;
};

export type InteractionPolicyDecision = {
  outcome: Extract<InteractionOutcome, "ask" | "deny" | "cancel">;
  reason: string;
};

/** Host-independent admission policy for approval and question consumers. */
export type InteractionPolicy = {
  decide(input: InteractionPolicyInput): InteractionPolicyDecision;
};

/**
 * Default profile policy. It never waits when the profile explicitly disables
 * interaction or when no answerer/sink exists. Headless profiles are allowed
 * to ask only when a deterministic answerer has been composed.
 */
export function createDefaultInteractionPolicy(): InteractionPolicy {
  return {
    decide(input) {
      const fallback = input.kind === "question" ? "cancel" : "deny";
      if (input.mode === "disabled") {
        return { outcome: fallback, reason: "Interaction is disabled for this profile." };
      }
      if (input.canPrompt === false) {
        return { outcome: fallback, reason: "Prompts are disabled for this session." };
      }
      if (!input.hasAnswerer) {
        return { outcome: fallback, reason: "No interaction answerer is available." };
      }
      return { outcome: "ask", reason: "Interaction is admitted by the active profile." };
    },
  };
}
