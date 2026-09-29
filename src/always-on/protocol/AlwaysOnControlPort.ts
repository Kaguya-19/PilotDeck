/**
 * Project-scoped controls exposed by an Always-On provider.
 *
 * This contract is independent from Gateway RPC and AgentSession state: the
 * provider owns scheduler, stores, workspaces, and run cleanup; transports
 * only adapt their requests to it.
 */
export type AlwaysOnApplyInput = {
  projectKey: string;
  workCycleId: string;
  projectName: string;
};

export type AlwaysOnApplyResult = {
  sessionKey: string;
  error?: { code: string; message: string };
};

export type AlwaysOnRerunPlanInput = {
  projectKey: string;
  planId: string;
  /** Presentation metadata accepted by Gateway clients; the runtime does not persist it. */
  projectName?: string;
};

export type AlwaysOnRerunPlanResult = {
  runId: string;
  error?: { code: string; message: string };
};

/**
 * Abort one active Always-On phase identified by the session key carried in
 * the existing `always-on:turn-event` notification. The key is validated by
 * the provider; Gateway never receives an arbitrary user-session abort here.
 */
export type AlwaysOnAbortInput = {
  projectKey: string;
  sessionKey: string;
  reason?: string;
};

export type AlwaysOnAbortResult = {
  aborted: boolean;
  sessionKey: string;
  runId?: string;
  error?: { code: string; message: string };
};

/** Definition consumed by Gateway, WebSocket, CLI, and other control adapters. */
export type AlwaysOnControlPort = {
  applyCycle(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult>;
  rerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult>;
  abortRun(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult>;
};
