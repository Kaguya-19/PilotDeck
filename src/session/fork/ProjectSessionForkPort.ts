import type { ProjectSessionStorageProvider } from "../storage/ProjectSessionStorageProvider.js";
import { createProjectSessionDataPlane } from "../storage/ProjectSessionDataPlane.js";
export { ProjectSessionForkUnavailableError } from "../storage/ProjectSessionDataPlane.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";

/** Durable fork plan prepared by a Web/application consumer. */
export type ProjectSessionForkInput = {
  projectRoot: string;
  pilotHome: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** Target-session entries, including the fork metadata entry. */
  entries: readonly AgentTranscriptEntry[];
};

/**
 * Provider-owned durable fork transaction.
 *
 * The caller owns fork-point selection and user-facing metadata. The selected
 * persistence provider owns writing the target stream, any auxiliary artifact
 * transfer, and publication/cleanup semantics for its own backend.
 */
export type ProjectSessionForkPort = {
  fork(input: ProjectSessionForkInput): Promise<void>;
};

export type CreateProjectSessionForkPortOptions = {
  storageProvider?: ProjectSessionStorageProvider;
};

/** Raised instead of falling back to JSONL for a selected backend. */
/** @deprecated Resolve ProjectSessionDataPlane once in application composition. */
export function createProjectSessionForkPort(
  options: CreateProjectSessionForkPortOptions = {},
): ProjectSessionForkPort {
  return createProjectSessionDataPlane(options).fork;
}
