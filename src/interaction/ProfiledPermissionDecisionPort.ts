import type { PermissionDecisionPort } from "../permission/PermissionDecisionPort.js";
import type { PermissionDecision } from "../permission/protocol/types.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../tool/index.js";
import type { InteractionPolicy, InteractionPolicyMode } from "./InteractionPolicy.js";

export type ProfiledPermissionDecisionPortOptions = {
  policy: InteractionPolicy;
  mode: InteractionPolicyMode;
  /** True only when this profile composes a real approval answerer. */
  hasAnswerer: boolean;
  canPrompt: boolean;
};

/**
 * Interaction-owned permission consumer.
 *
 * It preserves every non-ask decision from the underlying permission
 * provider. For an ask, it applies the selected profile before ToolRuntime
 * can create a permission lifecycle wait. This makes headless and disabled
 * profiles fail closed without a Gateway bus, pending request, or a second
 * approval state owner.
 */
export function createProfiledPermissionDecisionPort(
  delegate: PermissionDecisionPort,
  options: ProfiledPermissionDecisionPortOptions,
): PermissionDecisionPort {
  return {
    async decide(
      tool: PilotDeckToolDefinition,
      input: unknown,
      context: PilotDeckToolRuntimeContext,
      toolCallId: string,
    ): Promise<PermissionDecision> {
      const decision = await delegate.decide(tool, input, context, toolCallId);
      if (decision.type !== "ask") return decision;

      const admission = options.policy.decide({
        kind: "permission",
        mode: options.mode,
        hasAnswerer: options.hasAnswerer,
        canPrompt: options.canPrompt,
      });
      if (admission.outcome === "ask") return decision;

      const reason = { type: "runtime" as const, message: admission.reason };
      return admission.outcome === "cancel"
        ? { type: "cancel", reason, message: admission.reason }
        : { type: "deny", reason, message: admission.reason };
    },
  };
}
