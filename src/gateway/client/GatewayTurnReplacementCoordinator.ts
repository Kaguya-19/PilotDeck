import { DialogGatewayError } from "../dialog/errors.js";
import type {
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../protocol/types.js";
import type { GatewayTurnReplacementCoordinatorPort } from "./GatewayTurnReplacementCoordinatorPort.js";

type PendingTurnReplacement = {
  transactionId: string;
  replacementTurnId: string;
  projectKey?: string;
  timeout?: ReturnType<typeof setTimeout>;
  phase: "prepared" | "submitting" | "finalizing";
};

export type GatewayTurnReplacementStoragePort = {
  replaceLastTurn?: (input: WebReplaceLastTurnInput) => Promise<WebReplaceLastTurnResult>;
  finalizeLastTurnReplacement?: (
    input: WebFinalizeLastTurnReplacementInput,
  ) => Promise<WebFinalizeLastTurnReplacementResult>;
};

export type GatewayTurnReplacementSessionPort = {
  activeTurnRunId(sessionKey: string): string | undefined;
  hasActiveTurn(sessionKey: string): boolean;
  abortExpectedTurn(sessionKey: string, runId: string): Promise<void>;
  closeSession(sessionKey: string): Promise<void>;
};

export type GatewayTurnReplacementCoordinatorOptions = {
  storage?: GatewayTurnReplacementStoragePort;
  session: GatewayTurnReplacementSessionPort;
  timeoutMs: number;
  warn?: (message: string, error: unknown) => void;
};

/**
 * Native coordinator for a prepared replacement transaction.
 *
 * It owns only live reservations, submit claims, and timeout scheduling.
 * Durable transcript rewrite/finalization and Router/Agent lifecycle are
 * delegated to their existing providers through narrow ports.
 */
export class GatewayTurnReplacementCoordinator implements GatewayTurnReplacementCoordinatorPort {
  private readonly pending = new Map<string, PendingTurnReplacement>();
  private readonly transcriptWriteReservations = new Set<string>();
  private readonly timeoutMs: number;
  private readonly warn: (message: string, error: unknown) => void;

  constructor(private readonly options: GatewayTurnReplacementCoordinatorOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs);
    this.warn = options.warn ?? ((message, error) => console.warn(message, error));
  }

  reserveTranscriptWrite(sessionKey: string, operation: string): void {
    if (this.hasTranscriptWriteReservation(sessionKey) || this.pending.has(sessionKey)) {
      throw new DialogGatewayError(
        "SESSION_BUSY",
        `Cannot ${operation} while another transcript update is pending.`,
      );
    }
    this.transcriptWriteReservations.add(sessionKey);
  }

  releaseTranscriptWrite(sessionKey: string): void {
    this.transcriptWriteReservations.delete(sessionKey);
  }

  hasTranscriptWriteReservation(sessionKey: string): boolean {
    return this.transcriptWriteReservations.has(sessionKey);
  }

  async replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult> {
    const replaceLastTurn = this.requireReplace();
    if (typeof input.replacementTurnId !== "string" || !input.replacementTurnId.trim()) {
      throw new DialogGatewayError("replace_invalid_input", "replacementTurnId is required.");
    }
    if (this.hasTranscriptWriteReservation(input.sessionKey) || this.pending.has(input.sessionKey)) {
      throw new DialogGatewayError(
        "replace_turn_pending",
        "A replacement transaction is already pending for this session.",
      );
    }

    const activeRunId = this.options.session.activeTurnRunId(input.sessionKey);
    if (activeRunId && activeRunId !== input.expectedTurnId) {
      throw new DialogGatewayError(
        "replace_turn_conflict",
        "The selected message is no longer the active turn.",
        { activeRunId, expectedTurnId: input.expectedTurnId },
      );
    }
    const finalizeLastTurnReplacement = this.requireFinalizeForReplace();

    this.transcriptWriteReservations.add(input.sessionKey);
    let result: WebReplaceLastTurnResult | undefined;
    try {
      if (activeRunId) {
        await this.options.session.abortExpectedTurn(input.sessionKey, activeRunId);
      }
      result = await replaceLastTurn(input);
      this.pending.set(input.sessionKey, {
        transactionId: result.transactionId,
        replacementTurnId: input.replacementTurnId,
        projectKey: input.projectKey,
        phase: "prepared",
      });
      this.scheduleTimeout(input.sessionKey);
      await this.options.session.closeSession(input.sessionKey);
      return result;
    } catch (error) {
      this.clearPending(input.sessionKey);
      if (result) {
        await finalizeLastTurnReplacement({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          transactionId: result.transactionId,
          action: "rollback",
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.transcriptWriteReservations.delete(input.sessionKey);
    }
  }

  claimForSubmit(sessionKey: string, runId: string): "none" | "claimed" | "conflict" {
    const pending = this.pending.get(sessionKey);
    if (!pending) return "none";
    if (pending.replacementTurnId !== runId || pending.phase !== "prepared") return "conflict";
    pending.phase = "submitting";
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    return "claimed";
  }

  releaseSubmitClaim(sessionKey: string, runId: string): void {
    const pending = this.pending.get(sessionKey);
    if (!pending || pending.replacementTurnId !== runId || pending.phase !== "submitting") return;
    pending.phase = "prepared";
    this.scheduleTimeout(sessionKey);
  }

  async commitAcceptedInput(sessionKey: string, runId: string): Promise<void> {
    const pending = this.pending.get(sessionKey);
    const finalizeLastTurnReplacement = this.options.storage?.finalizeLastTurnReplacement;
    if (
      !pending
      || pending.replacementTurnId !== runId
      || pending.phase !== "submitting"
      || !finalizeLastTurnReplacement
    ) {
      return;
    }
    pending.phase = "finalizing";
    if (pending.timeout) clearTimeout(pending.timeout);
    try {
      await finalizeLastTurnReplacement({
        sessionKey,
        projectKey: pending.projectKey,
        transactionId: pending.transactionId,
        action: "commit",
      });
    } catch (error) {
      // accepted_input is durable. Retaining a stale backup is safer than
      // blocking the now-live replacement turn.
      this.warn("[pilotdeck] failed to remove accepted replacement backup:", error);
    } finally {
      this.clearPending(sessionKey);
    }
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    const finalizeLastTurnReplacement = this.requireFinalize();
    const pending = this.pending.get(input.sessionKey);
    if (!pending || pending.transactionId !== input.transactionId) {
      throw new DialogGatewayError(
        "replace_transaction_conflict",
        "The replacement transaction is no longer pending.",
      );
    }
    if (pending.phase !== "prepared") {
      throw new DialogGatewayError(
        "replace_transaction_pending",
        "The replacement transaction is already being finalized.",
      );
    }
    pending.phase = "finalizing";
    if (pending.timeout) clearTimeout(pending.timeout);
    try {
      if (input.action === "rollback") {
        if (this.options.session.hasActiveTurn(input.sessionKey)) {
          throw new DialogGatewayError(
            "replace_transaction_active",
            "The replacement cannot be rolled back while its turn is active.",
          );
        }
        await this.options.session.closeSession(input.sessionKey);
      }
      const result = await finalizeLastTurnReplacement(input);
      this.clearPending(input.sessionKey);
      return result;
    } catch (error) {
      pending.phase = "prepared";
      this.scheduleTimeout(input.sessionKey);
      throw error;
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    this.pending.clear();
    this.transcriptWriteReservations.clear();
  }

  private requireReplace(): NonNullable<GatewayTurnReplacementStoragePort["replaceLastTurn"]> {
    const replaceLastTurn = this.options.storage?.replaceLastTurn;
    if (!replaceLastTurn) {
      throw new Error("replace_last_turn is not configured. Wire `replaceLastTurn` via createLocalGateway.");
    }
    return replaceLastTurn;
  }

  private requireFinalizeForReplace(): NonNullable<GatewayTurnReplacementStoragePort["finalizeLastTurnReplacement"]> {
    const finalizeLastTurnReplacement = this.options.storage?.finalizeLastTurnReplacement;
    if (!finalizeLastTurnReplacement) {
      throw new Error(
        "finalize_last_turn_replacement is required when replace_last_turn is configured.",
      );
    }
    return finalizeLastTurnReplacement;
  }

  private requireFinalize(): NonNullable<GatewayTurnReplacementStoragePort["finalizeLastTurnReplacement"]> {
    const finalizeLastTurnReplacement = this.options.storage?.finalizeLastTurnReplacement;
    if (!finalizeLastTurnReplacement) {
      throw new Error(
        "finalize_last_turn_replacement is not configured. Wire `finalizeLastTurnReplacement` via createLocalGateway.",
      );
    }
    return finalizeLastTurnReplacement;
  }

  private scheduleTimeout(sessionKey: string): void {
    const pending = this.pending.get(sessionKey);
    if (!pending || pending.phase !== "prepared") return;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      void this.rollbackExpired(sessionKey, pending.transactionId);
    }, this.timeoutMs);
    pending.timeout.unref?.();
  }

  private clearPending(sessionKey: string): void {
    const pending = this.pending.get(sessionKey);
    if (pending?.timeout) clearTimeout(pending.timeout);
    this.pending.delete(sessionKey);
  }

  private async rollbackExpired(sessionKey: string, transactionId: string): Promise<void> {
    const pending = this.pending.get(sessionKey);
    const finalizeLastTurnReplacement = this.options.storage?.finalizeLastTurnReplacement;
    if (!pending || !finalizeLastTurnReplacement || pending.transactionId !== transactionId || pending.phase !== "prepared") return;
    if (this.options.session.hasActiveTurn(sessionKey)) {
      this.scheduleTimeout(sessionKey);
      return;
    }
    pending.phase = "finalizing";
    try {
      await this.options.session.closeSession(sessionKey);
      await finalizeLastTurnReplacement({
        sessionKey,
        projectKey: pending.projectKey,
        transactionId: pending.transactionId,
        action: "rollback",
      });
      this.clearPending(sessionKey);
    } catch (error) {
      pending.phase = "prepared";
      this.warn("[pilotdeck] failed to roll back expired replacement transaction:", error);
      this.scheduleTimeout(sessionKey);
    }
  }
}
