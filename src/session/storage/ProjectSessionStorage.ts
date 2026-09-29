import { resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { SessionRuntime } from "../events/SessionRuntime.js";
import { attachSessionPersistence } from "../persistence/SessionPersistenceBinding.js";
import type { SessionPersistence, SessionPersistenceReadResult } from "../persistence/SessionPersistence.js";
import type { SessionCommittedEventSubscription } from "../events/SessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../projection/SessionProjectionDriver.js";
import type { SessionProjectionRegistry } from "../projection/SessionProjectionRegistry.js";
import {
  checkpointMatchesLog,
  SessionProjectionCheckpointBinding,
  type SessionProjectionCheckpointStore,
} from "../projection/checkpoint/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";
import type {
  AgentSubagentCompletedTranscriptEntry,
  AgentSubagentStartedTranscriptEntry,
  AgentTranscriptEntry,
} from "../transcript/TranscriptEntry.js";
import {
  readTranscript as readTranscriptFile,
  type AgentTranscriptReadResult,
  type ReadTranscriptOptions,
} from "../transcript/TranscriptReader.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "../transcript/TranscriptWriter.js";
import type { FileHistoryBackupStorage } from "../filesystem/types.js";
import type { ToolResultArtifactStorage } from "../artifacts/ToolResultArtifactStorage.js";
import {
  nodeProjectSessionStorageProvider,
  type ProjectSessionStorageKind,
  type ProjectSessionStorageProvider,
} from "./ProjectSessionStorageProvider.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  now?: () => Date;
  /** Application-selected backend provider; Node JSONL remains the native default. */
  storageProvider?: ProjectSessionStorageProvider;
};

export type SubagentProjectSessionStorageOptions = AgentProjectSessionStorageOptions & {
  parentSessionId: string;
  /**
   * Native artifact name for a child whose durable session identity is not a
   * filesystem-safe or backwards-compatible sidechain name.
   *
   * Providers always receive `sessionId`; this value only selects the native
   * transcript layout beneath the exact parent session.
   */
  sidechainId?: string;
};

export type ProjectSessionSidechainStorageInput = {
  /** Durable child identity passed to the selected storage provider. */
  sessionId: string;
  /** Native sidechain artifact identity retained for JSONL compatibility. */
  subagentId: string;
  now?: () => Date;
};

type AsyncTranscriptMethod<T> = T extends (...args: infer Args) => unknown
  ? (...args: Args) => Promise<void>
  : never;

/**
 * Native session transcript contract. JSONL is the default implementation,
 * while Gateway hosts may provide an equivalent durable writer backed by an
 * asynchronous database or object store.
 */
export type AgentProjectTranscriptWriter = Omit<AgentTranscriptWriter,
  | "recordAcceptedInput"
  | "recordDurableMessage"
  | "recordAgentStatusMessage"
  | "recordFileArtifacts"
  | "recordTurnResult"
  | "recordSessionMetadata"
  | "recordFileSnapshot"
  | "recordControlBoundary"
> & {
  recordAcceptedInput: AsyncTranscriptMethod<AgentTranscriptWriter["recordAcceptedInput"]>;
  recordDurableMessage: AsyncTranscriptMethod<AgentTranscriptWriter["recordDurableMessage"]>;
  recordAgentStatusMessage: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordAgentStatusMessage"]>>;
  recordFileArtifacts: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordFileArtifacts"]>>;
  recordTurnResult: AsyncTranscriptMethod<AgentTranscriptWriter["recordTurnResult"]>;
  recordSessionMetadata: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordSessionMetadata"]>>;
  recordFileSnapshot: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordFileSnapshot"]>>;
  recordControlBoundary: AsyncTranscriptMethod<NonNullable<AgentTranscriptWriter["recordControlBoundary"]>>;
  restoreState(maxSequence: number, lastEntryId: string | null): void;
  forSubagent(subagentId: string, now?: () => Date): AgentProjectSubagentTranscriptHandle;
  relativeSubagentPath(subagentId: string): string;
  recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: Omit<AgentSubagentStartedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId" | "promptPreview" | "promptTruncated"> & { prompt: string },
  ): Promise<void>;
  recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: Omit<AgentSubagentCompletedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId" | "summaryPreview" | "summaryTruncated"> & { summary: string },
  ): Promise<void>;
  snapshotState(): AgentTranscriptWriterState;
};

export type AgentProjectSubagentTranscriptHandle = {
  subagentId: string;
  writer: AgentProjectTranscriptWriter;
  transcriptPath: string;
};

export type AgentProjectTranscriptReader = (
  options?: ReadTranscriptOptions,
) => Promise<AgentTranscriptReadResult>;

export type AgentProjectTranscriptPathReader = (
  transcriptPath: string,
  options?: ReadTranscriptOptions,
) => Promise<AgentTranscriptReadResult>;

export type AgentProjectTranscriptReplacement = Readonly<{
  transactionId: string;
  replacementTurnId: string;
  entries: readonly AgentTranscriptEntry[];
  owner?: Readonly<{ instanceId: string; pid: number }>;
}>;

/**
 * Copies the sidechain transcript payloads referenced by a parent transcript
 * during a session fork. The caller supplies the exact source primary entries
 * and an auxiliary-path transform so storage backends do not need to own the
 * Web fork policy.
 */
export type AgentProjectTranscriptSidechainFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
  transformEntry: (entry: AgentTranscriptEntry) => AgentTranscriptEntry;
}>;

/** Copies the file-history backup blobs referenced by a parent transcript fork. */
export type AgentProjectFileHistoryFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
}>;

/** Copies the oversized tool-result payloads referenced by a transcript fork. */
export type AgentProjectToolResultArtifactFork = Readonly<{
  sourceStorage: AgentProjectSessionStorage;
  sourceTranscriptEntries: readonly AgentTranscriptEntry[];
}>;

export type AgentProjectSessionStorage = {
  chatDir: string;
  transcriptPath: string;
  projectionCheckpointPath: string;
  toolResultsDir: string;
  /** Optional host-owned payload store for oversized tool results and media. */
  toolResultArtifactStorage?: ToolResultArtifactStorage;
  /** Optional host-owned cleanup of every oversized tool-result payload for this session. */
  deleteToolResultArtifacts?: () => Promise<void>;
  /**
   * Per-session directory for file-history backups (C4 / F5). Backups land
   * at `<fileHistoryDir>/<sha16(filePath)>@v<version>` and survive process
   * restarts. The `FileHistoryStore` lazily creates the dir on first
   * `trackEdit`.
   */
  fileHistoryDir: string;
  /** Optional host-owned backup blobs used by the native FileHistoryStore. */
  fileHistoryBackupStorage?: FileHistoryBackupStorage;
  /** Optional host-owned cleanup of every backup blob for this session. */
  deleteFileHistoryBackups?: () => Promise<void>;
  /**
   * Per-session directory for subagent sidechain transcripts (C3 §6.3).
   * Each forked subagent gets its own `<subagentId>.jsonl` here.
   */
  subagentsDir: string;
  subagentTranscriptPath(subagentId: string): string;
  persistence: SessionPersistence;
  persistenceBinding: SessionCommittedEventSubscription;
  events: SessionRuntime;
  projectionRegistry: SessionProjectionRegistry;
  projections: SessionProjectionDriver;
  projectionCheckpointStore: SessionProjectionCheckpointStore;
  projectionCheckpointBinding: SessionProjectionCheckpointBinding;
  transcript: JsonlTranscriptWriter;
  /** @deprecated Use persistence.load(). */
  readTranscript?: AgentProjectTranscriptReader;
  /** @deprecated Use a provider-created sidechain persistence backend. */
  readTranscriptAtPath?: AgentProjectTranscriptPathReader;
  /** @deprecated Compatibility capability for external transcript stores. */
  transcriptExists?: () => Promise<boolean>;
  /** @deprecated Compatibility capability for external transcript stores. */
  deleteTranscript?: () => Promise<void>;
  /** @deprecated Compatibility capability for deleting a primary transcript and sidechains. */
  deleteSessionTranscripts?: () => Promise<void>;
  /** @deprecated Compatibility capability for atomic transcript replacement. */
  replaceTranscript?: (entries: readonly AgentTranscriptEntry[]) => Promise<void>;
  /** @deprecated Compatibility capability for transactional replacement. */
  prepareTranscriptReplacement?: (replacement: AgentProjectTranscriptReplacement) => Promise<void>;
  /** @deprecated Compatibility capability for transactional replacement. */
  finalizeTranscriptReplacement?: (input: { transactionId: string; action: "commit" | "rollback" }) => Promise<void>;
  /** @deprecated Compatibility capability for replacement recovery. */
  recoverTranscriptReplacements?: () => Promise<void>;
  /** @deprecated Compatibility capability for sidechain fork copies. */
  copyTranscriptSidechains?: (input: AgentProjectTranscriptSidechainFork) => Promise<void>;
  /** @deprecated Compatibility capability for file-history fork copies. */
  copyFileHistoryBackups?: (input: AgentProjectFileHistoryFork) => Promise<void>;
  /** @deprecated Compatibility capability for tool-result fork copies. */
  copyToolResultArtifacts?: (input: AgentProjectToolResultArtifactFork) => Promise<void>;
  /** @deprecated True when transcript bytes are not available at transcriptPath. */
  externalTranscriptStore?: boolean;
  /**
   * Creates an independently sequenced one-shot child storage from this
   * storage's selected backend. The parent remains the composition owner;
   * callers own disposal of the returned child storage.
   */
  createSidechainStorage(input: ProjectSessionSidechainStorageInput): AgentProjectSessionStorage;
  restore(): Promise<SessionPersistenceReadResult>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Sanitize a sessionId for safe use as a single filename component.
 *
 * sessionKeys for non-Web channels (TUI/CLI) embed the absolute project path,
 * e.g. `tui:project=/Users/foo/work/repo:default`. Without sanitization the
 * raw `/` characters make `path.resolve()` treat the sessionId as multiple
 * path segments, burying the transcript under
 * `chats/tui:project=/Users/foo/work/repo:default.jsonl` (a deep dir tree)
 * instead of a flat file. `listProjectSessions` then can't find these
 * sessions in its flat `chats/` scan.
 *
 * We replace **only** path-separator characters (`/` and `\`) so existing
 * keys like `web:s_<uuid>` (which legitimately use `:`) keep their
 * on-disk filenames unchanged and stay backward compatible.
 */
export function sanitizeSessionIdForPath(sessionId: string): string {
  // On Windows, `:` is reserved (drive letters / ADS) and cannot appear in
  // filenames.  Strip it alongside path separators so that TUI-style session
  // keys like `tui:project=/Users/foo:default` produce a single flat file.
  const illegal = process.platform === "win32" ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
  return sessionId.replace(illegal, "-").replace(/^-+|-+$/g, "") || "session";
}

/** Reads a native session transcript through its configured host backend. */
export async function readAgentProjectSessionTranscript(
  storage: AgentProjectSessionStorage,
  options: ReadTranscriptOptions = {},
): Promise<AgentTranscriptReadResult> {
  await storage.recoverTranscriptReplacements?.();
  return storage.readTranscript?.(options) ?? readTranscriptFile(storage.transcriptPath, options);
}

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  return createProjectSessionStorage(options, agentSessionStoragePaths(options), "agent");
}

/**
 * Read the selected durable backend without constructing a second session
 * runtime. Read-only consumers such as Web history must use this instead of
 * assuming that the storage provider has a JSONL artifact on disk.
 */
export function readAgentProjectSessionPersistence(
  options: AgentProjectSessionStorageOptions,
): Promise<SessionPersistenceReadResult> {
  return selectProjectSessionStorageBackends(
    options,
    agentSessionStoragePaths(options),
    "agent",
  ).persistence.load();
}

/** Durable child storage owned by one exact parent session. */
export function createSubagentProjectSessionStorage(
  options: SubagentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  return createProjectSessionStorage(
    options,
    subagentSessionStoragePaths(options),
    "subagent",
    options.parentSessionId,
  );
}

/** Read a continuable child backend without constructing session resources. */
export function readSubagentProjectSessionPersistence(
  options: SubagentProjectSessionStorageOptions,
): Promise<SessionPersistenceReadResult> {
  return selectProjectSessionStorageBackends(
    options,
    subagentSessionStoragePaths(options),
    "subagent",
    options.parentSessionId,
  ).persistence.load();
}

type ProjectSessionStoragePaths = {
  chatDir: string;
  transcriptPath: string;
  toolResultsDir: string;
  fileHistoryDir: string;
  subagentsDir: string;
};

function createProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
  paths: ProjectSessionStoragePaths,
  kind: ProjectSessionStorageKind,
  parentSessionId?: string,
): AgentProjectSessionStorage {
  const { chatDir, transcriptPath, toolResultsDir, fileHistoryDir, subagentsDir } = paths;
  const {
    projectionCheckpointPath,
    persistence,
    projectionCheckpointStore,
  } = selectProjectSessionStorageBackends(options, paths, kind, parentSessionId);
  const subagentTranscriptPath = (subagentId: string): string =>
    resolve(subagentsDir, `${sanitizeSessionIdForPath(subagentId)}.jsonl`);
  const events = new SessionRuntime({
    now: options.now,
  });
  const persistenceBinding = attachSessionPersistence(events, persistence);
  const projectionRegistry = createDefaultSessionProjectionRegistry();
  const projections = new SessionProjectionDriver({ runtime: events, registry: projectionRegistry });
  const projectionCheckpointBinding = new SessionProjectionCheckpointBinding({
    sessionId: options.sessionId,
    runtime: events,
    projections,
    store: projectionCheckpointStore,
  });
  let disposePromise: Promise<void> | undefined;

  const restore = async (): Promise<SessionPersistenceReadResult> => {
    const readResult = await persistence.load();
    events.restore(readResult.entries);
    const checkpoint = await projectionCheckpointStore.load(options.sessionId);
    projections.hydrate(
      readResult.entries,
      checkpoint && checkpointMatchesLog(checkpoint, readResult.entries)
        ? checkpoint.projections
        : {},
    );
    return readResult;
  };
  const flush = async (): Promise<void> => {
    await events.flush();
    await projectionCheckpointBinding.flush();
  };
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      try {
        await flush();
      } finally {
        await projectionCheckpointBinding.dispose();
        projections.dispose();
        persistenceBinding.dispose();
      }
    })();
    return disposePromise;
  };
  return {
    chatDir,
    transcriptPath,
    projectionCheckpointPath,
    toolResultsDir,
    fileHistoryDir,
    subagentsDir,
    subagentTranscriptPath,
    persistence,
    persistenceBinding,
    events,
    projectionRegistry,
    projections,
    projectionCheckpointStore,
    projectionCheckpointBinding,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
      subagentTranscriptPath,
      eventStore: events,
    }),
    readTranscript: (readOptions) => readTranscriptFile(transcriptPath, readOptions),
    readTranscriptAtPath: (path, readOptions) => readTranscriptFile(path, readOptions),
    createSidechainStorage: (input) => createSubagentProjectSessionStorage({
      ...options,
      sessionId: input.sessionId,
      parentSessionId: options.sessionId,
      sidechainId: input.subagentId,
      now: input.now ?? options.now,
    }),
    restore,
    flush,
    dispose,
  };
}

function agentSessionStoragePaths(
  options: AgentProjectSessionStorageOptions,
): ProjectSessionStoragePaths {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(options.sessionId);
  return {
    chatDir,
    transcriptPath: resolve(chatDir, `${safeId}.jsonl`),
    // Keep large tool-result bodies inside the workspace so the agent can read
    // them back with read_file when the inline preview is insufficient. The
    // project-local .pilotdeck directory is gitignored and already within the
    // workspace path boundary enforced by read_file.
    toolResultsDir: resolve(options.projectRoot, ".pilotdeck", "tool-results", safeId),
    fileHistoryDir: resolve(chatDir, safeId, "file-history"),
    subagentsDir: resolve(chatDir, safeId, "subagents"),
  };
}

function subagentSessionStoragePaths(
  options: SubagentProjectSessionStorageOptions,
): ProjectSessionStoragePaths {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const safeParentId = sanitizeSessionIdForPath(options.parentSessionId);
  const safeChildId = sanitizeSessionIdForPath(options.sidechainId ?? options.sessionId);
  const parentSubagentsDir = resolve(chatDir, safeParentId, "subagents");
  return {
    chatDir,
    transcriptPath: resolve(parentSubagentsDir, `${safeChildId}.jsonl`),
    toolResultsDir: resolve(
      options.projectRoot,
      ".pilotdeck",
      "tool-results",
      safeParentId,
      "subagents",
      safeChildId,
    ),
    fileHistoryDir: resolve(parentSubagentsDir, safeChildId, "file-history"),
    subagentsDir: resolve(parentSubagentsDir, safeChildId, "subagents"),
  };
}

function selectProjectSessionStorageBackends(
  options: AgentProjectSessionStorageOptions,
  paths: ProjectSessionStoragePaths,
  kind: ProjectSessionStorageKind,
  parentSessionId?: string,
): ProjectSessionStorageBackendsSelection {
  const projectionCheckpointPath = `${paths.transcriptPath}.projections.json`;
  const { persistence, projectionCheckpointStore } = (
    options.storageProvider ?? nodeProjectSessionStorageProvider
  ).create({
    kind,
    sessionId: options.sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    transcriptPath: paths.transcriptPath,
    projectionCheckpointPath,
  });
  return { projectionCheckpointPath, persistence, projectionCheckpointStore };
}

type ProjectSessionStorageBackendsSelection = {
  projectionCheckpointPath: string;
  persistence: SessionPersistence;
  projectionCheckpointStore: SessionProjectionCheckpointStore;
};
