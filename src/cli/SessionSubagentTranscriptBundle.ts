import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { recordSubagentAcceptedInputWithDescriptor } from "../agent/sub/SubagentDescriptorPersistence.js";
import type { AgentProjectSessionStorage } from "../session/storage/ProjectSessionStorage.js";
import { dirname, relative } from "node:path";

type SubagentStartedArgs = Omit<
  Parameters<NonNullable<AgentSubagentTranscriptHooks["recordSubagentStarted"]>>[0],
  "sessionId" | "turnId"
>;
type SubagentCompletedArgs = Omit<
  Parameters<NonNullable<AgentSubagentTranscriptHooks["recordSubagentCompleted"]>>[0],
  "sessionId" | "turnId"
>;

export type SessionSubagentTranscriptBundleOptions = {
  /** Parent durable storage selects and owns the child backend factory. */
  storage: AgentProjectSessionStorage;
  now: () => Date;
};

/**
 * Composes AgentLoop's subagent transcript hooks over the existing parent
 * transcript and its selected-storage sidechain factory. It creates no child
 * lifecycle or durable-state owner of its own. The one-shot port owns child
 * teardown; sidechain disposal is idempotent so a provider cannot physically
 * release the selected backend twice.
 */
export class SessionSubagentTranscriptBundle {
  constructor(private readonly options: SessionSubagentTranscriptBundleOptions) {}

  compose(): AgentSubagentTranscriptHooks {
    const sidechains = new Map<string, ReturnType<typeof createSidechainWriter>>();
    const resolveSidechain = (subagentId: string, sessionId?: string) => {
      let sidechain = sidechains.get(subagentId);
      if (!sidechain) {
        sidechain = createSidechainWriter(
          this.options.storage,
          subagentId,
          sessionId ?? subagentId,
          this.options.now,
          () => {
            if (sidechains.get(subagentId) === sidechain) sidechains.delete(subagentId);
          },
        );
        sidechains.set(subagentId, sidechain);
      }
      return sidechain;
    };
    return {
      recordSubagentStarted: async (args) => {
        await this.options.storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
          subagentId: args.subagentId,
          subagentType: args.subagentType,
          prompt: args.prompt,
          transcriptRelativePath: args.transcriptRelativePath,
          ...(args.subagentSessionId ? { subagentSessionId: args.subagentSessionId } : {}),
        });
      },
      recordSubagentCompleted: async (args) => {
        await this.options.storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
          subagentId: args.subagentId,
          subagentType: args.subagentType,
          summary: args.summary,
          ...(args.usage ? { usage: args.usage } : {}),
          turns: args.turns,
          durationMs: args.durationMs,
          ...(args.errored !== undefined ? { errored: args.errored } : {}),
        });
      },
      subagentTranscriptResolver: resolveSidechain,
    };
  }
}

function createSidechainWriter(
  storage: AgentProjectSessionStorage,
  subagentId: string,
  sessionId: string,
  now: () => Date,
  onDispose: () => void,
) {
  const childStorage = storage.createSidechainStorage({
    sessionId,
    subagentId,
    now,
  });
  const writer = childStorage.transcript;
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      try {
        await childStorage.dispose();
      } finally {
        onDispose();
      }
    })();
    return disposePromise;
  };
  return {
    recordSessionEvent: writer.recordSessionEvent.bind(writer),
    recordAcceptedInput: async (sessionId: string, turnId: string, messages: import("../model/index.js").CanonicalMessage[], metadata?: Record<string, unknown>) => {
      await recordSubagentAcceptedInputWithDescriptor(
        writer,
        sessionId,
        turnId,
        messages,
        metadata,
      );
    },
    recordDurableMessage: async (sessionId: string, turnId: string, message: import("../model/index.js").CanonicalMessage) => {
      await writer.recordDurableMessage(sessionId, turnId, message);
    },
    recordTurnResult: writer.recordTurnResult.bind(writer),
    transcriptRelativePath: relative(dirname(storage.transcriptPath), childStorage.transcriptPath),
    dispose,
  };
}
