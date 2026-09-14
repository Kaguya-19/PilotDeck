import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeCapability,
} from "../protocol/types.js";

export type ToolCapabilityPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "missing_runtime_capability" | "tool_not_allowed";
      capability?: PilotDeckToolRuntimeCapability;
    };

export type ToolCapabilityPolicy = {
  evaluate(tool: PilotDeckToolDefinition): ToolCapabilityPolicyDecision;
};

export type CreateToolCapabilityPolicyOptions = {
  allowedTools: readonly string[];
  runtimeCapabilities?: readonly PilotDeckToolRuntimeCapability[];
};

export function createToolCapabilityPolicy(
  options: CreateToolCapabilityPolicyOptions,
): ToolCapabilityPolicy {
  const allowedTools = new Set(options.allowedTools);
  const allowAll = allowedTools.has("*");
  const runtimeCapabilities = new Set(options.runtimeCapabilities ?? []);

  return {
    evaluate(tool) {
      if (!allowAll && !allowedTools.has(tool.name)) {
        return { allowed: false, reason: "tool_not_allowed" };
      }
      for (const capability of tool.requiredRuntimeCapabilities ?? []) {
        if (!runtimeCapabilities.has(capability)) {
          return {
            allowed: false,
            reason: "missing_runtime_capability",
            capability,
          };
        }
      }
      return { allowed: true };
    },
  };
}
