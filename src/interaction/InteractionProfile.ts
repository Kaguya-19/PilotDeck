import type { InteractionPolicyMode } from "./InteractionPolicy.js";

/** A composition-level selection, not a second interaction state machine. */
export const INTERACTION_PROFILE_NAMES = ["interactive", "headless", "disabled"] as const;

export type InteractionProfileName = (typeof INTERACTION_PROFILE_NAMES)[number];

export const DEFAULT_INTERACTION_PROFILE_NAME: InteractionProfileName = "interactive";

export function isInteractionProfileName(value: unknown): value is InteractionProfileName {
  return value === "interactive" || value === "headless" || value === "disabled";
}

export type InteractionQuestionProvider = "gateway" | "deterministic" | "disabled";
export type InteractionPermissionProvider = "gateway" | "fail_closed";

export type InteractionProfile = Readonly<{
  name: InteractionProfileName;
  policyMode: InteractionPolicyMode;
  /** Whether prompt-dependent tools are exposed to this agent scope. */
  canPrompt: boolean;
  questionProvider: InteractionQuestionProvider;
  permissionProvider: InteractionPermissionProvider;
}>;

const PROFILES: Readonly<Record<InteractionProfileName, InteractionProfile>> = Object.freeze({
  interactive: Object.freeze({
    name: "interactive",
    policyMode: "interactive",
    canPrompt: true,
    questionProvider: "gateway",
    permissionProvider: "gateway",
  }),
  headless: Object.freeze({
    name: "headless",
    policyMode: "headless",
    // A deterministic question answerer is available. Permission asks still
    // fail closed because they do not have a human approval answerer.
    canPrompt: true,
    questionProvider: "deterministic",
    permissionProvider: "fail_closed",
  }),
  disabled: Object.freeze({
    name: "disabled",
    policyMode: "disabled",
    canPrompt: false,
    questionProvider: "disabled",
    permissionProvider: "fail_closed",
  }),
});

/** Resolve the profile selected by application composition. */
export function resolveInteractionProfile(
  profile: InteractionProfileName | undefined,
): InteractionProfile {
  return PROFILES[profile ?? DEFAULT_INTERACTION_PROFILE_NAME];
}
