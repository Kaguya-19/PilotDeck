import type { PermissionMode, PermissionRule, PermissionRuleSet } from "../../permission/index.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";

/** Apply turn-owned user choices without replacing application policy rules. */
export function applyAgentPermissionOverrides(
  config: AgentRuntimeConfig,
  input: {
    permissionMode?: PermissionMode;
    basePermissionMode?: PermissionMode;
    permissionRules?: Partial<PermissionRuleSet>;
  },
): void {
  if (input.permissionMode) {
    if (input.permissionMode === "plan" && config.permissionMode !== "plan") {
      config.permissionModeBeforePlan = input.basePermissionMode ?? config.permissionMode;
    }
    config.permissionMode = input.permissionMode;
    config.permissionContext.mode = input.permissionMode;
  }
  if (!input.permissionRules) return;
  replaceUserRules(config.permissionContext.rules.allow, input.permissionRules.allow);
  replaceUserRules(config.permissionContext.rules.deny, input.permissionRules.deny);
  replaceUserRules(config.permissionContext.rules.ask, input.permissionRules.ask);
}

export function replaceUserRules(target: PermissionRule[], incoming: PermissionRule[] | undefined): void {
  const nonUserRules = target.filter((rule) => rule.source !== "user");
  // Turn input represents an end-user override. It cannot introduce a rule
  // with application-owned provenance into the live permission policy.
  const userRules = (incoming ?? []).filter((rule) => rule.source === "user");
  target.splice(0, target.length, ...nonUserRules, ...userRules);
}
