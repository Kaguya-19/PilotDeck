import { createAgentSessionStateFromReplay, type AgentSession } from "../../agent/session/AgentSession.js";
import {
  createAgentSessionWithStorageAsync,
  type CreateAgentSessionOptions,
} from "../../agent/session/createAgentSession.js";
import type { AgentHandle } from "../../agent/scope/AgentHandle.js";
import type { AgentRuntimeDependencies } from "../../agent/runtime/AgentRuntimeDependencies.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import { SessionMetadataStore } from "../metadata/SessionMetadataStore.js";
import {
  createAgentProjectSessionStorage,
  readAgentProjectSessionTranscript,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../storage/ProjectSessionStorage.js";
import { replayTranscriptEntries } from "../transcript/TranscriptReplay.js";

/**
 * Optional hook fired once the per-session `storage` has been created. Lets
 * the caller (e.g. `createLocalGateway`) attach per-session runtime pieces
 * that depend on session-scoped paths or the JSONL transcript writer
 * (ToolResultBudget, FileHistoryStore, sidechain hooks, etc.).
 *
 * The returned object is shallow-merged into `options.dependencies`, with
 * the sub-fields of `tools` and `context` handled specially:
 *   - `context` overrides the runtime entirely (caller passes the upgraded
 *     `DefaultContextRuntime` with the freshly-created `toolResultBudget`).
 *   - `fileHistory` / `subagentTranscript` are forwarded as-is.
 *   - `elicitation` and `ownedElicitation` travel together so the resumed
 *     session scope retains the same disposal owner as a newly created one.
 */
export type ResumeSessionDependencyExtension = (
  storage: AgentProjectSessionStorage,
  entries: readonly AgentTranscriptEntry[],
) => Partial<Pick<
  AgentRuntimeDependencies,
  "context" | "promptContributions" | "fileHistory" | "fileUpdateNotifier" | "subagentTranscript" | "elicitation" | "ownedElicitation" | "userDialog" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager" | "goalManager" | "subagentComposition"
>> | Promise<Partial<Pick<
  AgentRuntimeDependencies,
  "context" | "promptContributions" | "fileHistory" | "fileUpdateNotifier" | "subagentTranscript" | "elicitation" | "ownedElicitation" | "userDialog" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager" | "goalManager" | "subagentComposition"
>>>;

export type ResumeAgentSessionOptions = Omit<CreateAgentSessionOptions, "transcript" | "projectStorage" | "storage"> & {
  /** Gateway-resolved storage takes precedence over the historical layout. */
  storage?: AgentProjectSessionStorage;
  projectStorage?: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  /** @see `ResumeSessionDependencyExtension`. */
  extendDependencies?: ResumeSessionDependencyExtension;
  /** @internal Allows lifecycle tests to inject a failing restore backend. */
  __storageFactory?: typeof createAgentProjectSessionStorage;
};

export type ResumeAgentSessionResult = {
  session: AgentSession;
  handle: AgentHandle;
  transcriptPath: string;
  diagnostics: ReturnType<typeof replayTranscriptEntries>["diagnostics"];
  metadata: SessionMetadataValue;
};

export async function resumeAgentSession(options: ResumeAgentSessionOptions): Promise<ResumeAgentSessionResult> {
  const storage = options.storage ?? (options.__storageFactory ?? createAgentProjectSessionStorage)({
    ...requireProjectStorage(options.projectStorage),
    sessionId: options.sessionId,
    now: options.dependencies.now,
  });
  let handle: AgentHandle | undefined;
  try {
    const readResult = await storage.restore();

    const replay = replayTranscriptEntries(readResult.entries);

    const extension = await Promise.resolve(options.extendDependencies?.(storage, readResult.entries) ?? {});
    const dependencies: typeof options.dependencies = {
      ...options.dependencies,
      ...(extension.context ? { context: extension.context } : {}),
      ...(extension.promptContributions ? { promptContributions: extension.promptContributions } : {}),
      ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
      ...(extension.fileUpdateNotifier ? { fileUpdateNotifier: extension.fileUpdateNotifier } : {}),
      ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
      ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
      ...(extension.ownedElicitation !== undefined ? { ownedElicitation: extension.ownedElicitation } : {}),
      ...(extension.userDialog ? { userDialog: extension.userDialog } : {}),
      ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
      ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
      ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
      ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
      ...(extension.goalManager ? { goalManager: extension.goalManager } : {}),
      ...(extension.subagentComposition ? { subagentComposition: extension.subagentComposition } : {}),
    };

    const created = await createAgentSessionWithStorageAsync({
      ...options,
      dependencies,
      storage,
      transcript: storage.transcript,
      initialState: createAgentSessionStateFromReplay(options.sessionId, replay),
      replayEvents: replay.events,
      initialMetadata: replay.metadata,
      restoredEntries: readResult.entries,
    });
    handle = created.handle;

    // Restore metadata into a SessionMetadataStore so downstream code
    // (adapter / listing) sees the latest state without rescanning.
    const metadataStore = new SessionMetadataStore({
      transcript: storage.transcript,
      sessionId: options.sessionId,
      now: options.dependencies.now,
    });
    metadataStore.restoreFromReplay(replay.metadata);

    return {
      session: created.session,
      handle: created.handle,
      transcriptPath: storage.transcriptPath,
      diagnostics: [...readResult.diagnostics, ...replay.diagnostics],
      metadata: metadataStore.getSnapshot(),
    };
  } catch (error) {
    try {
      if (handle) {
        await handle.dispose("agent_resume_rollback");
      } else {
        await storage.dispose();
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to resume and roll back agent session ${options.sessionId}.`,
      );
    }
    throw error;
  }
}

function requireProjectStorage(
  storage: ResumeAgentSessionOptions["projectStorage"],
): Omit<AgentProjectSessionStorageOptions, "sessionId" | "now"> {
  if (!storage) {
    throw new Error("resumeAgentSession requires storage or projectStorage.");
  }
  return storage;
}
