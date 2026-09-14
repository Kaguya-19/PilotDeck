/** Input for best-effort persistence of a large Gateway tool-result projection. */
export type GatewayToolResultArtifactInput = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  text: string;
};

/**
 * Definition used by Gateway event projection for non-durable host result
 * artifacts. The returned path is advisory; callers must not infer successful
 * persistence from it.
 */
export type GatewayToolResultArtifactStorePort = {
  persist(input: GatewayToolResultArtifactInput): string | undefined;
};
