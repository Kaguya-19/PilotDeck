import type { AgentLoopRunner } from "../turn/TurnRunner.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentLoopSeedState } from "./AgentLoop.js";
import type { AgentTurnCapabilities } from "./AgentTurnCapabilities.js";

/**
 * Composition boundary for replacing the in-process AgentLoop runner.
 *
 * A deployment can supply a sidecar or other runner here, but it receives
 * only the turn capability view. Session, scope, gateway, router ownership,
 * child inboxes, and persistence remain with their existing owners.
 */
export type AgentLoopRuntimeFactoryInput = {
  config: AgentRuntimeConfig;
  capabilities: AgentTurnCapabilities;
  seedState?: AgentLoopSeedState;
};

export type AgentLoopRuntimeFactory = (
  input: AgentLoopRuntimeFactoryInput,
) => AgentLoopRunner;
