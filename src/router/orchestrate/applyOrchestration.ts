import type { RouterAutoOrchestrateConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";

export type OrchestrationInput = {
  config: RouterAutoOrchestrateConfig;
  isMainAgent: boolean;
  tier?: string;
  /** When true the session was already orchestrating on a prior turn. */
  alreadyOrchestrating?: boolean;
};

export type OrchestrationResult = {
  mutations: RouterMutationsLog;
  /** True when orchestration is active for this turn. */
  applied: boolean;
};

export function applyOrchestration(input: OrchestrationInput): OrchestrationResult {
  const { config } = input;
  console.log(
    `[autoOrch] input: tier=${input.tier}, isMain=${input.isMainAgent}, alreadyOrch=${input.alreadyOrchestrating}, triggerTiers=${config.triggerTiers}`,
  );
  if (!config.enabled || !input.isMainAgent) {
    return { mutations: {}, applied: false };
  }

  if (!input.alreadyOrchestrating) {
    const triggerTiers = config.triggerTiers ?? [];
    if (triggerTiers.length > 0 && (!input.tier || !triggerTiers.includes(input.tier))) {
      console.log(`[autoOrch] tier "${input.tier}" not in triggerTiers, skipping`);
      return { mutations: {}, applied: false };
    }
  }

  const mutations: RouterMutationsLog = {
    orchestrationActivated: {
      tier: input.tier ?? "main",
      continued: input.alreadyOrchestrating === true,
    },
  };
  console.log(`[autoOrch] orchestration active: continued=${input.alreadyOrchestrating === true}`);
  return {
    mutations,
    applied: true,
  };
}
