import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AgentRuntimeConfig } from "../agent/index.js";
import type { ModelRuntime, MultimodalConstraints } from "../model/index.js";
import { createDefaultPermissionContext, type PermissionRuleSet } from "../permission/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import type { InteractionProfile } from "../interaction/index.js";
import type { PilotDeckRuntimeProfile } from "./PilotDeckRuntimeProfile.js";

export type SessionAgentConfigRuntime = {
  projectRoot: string;
  snapshot: PilotConfigSnapshot;
  /** Immutable provider selections frozen with this project generation. */
  profile: Pick<PilotDeckRuntimeProfile, "runtimeContextSurface">;
  model: ModelRuntime;
};

export type SessionAgentConfigBundleOptions = {
  runtime: SessionAgentConfigRuntime;
  sessionOverride?: SessionConfigOverride;
  permissionRules: PermissionRuleSet;
  interaction: Pick<InteractionProfile, "canPrompt">;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  additionalWorkingDirectories?: string[];
  env: Record<string, string | undefined>;
};

/**
 * Builds the immutable AgentRuntimeConfig consumed by one session.
 *
 * This is a data-plane consumer: model capability lookups, permission policy
 * and session overrides remain owned by their providers. It creates no model,
 * permission, session, or AgentLoop state.
 */
export class SessionAgentConfigBundle {
  constructor(private readonly options: SessionAgentConfigBundleOptions) {}

  compose(): AgentRuntimeConfig {
    const { runtime, sessionOverride, permissionRules } = this.options;
    const agent = runtime.snapshot.config.agent;
    const permissionMode = sessionOverride?.permissionMode ?? this.options.permissionMode;
    const cwd = sessionOverride?.cwd ?? runtime.projectRoot;

    let modelMultimodal: MultimodalConstraints | undefined;
    try {
      modelMultimodal = runtime.model.getMultimodal(agent.model.provider, agent.model.model);
    } catch {
      // Model or provider not found: retain the text-only compatibility path.
    }

    let maxContextTokens: number | undefined;
    let maxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(agent.model.provider, agent.model.model);
      maxContextTokens = agent.maxContextTokens ?? caps.maxContextTokens;
      maxOutputTokens = caps.maxOutputTokens;
    } catch {
      maxContextTokens = agent.maxContextTokens;
    }
    maxOutputTokens = readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
      ?? agent.maxOutputTokens
      ?? maxOutputTokens;

    const subagentModel = agent.subagents?.default;
    let subagentRuntimeModel: AgentRuntimeConfig["subagentModel"];
    if (subagentModel) {
      let subagentModelMultimodal: MultimodalConstraints | undefined;
      try {
        subagentModelMultimodal = runtime.model.getMultimodal(
          subagentModel.provider,
          subagentModel.model,
        );
      } catch {
        // Keep the explicit subagent model when the provider is unavailable.
      }
      let subagentMaxContextTokens: number | undefined;
      let subagentMaxOutputTokens: number | undefined;
      try {
        const caps = runtime.model.getCapabilities(subagentModel.provider, subagentModel.model);
        subagentMaxContextTokens = caps.maxContextTokens;
        subagentMaxOutputTokens = caps.maxOutputTokens;
      } catch {
        // Keep the override even when optional capability metadata is absent.
      }
      subagentRuntimeModel = {
        provider: subagentModel.provider,
        model: subagentModel.model,
        ...(subagentModelMultimodal ? { modelMultimodal: subagentModelMultimodal } : {}),
        ...(subagentMaxContextTokens !== undefined ? { maxContextTokens: subagentMaxContextTokens } : {}),
        ...(subagentMaxOutputTokens !== undefined
          ? {
              maxOutputTokens: readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
                ?? subagentMaxOutputTokens,
            }
          : {}),
      };
    }

    return {
      provider: agent.model.provider,
      model: agent.model.model,
      modelMultimodal,
      cwd,
      permissionMode,
      jsonSelfCorrect: true,
      ...(subagentRuntimeModel ? { subagentModel: subagentRuntimeModel } : {}),
      subagentTimeoutMs: agent.subagents?.timeoutMs,
      maxSubagentDepth: agent.subagents?.maxDepth,
      maxContextTokens,
      maxOutputTokens,
      runtimeContextSurface: runtime.profile.runtimeContextSurface,
      thinking: agent.thinking,
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        canPrompt: this.options.interaction.canPrompt,
        bypassAvailable: sessionOverride?.bypassAvailable ?? true,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        rules: {
          allow: permissionRules.allow,
          deny: permissionRules.deny,
          ask: permissionRules.ask,
        },
      }),
    };
  }
}

function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}
