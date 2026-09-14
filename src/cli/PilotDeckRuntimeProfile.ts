import {
  resolveRuntimeContextSurface,
  type RuntimeContextSurface,
} from "../context/index.js";
import {
  resolveInteractionProfile,
  type InteractionProfile,
  type InteractionProfileName,
} from "../interaction/index.js";
import type { PilotAgentConfig } from "../pilot/config/types.js";
import {
  resolveSandboxMode,
  type SandboxMode,
} from "../tool/execution-world/SandboxPort.js";

/**
 * Provider selections shared by project execution and session composition.
 * This is immutable configuration, not a runtime or state owner.
 */
export type PilotDeckRuntimeProfile = Readonly<{
  sandboxMode: SandboxMode;
  runtimeContextSurface: RuntimeContextSurface;
  interaction: InteractionProfile;
}>;

export type ResolvePilotDeckRuntimeProfileInput = {
  agent: Pick<PilotAgentConfig, "sandboxMode" | "runtimeContextSurface" | "interactionProfile">;
  /** Application-level interaction profile takes precedence over project config. */
  interactionProfileOverride?: InteractionProfileName;
  /** Compatibility selection for the legacy automatic elicitation mode. */
  autoElicitation?: boolean;
};

/** Application-owned selections applied when staging a project generation. */
export type PilotDeckRuntimeProfileOverrides = Pick<
  ResolvePilotDeckRuntimeProfileInput,
  "interactionProfileOverride" | "autoElicitation"
>;

/** Resolve native provider selections from one agent configuration snapshot. */
export function resolvePilotDeckRuntimeProfile(
  input: ResolvePilotDeckRuntimeProfileInput,
): PilotDeckRuntimeProfile {
  const selectedInteraction = input.interactionProfileOverride
    ?? (input.autoElicitation ? "headless" : input.agent.interactionProfile);
  return {
    sandboxMode: resolveSandboxMode(input.agent.sandboxMode),
    runtimeContextSurface: resolveRuntimeContextSurface(input.agent.runtimeContextSurface),
    interaction: resolveInteractionProfile(selectedInteraction),
  };
}
