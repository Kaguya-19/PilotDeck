import type {
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../protocol/types.js";

/** Volatile transaction coordinator for replacing the latest Gateway turn. */
export type GatewayTurnReplacementCoordinatorPort = {
  reserveTranscriptWrite(sessionKey: string, operation: string): void;
  releaseTranscriptWrite(sessionKey: string): void;
  hasTranscriptWriteReservation(sessionKey: string): boolean;
  replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult>;
  finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult>;
  claimForSubmit(sessionKey: string, runId: string): "none" | "claimed" | "conflict";
  releaseSubmitClaim(sessionKey: string, runId: string): void;
  commitAcceptedInput(sessionKey: string, runId: string): Promise<void>;
  dispose(): void;
};
