import type { ProjectSessionStorageProvider } from "../storage/ProjectSessionStorageProvider.js";
import { createProjectSessionDataPlane } from "../storage/ProjectSessionDataPlane.js";
export { ProjectSessionReplacementUnavailableError } from "../storage/ProjectSessionDataPlane.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";

/** Identifies the live Gateway process that owns a prepared replacement. */
export type ProjectSessionReplacementOwner = {
  instanceId: string;
  pid: number;
};

/** Durable replacement plan prepared by the Web/application consumer. */
export type ProjectSessionReplacementPrepareInput = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  transactionId: string;
  replacementTurnId: string;
  preparedAt: string;
  owner?: ProjectSessionReplacementOwner;
  /** Complete source stream before truncation, retained for rollback/recovery. */
  originalEntries: readonly AgentTranscriptEntry[];
  /** Complete target stream visible while the replacement is pending. */
  replacementEntries: readonly AgentTranscriptEntry[];
};

export type ProjectSessionReplacementFinalizeInput = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  transactionId: string;
  action: "commit" | "rollback";
};

export type ProjectSessionReplacementRecoveryInput = {
  pilotHome: string;
};

export type ProjectSessionReplacementRecoveryResult = {
  committed: number;
  rolledBack: number;
  cleaned: number;
  skipped: number;
  failures: Array<{ scope: string; message: string }>;
};

/**
 * Provider-owned prepared replacement transaction.
 *
 * The caller owns stale-turn validation, title/metadata policy and live
 * Gateway reservations. The provider owns durable backup, rewrite,
 * commit/rollback, and crash recovery for its persistence backend.
 */
export type ProjectSessionReplacementPort = {
  prepare(input: ProjectSessionReplacementPrepareInput): Promise<void>;
  finalize(input: ProjectSessionReplacementFinalizeInput): Promise<void>;
  /** Runs before local Gateway publication so writers cannot race recovery. */
  recover(input: ProjectSessionReplacementRecoveryInput): ProjectSessionReplacementRecoveryResult;
};

export type CreateProjectSessionReplacementPortOptions = {
  storageProvider?: ProjectSessionStorageProvider;
};

/** @deprecated Resolve ProjectSessionDataPlane once in application composition. */
export function createProjectSessionReplacementPort(
  options: CreateProjectSessionReplacementPortOptions = {},
): ProjectSessionReplacementPort {
  return createProjectSessionDataPlane(options).replacement;
}
