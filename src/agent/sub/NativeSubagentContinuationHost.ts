import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentLoopRuntimeFactory } from "../loop/AgentLoopRuntimeFactory.js";
import {
  createAgentSessionStateFromReplay,
} from "../session/AgentSession.js";
import {
  createAgentSessionWithStorageAsync,
  type AgentSessionConfigureContext,
  type AgentSessionDisposer,
  type CreateAgentSessionOptions,
} from "../session/createAgentSession.js";
import type { AgentHandle } from "../scope/AgentHandle.js";
import {
  createSubagentProjectSessionStorage,
  readSubagentProjectSessionPersistence,
  replayTranscriptEntries,
  type AgentProjectSessionStorageOptions,
} from "../../session/index.js";
import { getSubagentDefinition } from "./builtinSubagentTypes.js";
import {
  type ContinuableSubagentInspection,
  type ContinuableSubagentInspectRequest,
  type ContinuableSubagentMaterializeRequest,
  type ContinuableSubagentResumeRequest,
  type SubagentContinuationHost,
} from "./SubagentContinuationManager.js";
import { createSubagentRuntimeComposition } from "./SubagentRuntimeComposition.js";

export type NativeSubagentParentBinding = {
  parent: AgentHandle;
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
  projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  collectFileArtifacts?: boolean;
};

export type NativeSubagentContinuationHostOptions = {
  /** Optional diagnostic hook for failed child-session cleanup. */
  onCleanupError?: (error: unknown) => void;
};

/**
 * Host-owned consumer wiring for a child after its handle exists but before
 * the child is visible to the continuation manager. It is deliberately
 * optional: the core native host remains independent of Gateway tool policy.
 */
export type NativeSubagentChildConfigurator = (
  input: AgentSessionConfigureContext & {
    projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
    agentLoopFactory?: AgentLoopRuntimeFactory;
    testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
    collectFileArtifacts?: boolean;
  },
) => AgentSessionDisposer | void;

/**
 * Native production host for the continuation manager. It owns no child
 * handles itself: the manager does. This host only composes a durable child
 * session from the exact live parent binding and its descriptor.
 */
export class NativeSubagentContinuationHost implements SubagentContinuationHost {
  private readonly parents = new Map<string, NativeSubagentParentBinding>();
  private childConfigurator?: NativeSubagentChildConfigurator;

  constructor(private readonly options: NativeSubagentContinuationHostOptions = {}) {}

  /**
   * Bind a parent during its unpublished session configuration. Replacements
   * with the same id are safe because unbind checks the exact handle object.
   */
  bindParent(binding: NativeSubagentParentBinding): () => void {
    this.parents.set(binding.parent.sessionId, binding);
    return () => {
      if (this.parents.get(binding.parent.sessionId)?.parent === binding.parent) {
        this.parents.delete(binding.parent.sessionId);
      }
    };
  }

  /** Install the application-owned child consumer wiring for future activations. */
  setChildConfigurator(configurator: NativeSubagentChildConfigurator | undefined): void {
    this.childConfigurator = configurator;
  }

  async create(request: ContinuableSubagentMaterializeRequest): Promise<AgentHandle> {
    const binding = this.requireBinding(request.parent);
    return this.createChild({
      childSessionId: request.childSessionId,
      parent: request.parent,
      definition: request.definition,
      parentConfig: request.parentConfig,
      parentDependencies: request.parentDependencies,
      projectStorage: binding.projectStorage,
      resolvedModel: {
        provider: request.descriptor.agentProvider,
        model: request.descriptor.agentModel,
      },
      seedEntries: request.spec.seedEntries,
      agentLoopFactory: binding.agentLoopFactory,
      testAgentLoopFactory: binding.testAgentLoopFactory,
      collectFileArtifacts: binding.collectFileArtifacts,
      abortSignal: request.abortSignal,
    });
  }

  async inspect(request: ContinuableSubagentInspectRequest): Promise<ContinuableSubagentInspection> {
    const binding = this.requireBinding(request.parent);
    throwIfAborted(request.abortSignal, "inspect continuable subagent");
    const result = await readSubagentProjectSessionPersistence({
      ...binding.projectStorage,
      parentSessionId: request.parent.sessionId,
      sessionId: request.childSessionId,
    });
    throwIfAborted(request.abortSignal, "inspect continuable subagent");
    return { entries: result.entries };
  }

  async resume(request: ContinuableSubagentResumeRequest): Promise<AgentHandle> {
    const binding = this.requireBinding(request.parent);
    const definition = getSubagentDefinition(request.descriptor.definitionId);
    if (!definition) {
      throw new Error(`Unknown persisted subagent type: ${request.descriptor.definitionId}`);
    }
    return this.createChild({
      childSessionId: request.childSessionId,
      parent: request.parent,
      definition,
      parentConfig: binding.config,
      parentDependencies: binding.dependencies,
      projectStorage: binding.projectStorage,
      resolvedModel: {
        provider: request.descriptor.agentProvider,
        model: request.descriptor.agentModel,
      },
      agentLoopFactory: binding.agentLoopFactory,
      testAgentLoopFactory: binding.testAgentLoopFactory,
      collectFileArtifacts: binding.collectFileArtifacts,
      resume: true,
      abortSignal: request.abortSignal,
    });
  }

  private async createChild(input: {
    childSessionId: string;
    parent: AgentHandle;
    definition: NonNullable<ReturnType<typeof getSubagentDefinition>>;
    parentConfig: AgentRuntimeConfig;
    parentDependencies: AgentRuntimeDependencies;
    projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
    resolvedModel: { provider: string; model: string };
    seedEntries?: ContinuableSubagentMaterializeRequest["spec"]["seedEntries"];
    agentLoopFactory?: AgentLoopRuntimeFactory;
    testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
    collectFileArtifacts?: boolean;
    resume?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<AgentHandle> {
    throwIfAborted(input.abortSignal, "materialize continuable subagent");
    const storage = createSubagentProjectSessionStorage({
      ...input.projectStorage,
      parentSessionId: input.parent.sessionId,
      sessionId: input.childSessionId,
      now: input.parentDependencies.now,
    });
    const composition = createSubagentRuntimeComposition({
      definition: input.definition,
      subagentId: input.childSessionId,
      parentSessionId: input.parent.sessionId,
      parentConfig: input.parentConfig,
      parentDependencies: input.parentDependencies,
      resolvedModel: input.resolvedModel,
    });
    let handle: AgentHandle | undefined;
    try {
      let restoredEntries: readonly import("../../session/transcript/TranscriptEntry.js").AgentTranscriptEntry[] | undefined;
      let initialState: ReturnType<typeof createAgentSessionStateFromReplay> | undefined;
      let replayEvents: ReturnType<typeof replayTranscriptEntries>["events"] | undefined;
      let initialMetadata: ReturnType<typeof replayTranscriptEntries>["metadata"] | undefined;
      if (input.resume) {
        const restored = await storage.restore();
        restoredEntries = restored.entries;
        const replay = replayTranscriptEntries(restored.entries);
        initialState = createAgentSessionStateFromReplay(input.childSessionId, replay);
        replayEvents = replay.events;
        initialMetadata = replay.metadata;
      } else if (input.seedEntries && input.seedEntries.length > 0) {
        validateSeedEntries(input.seedEntries, input.childSessionId);
        for (const entry of input.seedEntries) {
          await storage.transcript.recordEntry!(entry);
        }
        restoredEntries = input.seedEntries;
      }
      throwIfAborted(input.abortSignal, "materialize continuable subagent");
      const created = await createAgentSessionWithStorageAsync({
        sessionId: input.childSessionId,
        config: composition.config,
        dependencies: composition.dependencies,
        storage,
        transcript: storage.transcript,
        ...(initialState ? { initialState } : {}),
        ...(replayEvents ? { replayEvents } : {}),
        ...(initialMetadata ? { initialMetadata } : {}),
        ...(restoredEntries ? { restoredEntries } : {}),
        ownedScope: true,
        collectFileArtifacts: input.collectFileArtifacts,
        agentLoopFactory: input.agentLoopFactory,
        __agentLoopFactory: input.testAgentLoopFactory,
        __configure: (context) => {
          const configured = this.childConfigurator?.({
            ...context,
            projectStorage: input.projectStorage,
            agentLoopFactory: input.agentLoopFactory,
            testAgentLoopFactory: input.testAgentLoopFactory,
            collectFileArtifacts: input.collectFileArtifacts,
          });
          return async () => {
            const errors: unknown[] = [];
            try {
              await configured?.();
            } catch (error) {
              errors.push(error);
            }
            try {
              await composition.dispose();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) {
              throw new AggregateError(errors, "Failed to dispose native continuable child configuration.");
            }
          };
        },
      });
      handle = created.handle;
      throwIfAborted(input.abortSignal, "materialize continuable subagent");
      return handle;
    } catch (error) {
      if (handle) {
        await handle.dispose("continuable_subagent_host_rollback").catch((cleanupError) => {
          this.options.onCleanupError?.(cleanupError);
        });
      }
      try {
        await composition.dispose();
      } catch (cleanupError) {
        this.options.onCleanupError?.(cleanupError);
      }
      try {
        await storage.dispose();
      } catch (cleanupError) {
        this.options.onCleanupError?.(cleanupError);
      }
      throw error;
    }
  }

  private requireBinding(parent: AgentHandle): NativeSubagentParentBinding {
    const binding = this.parents.get(parent.sessionId);
    if (!binding || binding.parent !== parent) {
      throw new Error(`Continuable subagent parent is not bound: ${parent.sessionId}`);
    }
    return binding;
  }
}

function validateSeedEntries(
  entries: readonly import("../../session/transcript/TranscriptEntry.js").AgentTranscriptEntry[],
  childSessionId: string,
): void {
  for (const entry of entries) {
    if (entry.sessionId !== childSessionId) {
      throw new Error("Continuable subagent seed entry belongs to another session.");
    }
    if (entry.type === "subagent_descriptor") {
      throw new Error("Continuable subagent seed entries must not contain a descriptor.");
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined, action: string): void {
  if (!signal?.aborted) return;
  throw new Error(`${action} aborted: ${String(signal.reason ?? "aborted")}`);
}
