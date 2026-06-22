import { randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTranscriptEntry, SessionMetadataValue } from "../transcript/TranscriptEntry.js";
import { createAgentProjectSessionStorage } from "../storage/ProjectSessionStorage.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../transcript/TranscriptReplay.js";

export type ForkAgentSessionOptions = {
  projectRoot: string;
  pilotHome: string;
  sourceSessionKey: string;
  targetSessionKey: string;
  title?: string;
  now?: () => Date;
};

export type ForkAgentSessionResult = {
  sourceSessionKey: string;
  sessionKey: string;
  transcriptPath: string;
};

export class ForkAgentSessionError extends Error {
  constructor(
    public readonly code: "source_session_not_forkable" | "target_session_exists",
    message: string,
  ) {
    super(message);
    this.name = "ForkAgentSessionError";
  }
}

export async function forkAgentSession(
  options: ForkAgentSessionOptions,
): Promise<ForkAgentSessionResult> {
  const now = options.now ?? (() => new Date());
  const source = createAgentProjectSessionStorage({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
    sessionId: options.sourceSessionKey,
    now,
  });
  const target = createAgentProjectSessionStorage({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
    sessionId: options.targetSessionKey,
    now,
  });

  const readResult = await readTranscript(source.transcriptPath);
  const lastCompleteIndex = findLastCompleteTurnIndex(readResult.entries);
  if (lastCompleteIndex === -1) {
    throw new ForkAgentSessionError(
      "source_session_not_forkable",
      `Session ${options.sourceSessionKey} has no completed turn to fork.`,
    );
  }

  const copied = readResult.entries
    .slice(0, lastCompleteIndex + 1)
    .map((entry) => rewriteSessionId(entry, options.targetSessionKey));
  const replay = replayTranscriptEntries(readResult.entries);
  const title = options.title?.trim() || defaultForkTitle(replay.metadata);
  const timestamp = now().toISOString();
  const sourceTurnId = readResult.entries[lastCompleteIndex]?.turnId;

  const maxSequence = copied.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const entries: AgentTranscriptEntry[] = [
    ...copied,
    {
      type: "control_boundary",
      sessionId: options.targetSessionKey,
      turnId: "session-fork",
      sequence: maxSequence + 1,
      createdAt: timestamp,
      entryId: randomUUID(),
      parentEntryId: copied[copied.length - 1]?.entryId ?? null,
      boundary: {
        kind: "manual",
        metadata: {
          action: "session_fork",
          sourceSessionKey: options.sourceSessionKey,
          ...(sourceTurnId ? { sourceTurnId } : {}),
        },
      },
    },
    {
      type: "session_metadata",
      sessionId: options.targetSessionKey,
      turnId: "session-fork",
      sequence: maxSequence + 2,
      createdAt: timestamp,
      entryId: randomUUID(),
      parentEntryId: null,
      metadata: {
        title,
        updatedAt: timestamp,
      },
    },
  ];
  const metadataEntry = entries[entries.length - 1];
  const boundaryEntry = entries[entries.length - 2];
  metadataEntry.parentEntryId = boundaryEntry.entryId ?? null;

  await writeTranscriptAtomically(target.transcriptPath, entries);
  return {
    sourceSessionKey: options.sourceSessionKey,
    sessionKey: options.targetSessionKey,
    transcriptPath: target.transcriptPath,
  };
}

function findLastCompleteTurnIndex(entries: AgentTranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "turn_result") {
      return index;
    }
  }
  return -1;
}

function rewriteSessionId(entry: AgentTranscriptEntry, sessionId: string): AgentTranscriptEntry {
  const copy = cloneEntry(entry);
  copy.sessionId = sessionId;
  if (copy.type === "turn_result") {
    copy.result.sessionId = sessionId;
  }
  return copy;
}

function cloneEntry(entry: AgentTranscriptEntry): AgentTranscriptEntry {
  return JSON.parse(JSON.stringify(entry)) as AgentTranscriptEntry;
}

function defaultForkTitle(metadata: SessionMetadataValue): string {
  const sourceTitle = metadata.title ?? metadata.aiTitle ?? metadata.firstPrompt ?? metadata.lastPrompt;
  if (!sourceTitle?.trim()) {
    return "Forked session";
  }
  return `Fork: ${sourceTitle.trim()}`;
}

async function writeTranscriptAtomically(path: string, entries: AgentTranscriptEntry[]): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await access(path)
      .then(() => {
        throw new ForkAgentSessionError("target_session_exists", `Target session already exists: ${path}`);
      })
      .catch((error) => {
        if (isNotFoundError(error)) return;
        throw error;
      });
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmpPath, path);
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new ForkAgentSessionError("target_session_exists", `Target session already exists: ${path}`);
    }
    throw error;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
