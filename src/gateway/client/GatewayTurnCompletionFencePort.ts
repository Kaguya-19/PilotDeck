/** Exact completion handle for one Gateway-submitted turn. */
export type GatewayTurnCompletionHandle = {
  readonly done: Promise<void>;
};

/**
 * Volatile drain fence between Gateway turn abort and the submit generator's
 * final Router cleanup. It never admits turns or owns Router state.
 */
export type GatewayTurnCompletionFencePort = {
  begin(sessionKey: string): GatewayTurnCompletionHandle;
  isCurrent(sessionKey: string, handle: GatewayTurnCompletionHandle): boolean;
  complete(sessionKey: string, handle: GatewayTurnCompletionHandle): void;
  waitForCompletion(sessionKey: string): Promise<void>;
};
