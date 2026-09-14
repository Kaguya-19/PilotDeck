import type { PilotDeckReadFileStateMap, PilotDeckSubagentForkApi, PilotDeckWriteSnapshotMap } from "../../tool/index.js";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../../tool/protocol/subagentTimeout.js";
import type { PilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { buildTurnEnvironment } from "../turn/TurnEnvironment.js";
import { getSubagentDefinition, listSubagentDefinitionIds } from "./builtinSubagentTypes.js";
import { SubAgentSession } from "./SubAgentSession.js";
import type { SidechainTranscriptWriter } from "./SubagentProvider.js";

export type OneShotSubagentPortOptions = {
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
};

export type OneShotSubagentPortRequest = {
  sessionId: string;
  turnId: string;
  parentReadFileState?: PilotDeckReadFileStateMap;
  parentWriteSnapshots?: PilotDeckWriteSnapshotMap;
};

/** Stable delegation Definition consumed by AgentLoop's tool runtime context. */
export type OneShotSubagentPort = {
  createForkApi(input: OneShotSubagentPortRequest): PilotDeckSubagentForkApi;
};

/**
 * Host-owned one-shot subagent consumer.
 *
 * It supplies the `agent` tool's fork contract without making a sidecar own
 * child session state. Named provider selection, child composition, sidechain
 * persistence and run disposal remain inside the native subagent family.
 */
export function createNativeOneShotSubagentPort(
  options: OneShotSubagentPortOptions,
): OneShotSubagentPort {
  return {
    createForkApi: (input) => createNativeForkApi({ ...options, ...input }),
  };
}

function createNativeForkApi(
  options: OneShotSubagentPortOptions & OneShotSubagentPortRequest,
): PilotDeckSubagentForkApi {
  const depth = options.config.subagentDepth ?? 0;
  const maxSubagentDepth = options.config.maxSubagentDepth ?? 1;
  return {
    depth,
    maxSubagentDepth,
    listDefinitions: () => listSubagentDefinitionIds().map((id) => {
      const definition = getSubagentDefinition(id)!;
      return { id: definition.id, description: definition.description };
    }),
    isAllowedDefinition: (id) => getSubagentDefinition(id) !== undefined,
    fork: async ({ definitionId, directive, subagentId, toolCallId, abortSignal, timeoutMs }) => {
      const definition = getSubagentDefinition(definitionId);
      if (!definition) throw new Error(`Unknown subagent type: ${definitionId}`);
      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
      const abort = composeAbortSignal(abortSignal, effectiveTimeoutMs);
      const subagentSessionId = `${options.config.cwd}::sub::${subagentId}`;
      const transcript = options.dependencies.subagentTranscript;
      let sidechain: SidechainTranscriptWriter | undefined;
      let sidechainDisposed = false;
      let startedRecorded = false;
      let completionAttempted = false;
      let lifecycleStarted = false;
      let lifecycleStopped = false;
      let startedEventEmitted = false;
      let completedEventEmitted = false;
      const disposeSidechain = async (): Promise<void> => {
        if (sidechainDisposed) return;
        sidechainDisposed = true;
        await sidechain?.dispose?.();
      };

      try {
        sidechain = transcript?.subagentTranscriptResolver?.(subagentId, subagentSessionId);
        await transcript?.recordSubagentStarted?.({
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          prompt: directive,
          transcriptRelativePath: sidechain?.transcriptRelativePath ?? "",
          subagentSessionId,
        });
        startedRecorded = true;
        await dispatchSubagentLifecycle(options, abortSignal, "SubagentStart", {
          subagentId,
          subagentType: definition.id,
        });
        lifecycleStarted = true;
        options.dependencies.eventEmitter?.({
          type: "subagent_started",
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          toolCallId,
        });
        startedEventEmitted = true;

        const session = new SubAgentSession({
          definition,
          directive,
          parentConfig: {
            ...options.config,
            subagentDepth: depth + 1,
            isSubagent: true,
          },
          parentDependencies: options.dependencies,
          parentReadFileState: options.parentReadFileState,
          parentWriteSnapshots: options.parentWriteSnapshots,
          parentSessionId: options.sessionId,
          parentTurnId: options.turnId,
          subagentSessionId,
          subagentId,
          abortSignal: abort.signal,
          sidechainTranscript: sidechain,
        });
        const report = await session.run();
        if (abort.timedOut()) {
          throw new Error(`Subagent timed out after ${effectiveTimeoutMs}ms.`);
        }
        if (abortSignal?.aborted) {
          throw new Error("Subagent aborted before completion.");
        }
        // A parent completion must never advertise a child whose selected
        // persistence backend has not finished its durable teardown.
        await disposeSidechain();
        completionAttempted = true;
        await transcript?.recordSubagentCompleted?.({
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          summary: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          errored: false,
        });
        await dispatchSubagentLifecycle(options, abortSignal, "SubagentStop", {
          subagentId,
          subagentType: definition.id,
          success: true,
        });
        lifecycleStopped = true;
        options.dependencies.eventEmitter?.({
          type: "subagent_completed",
          sessionId: options.sessionId,
          turnId: options.turnId,
          subagentId,
          subagentType: definition.id,
          success: true,
          durationMs: report.durationMs,
        });
        completedEventEmitted = true;
        return {
          markdown: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          parsed: report.parsed as Record<string, string> | undefined,
          subagentSessionId,
          ...(sidechain?.transcriptRelativePath
            ? { transcriptRelativePath: sidechain.transcriptRelativePath }
            : {}),
        };
      } catch (error) {
        const timedOut = abort.timedOut();
        const aborted = Boolean(abortSignal?.aborted && !timedOut);
        let failure: unknown = timedOut
          ? new Error(`Subagent timed out after ${effectiveTimeoutMs}ms.`)
          : error;
        try {
          await disposeSidechain();
        } catch (disposeError) {
          failure = new AggregateError(
            [failure, disposeError],
            "Subagent failed and its sidechain storage could not be disposed.",
          );
        }
        // Storage or parent-start failures have no durable started fact, so
        // they must not leave behind an unmatched terminal record.
        if (startedRecorded && !completionAttempted) {
          completionAttempted = true;
          try {
            await transcript?.recordSubagentCompleted?.({
              sessionId: options.sessionId,
              turnId: options.turnId,
              subagentId,
              subagentType: definition.id,
              summary: failure instanceof Error ? failure.message : String(failure),
              turns: 0,
              durationMs: 0,
              errored: true,
            });
          } catch (completionError) {
            failure = new AggregateError(
              [failure, completionError],
              "Subagent failed and its parent completion could not be recorded.",
            );
          }
        }
        if (lifecycleStarted && !lifecycleStopped) {
          try {
            await dispatchSubagentLifecycle(options, abortSignal, "SubagentStop", {
              subagentId,
              subagentType: definition.id,
              success: false,
            });
            lifecycleStopped = true;
          } catch (lifecycleError) {
            failure = new AggregateError(
              [failure, lifecycleError],
              "Subagent failed and its stop lifecycle hook could not be dispatched.",
            );
          }
        }
        if (startedEventEmitted && !completedEventEmitted) {
          try {
            options.dependencies.eventEmitter?.({
              type: "subagent_completed",
              sessionId: options.sessionId,
              turnId: options.turnId,
              subagentId,
              subagentType: definition.id,
              success: false,
              aborted,
              durationMs: 0,
            });
            completedEventEmitted = true;
          } catch (eventError) {
            failure = new AggregateError(
              [failure, eventError],
              "Subagent failed and its completion event could not be emitted.",
            );
          }
        }
        throw failure;
      } finally {
        abort.dispose();
      }
    },
  };
}

async function dispatchSubagentLifecycle(
  options: OneShotSubagentPortOptions & Pick<OneShotSubagentPortRequest, "sessionId" | "turnId">,
  abortSignal: AbortSignal | undefined,
  event: PilotDeckHookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  await options.dependencies.lifecycle?.dispatch({
    event,
    baseInput: {
      sessionId: options.sessionId,
      transcriptPath: "",
      cwd: options.config.cwd,
      permissionMode: options.config.permissionMode,
    },
    payload,
    matchQuery: event,
    signal: abortSignal,
    env: buildTurnEnvironment(
      options.config.env,
      options.config.cwd,
      options.sessionId,
      options.turnId,
    ),
  });
}

function composeAbortSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const forwardParentAbort = () => controller.abort(parent?.reason ?? "subagent_parent_aborted");
  if (parent?.aborted) forwardParentAbort();
  else parent?.addEventListener("abort", forwardParentAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timeout = true;
    controller.abort("subagent_timeout");
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timeoutId);
      parent?.removeEventListener("abort", forwardParentAbort);
    },
  };
}
