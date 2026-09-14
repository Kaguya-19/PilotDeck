/**
 * Fork a web session transcript at a prior turn entry.
 *
 * User-message forks create a new session before that user turn and return
 * the forked text for composer prefill. Assistant-message forks preserve
 * history through the selected assistant entry and continue from there.
 */

import { randomUUID } from "node:crypto";
import { platform } from "node:process";
import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import { parseAgentRunMode } from "../../agent/protocol/input.js";
import {
  createProjectSessionForkPort,
  readAgentProjectSessionPersistence,
  type ProjectSessionForkPort,
  type ProjectSessionStorageProvider,
} from "../../session/index.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebAgentRunMode, WebGatewayMode, WebForkSessionInput, WebForkSessionResult } from "../client/protocol.js";

export type ForkWebSessionOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Application-selected durable backend used for source reads and fork writes. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Explicit application/test override for the selected durable fork transaction. */
  sessionForkPort?: ProjectSessionForkPort;
  now?: () => Date;
};

function newWebSessionKey(): string {
  const sep = platform === "win32" ? "-" : ":";
  return `web${sep}s_${randomUUID()}`;
}

function extractAcceptedInputText(entry: AgentAcceptedInputTranscriptEntry): string {
  const chunks: string[] = [];
  for (const message of entry.messages) {
    for (const block of message.content as CanonicalContentBlock[]) {
      if (block.type === "text" && block.text.trim()) {
        chunks.push(block.text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function hasUnsupportedPrefillContent(entry: AgentAcceptedInputTranscriptEntry): boolean {
  return entry.messages.some((message) =>
    (message.content as CanonicalContentBlock[]).some((block) => block.type !== "text"),
  );
}

function getForkMode(entry: AgentAcceptedInputTranscriptEntry): WebGatewayMode | undefined {
  return entry.metadata?.permissionMode === "plan" ? "plan" : undefined;
}

function getForkRunMode(entry: AgentAcceptedInputTranscriptEntry): WebAgentRunMode | undefined {
  return parseAgentRunMode(entry.metadata?.runMode);
}

function buildForkTitle(
  prefillText: string,
  carriedMessageCount: number,
  inheritedTitle: string | undefined,
): string {
  const normalized = prefillText.replace(/\s+/g, " ").trim();
  if (normalized) {
    const max = 48;
    const snippet = normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized;
    // A leading branch glyph keeps forks scannable even when titles collide.
    return `⑂ ${snippet}`;
  }
  if (inheritedTitle) {
    return `⑂ ${inheritedTitle}`;
  }
  return carriedMessageCount > 0 ? "⑂ Forked session" : "⑂ New branch";
}

type ForkPoint = {
  target: AgentTranscriptEntry;
  acceptedInput: AgentAcceptedInputTranscriptEntry;
  preserveTarget: boolean;
};

function findForkPoint(
  entries: AgentTranscriptEntry[],
  fromEntryId: string,
): ForkPoint {
  const target = entries.find((entry) => entry.entryId === fromEntryId);
  if (!target) {
    throw new ForkSessionError("fork_entry_not_found", `Transcript entry not found: ${fromEntryId}`);
  }

  if (target.type === "accepted_input") {
    return {
      target,
      acceptedInput: target,
      preserveTarget: false,
    };
  }

  const accepted = entries.find(
    (entry): entry is AgentAcceptedInputTranscriptEntry =>
      entry.type === "accepted_input" && entry.turnId === target.turnId,
  );
  if (!accepted) {
    throw new ForkSessionError(
      "fork_turn_not_found",
      `No accepted_input found for turn ${target.turnId}`,
    );
  }
  return {
    target,
    acceptedInput: accepted,
    preserveTarget: true,
  };
}

function lastSessionMetadata(entries: AgentTranscriptEntry[]): Record<string, unknown> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "session_metadata") {
      return entry.metadata as Record<string, unknown>;
    }
  }
  return undefined;
}

function countCarriedUserAssistantMessages(entries: AgentTranscriptEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    switch (entry.type) {
      case "accepted_input":
        count += entry.messages.length;
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        count += 1;
        break;
      default:
        break;
    }
  }
  return count;
}

function shouldPreserveSourceEntry(entry: AgentTranscriptEntry, forkPoint: ForkPoint): boolean {
  if (!forkPoint.preserveTarget) {
    return entry.sequence < forkPoint.acceptedInput.sequence;
  }
  if (entry.sequence <= forkPoint.target.sequence) {
    return true;
  }
  // Assistant-message forks preserve the selected response as conversation
  // context. Keep the completion marker so replay does not drop that turn as
  // incomplete, without pulling in later durable messages from the same turn.
  return (
    entry.turnId === forkPoint.target.turnId &&
    (entry.type === "turn_result" || entry.type === "file_artifacts")
  );
}

function markMessageAsForkCarryover(
  message: CanonicalMessage,
  sourceSessionId: string,
  sourceTurnId: string,
): CanonicalMessage {
  return {
    ...message,
    metadata: {
      ...message.metadata,
      forkCarryover: {
        sourceSessionId,
        sourceTurnId,
      },
    },
  };
}

function markTranscriptEntryAsForkCarryover(
  entry: AgentTranscriptEntry,
  sourceSessionId: string,
): AgentTranscriptEntry {
  if (entry.type === "accepted_input") {
    return {
      ...entry,
      messages: entry.messages.map((message) =>
        markMessageAsForkCarryover(message, sourceSessionId, entry.turnId),
      ),
    };
  }
  if (
    entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message"
  ) {
    return {
      ...entry,
      message: markMessageAsForkCarryover(entry.message, sourceSessionId, entry.turnId),
    };
  }
  return entry;
}

function retargetEntriesToSession(
  entries: AgentTranscriptEntry[],
  options: {
    sessionId: string;
  },
): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type === "accepted_input") {
      return markTranscriptEntryAsForkCarryover({ ...entry, sessionId: options.sessionId }, entry.sessionId);
    }
    if (
      entry.type === "assistant_message" ||
      entry.type === "tool_result_message" ||
      entry.type === "durable_message"
    ) {
      const retargeted = { ...entry, sessionId: options.sessionId };
      return markTranscriptEntryAsForkCarryover(retargeted, entry.sessionId);
    }
    return {
      ...entry,
      sessionId: options.sessionId,
    };
  });
}

export class ForkSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ForkSessionError";
  }
}

export async function forkWebSession(
  input: WebForkSessionInput,
  options: ForkWebSessionOptions,
): Promise<WebForkSessionResult> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const { entries } = await readAgentProjectSessionPersistence({
    projectRoot: effectiveProjectRoot,
    pilotHome: options.pilotHome,
    sessionId: input.sessionKey,
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
  });
  if (entries.length === 0) {
    throw new ForkSessionError("fork_empty_transcript", "Cannot fork an empty session transcript.");
  }

  const forkPoint = findForkPoint(entries, input.fromEntryId);
  const forkAcceptedInput = forkPoint.acceptedInput;
  if (!forkPoint.preserveTarget && hasUnsupportedPrefillContent(forkAcceptedInput)) {
    throw new ForkSessionError(
      "fork_unsupported_content",
      "Forking messages with attachments or non-text input is not supported yet.",
    );
  }
  const forkMode = getForkMode(forkAcceptedInput);
  const forkRunMode = getForkRunMode(forkAcceptedInput);
  const preservedSourceEntries = entries.filter((entry) => shouldPreserveSourceEntry(entry, forkPoint));
  const forkInputText = extractAcceptedInputText(forkAcceptedInput);
  const prefillText = forkPoint.preserveTarget ? "" : forkInputText;
  const carriedMessageCount = countCarriedUserAssistantMessages(preservedSourceEntries);

  const newSessionKey = newWebSessionKey();
  const preserved = retargetEntriesToSession(preservedSourceEntries, {
    sessionId: newSessionKey,
  });
  const lastPreserved = preserved[preserved.length - 1];
  const lastEntryId = lastPreserved?.entryId ?? null;
  const maxSequence = preserved.reduce((max, entry) => Math.max(max, entry.sequence), 0);

  const parentMetadata = lastSessionMetadata(entries);
  const inheritedTitle =
    (typeof parentMetadata?.title === "string" && parentMetadata.title) ||
    (typeof parentMetadata?.aiTitle === "string" && parentMetadata.aiTitle) ||
    undefined;

  // Title the fork by the message it branches from so siblings are
  // distinguishable in the lineage tree (the branch icon + "forked from"
  // subtitle already convey that it is a fork).
  const forkTitle = buildForkTitle(forkInputText || prefillText, carriedMessageCount, inheritedTitle);

  const now = options.now ?? (() => new Date());
  const metadataEntry: AgentSessionMetadataTranscriptEntry = {
    type: "session_metadata",
    sessionId: newSessionKey,
    turnId: `fork-${randomUUID()}`,
    sequence: maxSequence + 1,
    createdAt: now().toISOString(),
    entryId: randomUUID(),
    parentEntryId: lastEntryId,
    metadata: {
      parentSessionId: input.sessionKey,
      forkedFromTurnId: forkAcceptedInput.turnId,
      title: forkTitle,
      firstPrompt: forkInputText || prefillText || undefined,
      updatedAt: now().toISOString(),
    },
  };

  const sessionForkPort = options.sessionForkPort ?? createProjectSessionForkPort({
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
  });
  await sessionForkPort.fork({
    projectRoot: effectiveProjectRoot,
    pilotHome: options.pilotHome,
    sourceSessionId: input.sessionKey,
    targetSessionId: newSessionKey,
    entries: [...preserved, metadataEntry],
  });

  return {
    newSessionKey,
    prefillText,
    carriedMessageCount,
    ...(forkRunMode ? { runMode: forkRunMode } : {}),
    ...(forkMode ? { mode: forkMode } : {}),
  };
}
