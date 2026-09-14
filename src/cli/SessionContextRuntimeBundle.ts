import type { AgentEventEmitter } from "../agent/protocol/events.js";
import {
  AutoCompactionPolicy,
  CompactionEngine,
  ContextOverflowRecovery,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  DefaultContextRuntime,
  InstructionDiscovery,
  MicroCompactionEngine,
  PromptCacheCoordinator,
  PromptContributionRegistry,
  SnipEngine,
  TokenBudgetManager,
  ToolResultBudget,
  createNativeCompactionPort,
  type CompactionPort,
  registerExtensionPromptContributions,
  type ExtensionResolver,
  type InstructionStoragePort,
  type MemoryResolver,
  type PromptCacheCoordinatorPort,
  type RuntimeContextSurface,
  type TokenAccountingRuntime,
  type ToolResultSpillPort,
} from "../context/index.js";
import type { LifecycleRuntime } from "../lifecycle/index.js";
import type { RouterRuntime } from "../router/index.js";

export type SessionContextRuntimeBundleOptions = {
  sessionKey: string;
  projectKey?: string;
  projectRoot: string;
  pilotHome: string;
  toolResultsDir: string;
  extension: ExtensionResolver;
  instructionStorage: InstructionStoragePort;
  toolResultSpill: ToolResultSpillPort;
  model: Pick<RouterRuntime, "stream">;
  tokenAccounting: TokenAccountingRuntime;
  lifecycle: Pick<LifecycleRuntime, "dispatch">;
  modelProvider: string;
  modelName: string;
  maxContextTokens: number;
  runtimeContextSurface?: RuntimeContextSurface;
  memoryResolver?: MemoryResolver;
  memoryRetrievalTimeoutMs?: number;
  /** Optional application-owned cache-generation provider for this session context. */
  promptCacheCoordinator?: PromptCacheCoordinatorPort;
  /** Optional application-selected compaction provider for this session context. */
  compaction?: CompactionPort;
  now: () => Date;
  eventEmitter?: AgentEventEmitter;
};

export type SessionContextRuntimeBundleResult = {
  context: DefaultContextRuntime;
  promptContributions: {
    registry: PromptContributionRegistry;
    owned: true;
  };
};

/**
 * Native session-context composition.
 *
 * The project owns model routing, memory, instruction storage and spill I/O.
 * The Agent scope owns only the prompt-contribution registrations created from
 * the frozen extension generation returned here.
 */
export class SessionContextRuntimeBundle {
  constructor(private readonly options: SessionContextRuntimeBundleOptions) {}

  compose(): SessionContextRuntimeBundleResult {
    const toolResultBudget = new ToolResultBudget({
      toolResultsDir: this.options.toolResultsDir,
      spillPort: this.options.toolResultSpill,
    });
    const tokenBudget = new TokenBudgetManager();
    const compactionEngine = new CompactionEngine({
      model: {
        stream: (request, signal) => this.options.model.stream(request, {
          sessionId: this.options.sessionKey,
          turnId: "compact",
          projectPath: this.options.projectKey,
          abortSignal: signal,
          isMainAgent: false,
        }),
      },
      tokenBudget,
      tokenAccounting: this.options.tokenAccounting,
      lifecycle: {
        dispatch: async (input) => {
          await this.options.lifecycle.dispatch({
            event: input.event,
            baseInput: {
              sessionId: this.options.sessionKey,
              transcriptPath: "",
              cwd: this.options.projectRoot,
              permissionMode: "default",
            },
            payload: input.payload,
            matchQuery: input.event,
          });
        },
      },
      provider: this.options.modelProvider,
      model_: this.options.modelName,
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      now: this.options.now,
      eventEmitter: this.options.eventEmitter,
    });
    const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
    const microCompaction = new MicroCompactionEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const snipEngine = new SnipEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const overflowRecovery = new ContextOverflowRecovery();
    const compaction = this.options.compaction ?? createNativeCompactionPort({
      tokenBudget,
      autoCompactionPolicy,
      compactionEngine,
      microCompaction,
      snipEngine,
      overflowRecovery,
    });
    const instructionDiscovery = new InstructionDiscovery(
      this.options.projectRoot,
      this.options.projectRoot,
      this.options.pilotHome,
      this.options.instructionStorage,
    );
    const promptContributions = new PromptContributionRegistry({
      name: `agent:${this.options.sessionKey}`,
    });
    const promptCacheCoordinator = this.options.promptCacheCoordinator ?? new PromptCacheCoordinator();

    try {
      registerExtensionPromptContributions(promptContributions, this.options.extension);
      return {
        context: new DefaultContextRuntime({
          extension: this.options.extension,
          promptContributions,
          promptCacheCoordinator,
          runtimeContextSurface: this.options.runtimeContextSurface,
          projectRoot: this.options.projectRoot,
          memoryResolver: this.options.memoryResolver,
          memoryRetrievalTimeoutMs: this.options.memoryRetrievalTimeoutMs,
          instructionDiscovery,
          toolResultBudget,
          compaction,
          tokenBudget,
          compactionEngine,
          autoCompactionPolicy,
          microCompaction,
          snipEngine,
          overflowRecovery,
          maxContextTokens: this.options.maxContextTokens,
          now: this.options.now,
        }),
        promptContributions: { registry: promptContributions, owned: true },
      };
    } catch (error) {
      promptContributions.dispose();
      throw error;
    }
  }
}
