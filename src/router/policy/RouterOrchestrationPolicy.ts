import type { RouterConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";
import { applyOrchestration } from "../orchestrate/applyOrchestration.js";

export type RouterOrchestrationPolicyInput = {
  isMainAgent: boolean;
  tier?: string;
  alreadyOrchestrating?: boolean;
};

export type RouterOrchestrationPolicyResult = {
  mutations: RouterMutationsLog;
  applied: boolean;
};

/** DSH-style Definition for optional orchestration admission. */
export type RouterOrchestrationPolicy = {
  decide(input: RouterOrchestrationPolicyInput): RouterOrchestrationPolicyResult;
  dispose?(): void | Promise<void>;
};

/** Native provider preserving config-driven auto-orchestration behavior. */
export function createNativeRouterOrchestrationPolicy(config: RouterConfig): RouterOrchestrationPolicy {
  return {
    decide(input) {
      const autoOrchestrate = config.autoOrchestrate;
      if (!autoOrchestrate) return { mutations: {}, applied: false };
      return applyOrchestration({ config: autoOrchestrate, ...input });
    },
  };
}
