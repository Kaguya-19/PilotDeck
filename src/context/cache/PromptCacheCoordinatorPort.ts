import type { CachePlan, CachePlanInput } from "./CachePlan.js";

/** Session-scoped generation owner for prompt-cache plans. */
export type PromptCacheCoordinatorPort = {
  createPlan(sessionId: string, input: CachePlanInput): CachePlan | undefined;
  reset(sessionId: string): void;
  /** Releases all volatile cache-generation state owned for one finished session. */
  release(sessionId: string): void;
};
