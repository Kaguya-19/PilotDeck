import { buildCachePlan, type CachePlan, type CachePlanInput } from "./CachePlan.js";
import type { PromptCacheCoordinatorPort } from "./PromptCacheCoordinatorPort.js";

type CachePlanState = {
  fingerprint: string;
  generation: number;
};

/** Native in-memory prompt-cache generation coordinator. */
export class PromptCacheCoordinator implements PromptCacheCoordinatorPort {
  private readonly bySession = new Map<string, CachePlanState>();
  private readonly resetSessions = new Set<string>();

  createPlan(sessionId: string, input: CachePlanInput): CachePlan | undefined {
    const fingerprint = buildCachePlan(input, 0)?.fingerprint;
    const previous = this.bySession.get(sessionId);
    const forceReset = this.resetSessions.delete(sessionId);
    if (!fingerprint) return undefined;

    if (forceReset || fingerprint !== previous?.fingerprint) {
      const generation = (previous?.generation ?? 0) + 1;
      this.bySession.set(sessionId, { fingerprint, generation });
      return buildCachePlan(input, generation);
    }
    return buildCachePlan(input, previous.generation);
  }

  reset(sessionId: string): void {
    if (sessionId) this.resetSessions.add(sessionId);
  }

  release(sessionId: string): void {
    if (!sessionId) return;
    this.bySession.delete(sessionId);
    this.resetSessions.delete(sessionId);
  }
}
