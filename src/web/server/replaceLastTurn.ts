/** Prepare or finalize the latest-turn replacement through selected session storage. */

import { randomUUID } from "node:crypto";
import { mergeMetadata } from "../../session/metadata/SessionMetadataStore.js";
import {
  createProjectSessionReplacementPort,
  readAgentProjectSessionPersistence,
  recoverNodeProjectSessionReplacements,
  type ProjectSessionReplacementPort,
  type ProjectSessionReplacementOwner,
  type ProjectSessionStorageProvider,
  type RecoverNodeProjectSessionReplacementsOptions,
  type RecoverNodeProjectSessionReplacementsResult,
} from "../../session/index.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "../../session/transcript/TranscriptEntry.js";
import type {
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../client/protocol.js";

export type ReplaceLastWebSessionTurnOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Application-selected backend for source reads and replacement transactions. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Explicit application-selected replacement transaction port. */
  sessionReplacementPort?: ProjectSessionReplacementPort;
  now?: () => Date;
  /** Identifies the live Gateway process that owns a prepared transaction. */
  transactionOwner?: ReplacementTransactionOwner;
};

export type ReplacementTransactionOwner = ProjectSessionReplacementOwner;
export type RecoverLastTurnReplacementsResult = RecoverNodeProjectSessionReplacementsResult;
export type RecoverLastTurnReplacementsOptions = RecoverNodeProjectSessionReplacementsOptions;
export const recoverPendingLastTurnReplacements = recoverNodeProjectSessionReplacements;

export class ReplaceLastTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReplaceLastTurnError";
  }
}

function findLatestAcceptedInput(
  entries: AgentTranscriptEntry[],
): { entry: AgentAcceptedInputTranscriptEntry; index: number } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "accepted_input") return { entry, index };
  }
  return undefined;
}

function latestMetadataSnapshot(entries: AgentTranscriptEntry[]): SessionMetadataValue {
  return entries.reduce<SessionMetadataValue>((metadata, entry) => (
    entry.type === "session_metadata"
      ? mergeMetadata(metadata, entry.metadata)
      : metadata
  ), {});
}

function removeGeneratedTitleFromPrefix(entries: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "session_metadata" || entry.metadata.aiTitle === undefined) return entry;
    const metadata = { ...entry.metadata };
    delete metadata.aiTitle;
    return { ...entry, metadata };
  });
}

function createPreservedMetadataEntry(
  entries: AgentTranscriptEntry[],
  preserved: AgentTranscriptEntry[],
  now: Date,
): AgentSessionMetadataTranscriptEntry | undefined {
  const metadata = latestMetadataSnapshot(entries);
  delete metadata.lastPrompt;
  if (!preserved.some((entry) => entry.type === "accepted_input")) {
    delete metadata.firstPrompt;
    delete metadata.aiTitle;
  }

  const hasMetadata = Object.entries(metadata).some(([key, value]) => (
    key !== "isSnapshot" && key !== "updatedAt" && value !== undefined
  ));
  if (!hasMetadata) return undefined;

  const sequence = preserved.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 1;
  const parentEntryId = [...preserved]
    .reverse()
    .find((entry) => typeof entry.entryId === "string" && entry.entryId)?.entryId ?? null;
  return {
    type: "session_metadata",
    sessionId: entries[0]?.sessionId ?? "",
    turnId: "metadata-replace",
    sequence,
    createdAt: now.toISOString(),
    entryId: randomUUID(),
    parentEntryId,
    metadata: {
      ...metadata,
      isSnapshot: true,
      updatedAt: now.toISOString(),
    },
  };
}

type ReplacementPlan = {
  replacedTurnId: string;
  removedEntryCount: number;
  rewrittenEntries: AgentTranscriptEntry[];
};

function createReplacementPlan(
  entries: AgentTranscriptEntry[],
  input: WebReplaceLastTurnInput,
  now: Date,
): ReplacementPlan {
  const latest = findLatestAcceptedInput(entries);
  if (!latest) {
    throw new ReplaceLastTurnError("replace_empty_transcript", "No user turn is available to replace.");
  }
  const { entry: latestInput, index: latestInputIndex } = latest;
  if (latestInput.turnId !== input.expectedTurnId) {
    throw new ReplaceLastTurnError(
      "replace_turn_conflict",
      "The selected message is no longer the latest user turn.",
    );
  }

  const originalPrefix = entries.slice(0, latestInputIndex);
  const replacingFirstInput = !originalPrefix.some((entry) => entry.type === "accepted_input");
  const preserved = replacingFirstInput
    ? removeGeneratedTitleFromPrefix(originalPrefix)
    : originalPrefix;
  const metadataEntry = createPreservedMetadataEntry(entries, preserved, now);
  return {
    replacedTurnId: latestInput.turnId,
    removedEntryCount: entries.length - latestInputIndex,
    rewrittenEntries: metadataEntry ? [...preserved, metadataEntry] : preserved,
  };
}

function validateReplacementInput(input: WebReplaceLastTurnInput): void {
  if (
    typeof input.sessionKey !== "string"
    || !input.sessionKey.trim()
    || typeof input.expectedTurnId !== "string"
    || !input.expectedTurnId.trim()
    || typeof input.replacementTurnId !== "string"
    || !input.replacementTurnId.trim()
  ) {
    throw new ReplaceLastTurnError(
      "replace_invalid_input",
      "sessionKey, expectedTurnId, and replacementTurnId are required.",
    );
  }
}

function validateTransactionId(transactionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) {
    throw new ReplaceLastTurnError("replace_invalid_transaction", "The replacement transaction is invalid.");
  }
}

export async function replaceLastWebSessionTurn(
  input: WebReplaceLastTurnInput,
  options: ReplaceLastWebSessionTurnOptions,
): Promise<WebReplaceLastTurnResult> {
  validateReplacementInput(input);
  const projectRoot = input.projectKey ?? options.projectRoot;
  const { entries, diagnostics } = await readAgentProjectSessionPersistence({
    projectRoot,
    pilotHome: options.pilotHome,
    sessionId: input.sessionKey,
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
  });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ReplaceLastTurnError(
      "replace_invalid_transcript",
      "The conversation transcript could not be safely rewritten.",
    );
  }

  const now = options.now?.() ?? new Date();
  const plan = createReplacementPlan(entries, input, now);
  const transactionId = randomUUID();
  const replacementPort = options.sessionReplacementPort ?? createProjectSessionReplacementPort({
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
  });
  await replacementPort.prepare({
    projectRoot,
    pilotHome: options.pilotHome,
    sessionId: input.sessionKey,
    transactionId,
    replacementTurnId: input.replacementTurnId,
    preparedAt: now.toISOString(),
    ...(options.transactionOwner ? { owner: options.transactionOwner } : {}),
    originalEntries: entries,
    replacementEntries: plan.rewrittenEntries,
  });
  return {
    sessionKey: input.sessionKey,
    replacedTurnId: plan.replacedTurnId,
    removedEntryCount: plan.removedEntryCount,
    transactionId,
  };
}

export async function finalizeLastWebSessionTurnReplacement(
  input: WebFinalizeLastTurnReplacementInput,
  options: ReplaceLastWebSessionTurnOptions,
): Promise<WebFinalizeLastTurnReplacementResult> {
  if (
    typeof input.sessionKey !== "string"
    || !input.sessionKey.trim()
    || typeof input.transactionId !== "string"
    || !input.transactionId.trim()
  ) {
    throw new ReplaceLastTurnError(
      "replace_invalid_transaction",
      "sessionKey and transactionId are required.",
    );
  }
  validateTransactionId(input.transactionId);
  if (input.action !== "commit" && input.action !== "rollback") {
    throw new ReplaceLastTurnError("replace_invalid_action", "Replacement action must be commit or rollback.");
  }

  const replacementPort = options.sessionReplacementPort ?? createProjectSessionReplacementPort({
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
  });
  await replacementPort.finalize({
    projectRoot: input.projectKey ?? options.projectRoot,
    pilotHome: options.pilotHome,
    sessionId: input.sessionKey,
    transactionId: input.transactionId,
    action: input.action,
  });
  return {
    sessionKey: input.sessionKey,
    transactionId: input.transactionId,
    action: input.action,
  };
}
