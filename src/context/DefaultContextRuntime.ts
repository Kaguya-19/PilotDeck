import { createHash } from "node:crypto";
import type { CanonicalMessage } from "../model/index.js";
import {
  LEGACY_RUNTIME_CONTEXT_SURFACE,
  type RuntimeContextSurface,
} from "./RuntimeContextSurface.js";
import { ToolResultBudget } from "./budget/ToolResultBudget.js";
import type { TokenBudgetManager } from "./budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./compaction/AutoCompactionPolicy.js";
import type { CompactionEngine } from "./compaction/CompactionEngine.js";
import type { AutoCompactResult, CompactionAutoCompactInput, CompactionPort } from "./compaction/CompactionPort.js";
import { createNativeCompactionPort } from "./compaction/NativeCompactionPort.js";
import { withCompactionOrchestrator } from "./compaction/CompactionOrchestrator.js";
import { PromptCacheCoordinator } from "./cache/PromptCacheCoordinator.js";
import type { PromptCacheCoordinatorPort } from "./cache/PromptCacheCoordinatorPort.js";
import { stableSerialize } from "./cache/CachePlan.js";
import type { MicroCompactionEngine } from "./compaction/MicroCompactionEngine.js";
import type { SnipEngine } from "./compaction/SnipEngine.js";
import { isRealUserRequestMessage } from "./compaction/toolPairIntegrity.js";
import type { ContextOverflowRecovery } from "./recovery/ContextOverflowRecovery.js";
import { NullExtensionResolver, type ExtensionResolver } from "./extension/ExtensionResolver.js";
import type { InstructionDiscovery, InstructionScope } from "./instructions/InstructionDiscovery.js";
import { MemoryAttachmentBuilder } from "./memory/MemoryAttachmentBuilder.js";
import type { MemoryResolver } from "./memory/MemoryResolver.js";
import { PromptAssembler } from "./prompt/PromptAssembler.js";
import {
  PromptContributionRegistry,
  renderPromptContributionSections,
  renderPromptRuntimeContextSections,
} from "./prompt/PromptContributionRegistry.js";
import { MessageProjector } from "./projection/MessageProjector.js";
import type {
  ContextCaptureTurnInput,
  ContextDiagnostic,
  ContextInstructionSnapshotLayer,
  ContextPrepareInput,
  ContextRecoveryDecision,
  ContextRecoveryInput,
  ContextRuntime,
  ContextToolResultInput,
  ContextToolResultResult,
  ModelContext,
} from "./protocol/types.js";

export type CompactionTier = "micro" | "snip" | "full" | "emergency";
export type { AutoCompactResult } from "./compaction/CompactionPort.js";
export type { RuntimeContextSurface } from "./RuntimeContextSurface.js";

export type DefaultContextRuntimeOptions = {
  extension?: ExtensionResolver;
  /** Defaults false so ordinary custom system prompts keep their current contract. */
  includeExtensionsWithCustomSystemPrompt?: boolean;
  promptAssembler?: PromptAssembler;
  promptContributions?: PromptContributionRegistry;
  messageProjector?: MessageProjector;
  toolResultBudget?: ToolResultBudget;
  memoryResolver?: MemoryResolver;
  /** Dynamic runtime-context projection. Defaults to the native-compatible system prompt path. */
  runtimeContextSurface?: RuntimeContextSurface;
  /** Application-selected owner for session prompt-cache generations. */
  promptCacheCoordinator?: PromptCacheCoordinatorPort;
  /** Context-level compaction provider. Preferred over the legacy per-stage options below. */
  compaction?: CompactionPort;
  /** A2 — token budget manager (provider-aware tokenizer fallback). */
  tokenBudget?: TokenBudgetManager;
  /** A5 — full-conversation compaction engine (summarize via model call). */
  compactionEngine?: CompactionEngine;
  /** A5 — token-budget-driven policy that decides when to summarize. */
  autoCompactionPolicy?: AutoCompactionPolicy;
  /** Tier 1 — truncates old tool_result content (time-based path). */
  microCompaction?: MicroCompactionEngine;
  /** Tier 2 — prunes middle turns, keeping head + tail anchors. */
  snipEngine?: SnipEngine;
  /** Reactive overflow recovery (prompt_too_long → truncate head). */
  overflowRecovery?: ContextOverflowRecovery;
  /** PILOTDECK.md instruction file discovery (multi-scope hierarchy). */
  instructionDiscovery?: InstructionDiscovery;
  /** Project root forwarded to MemoryResolver.retrieve. */
  projectRoot?: string;
  /**
   * Maximum context window size (tokens) for the active model. Used by
   * `tryAutoCompact` to evaluate whether proactive compaction is needed.
   * Falls back to 8192 when unset.
   */
  maxContextTokens?: number;
  /**
   * keepRatio used on the first reactive truncate. Legacy hint is 0.5 — keep
   * the back half of the conversation. Decision §3.2.
   */
  truncateFirstKeepRatio?: number;
  /** Aggressive ratio used after one truncate-and-retry already failed. */
  truncateSecondKeepRatio?: number;
  /** Timeout budget for MemoryResolver.retrieve during prepareForModel. */
  memoryRetrievalTimeoutMs?: number;
  now?: () => Date;
};

const DEFAULT_MAX_CONTEXT_TOKENS = 8192;
const DEFAULT_TRUNCATE_FIRST_RATIO = 0.5;
const DEFAULT_TRUNCATE_SECOND_RATIO = 0.25;
const DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000;
export class DefaultContextRuntime implements ContextRuntime {
  private readonly extension: ExtensionResolver;
  private readonly includeExtensionsWithCustomSystemPrompt: boolean;
  private readonly promptAssembler: PromptAssembler;
  private readonly promptContributions?: PromptContributionRegistry;
  private readonly messageProjector: MessageProjector;
  private readonly toolResultBudget?: ToolResultBudget;
  private readonly memoryResolver?: MemoryResolver;
  private readonly memoryAttachmentBuilder?: MemoryAttachmentBuilder;
  private readonly runtimeContextSurface: RuntimeContextSurface;
  /** Legacy inspection fields retained while consumers migrate to CompactionPort. */
  readonly tokenBudget?: TokenBudgetManager;
  readonly compactionEngine?: CompactionEngine;
  readonly autoCompactionPolicy?: AutoCompactionPolicy;
  private readonly compaction?: CompactionPort;
  private readonly promptCacheCoordinator: PromptCacheCoordinatorPort;
  private readonly promptCacheSessions = new Set<string>();
  private readonly promptTimeState = new Map<string, {
    timestamp: number;
    messages: string[];
    dateUpdates: Array<{ index: number; date: string; message: CanonicalMessage }>;
  }>();
  private readonly instructionDiscovery?: InstructionDiscovery;
  private readonly projectRoot?: string;
  private readonly maxContextTokens: number;
  private readonly truncateFirstKeepRatio: number;
  private readonly truncateSecondKeepRatio: number;
  private readonly memoryRetrievalTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: DefaultContextRuntimeOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
    this.includeExtensionsWithCustomSystemPrompt = options.includeExtensionsWithCustomSystemPrompt ?? false;
    this.promptAssembler = options.promptAssembler ?? new PromptAssembler(this.extension);
    this.promptContributions = options.promptContributions;
    this.messageProjector = options.messageProjector ?? new MessageProjector();
    this.toolResultBudget = options.toolResultBudget;
    this.memoryResolver = options.memoryResolver;
    this.memoryAttachmentBuilder = options.memoryResolver
      ? new MemoryAttachmentBuilder(options.memoryResolver)
      : undefined;
    this.runtimeContextSurface = options.runtimeContextSurface ?? LEGACY_RUNTIME_CONTEXT_SURFACE;
    this.promptCacheCoordinator = options.promptCacheCoordinator ?? new PromptCacheCoordinator();
    this.tokenBudget = options.tokenBudget;
    this.compactionEngine = options.compactionEngine;
    this.autoCompactionPolicy = options.autoCompactionPolicy;
    const compaction = options.compaction ?? createNativeCompactionPort({
      ...options,
      log: logAutoCompactEvent,
    });
    this.compaction = compaction
      ? withCompactionOrchestrator(compaction, {
          maxContextTokens: options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
          log: logAutoCompactEvent,
        })
      : undefined;
    this.instructionDiscovery = options.instructionDiscovery;
    this.projectRoot = options.projectRoot;
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.truncateFirstKeepRatio = options.truncateFirstKeepRatio ?? DEFAULT_TRUNCATE_FIRST_RATIO;
    this.truncateSecondKeepRatio = options.truncateSecondKeepRatio ?? DEFAULT_TRUNCATE_SECOND_RATIO;
    this.memoryRetrievalTimeoutMs = options.memoryRetrievalTimeoutMs ?? DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async prepareForModel(input: ContextPrepareInput): Promise<ModelContext> {
    const diagnostics: ContextDiagnostic[] = [];
    const runtimeContextSurface = input.runtimeContextSurface ?? this.runtimeContextSurface;

    const projection = this.messageProjector.project({
      messages: input.messages,
      maxMessages: input.maxMessages,
    });

    for (const warning of projection.warnings) {
      diagnostics.push({
        code: warning.code,
        severity: "warning",
        message: warning.message,
      });
    }

    const contributionSnapshot = this.promptContributions
      ? await this.promptContributions.snapshot({
          sessionId: input.sessionId,
          turnId: input.turnId,
          cwd: input.cwd,
          provider: input.provider,
          model: input.model,
          permissionMode: input.permissionMode,
          runMode: input.runMode,
          additionalWorkingDirectories: input.additionalWorkingDirectories,
          abortSignal: input.abortSignal,
        }, {
          toolSchemas: { snapshot: () => input.tools },
          variables: {
            cwd: input.cwd,
            provider: input.provider,
            model: input.model,
            permission_mode: input.permissionMode,
            run_mode: input.runMode,
            session_id: input.sessionId,
            turn_id: input.turnId,
          },
        })
      : undefined;
    const contributedSections = contributionSnapshot
      ? renderPromptContributionSections(contributionSnapshot)
      : [];
    const registeredRuntimeContexts = contributionSnapshot
      ? renderPromptRuntimeContextSections(contributionSnapshot)
      : [];
    const effectiveTools = contributionSnapshot
      ? [...contributionSnapshot.tools]
      : input.tools;

    // Track the unchanged prefix so pruning only relocates date notices after
    // the first changed message, without retaining another copy of large media.
    const messageFingerprints = projection.messages.map((message) => createHash("sha256")
      .update(stableSerialize({ role: message.role, content: message.content }))
      .digest("hex"));
    const previousTime = this.promptTimeState.get(input.sessionId);
    let unchangedPrefixLength = 0;
    while (previousTime && unchangedPrefixLength < messageFingerprints.length
      && messageFingerprints[unchangedPrefixLength] === previousTime.messages[unchangedPrefixLength]) {
      unchangedPrefixLength += 1;
    }
    // Only a new full-compaction checkpoint refreshes the system date. Cache
    // resets also cover micro-pruning and must not invalidate the system prefix.
    // Inspect the checkpoint to cover manual compaction performed by callers.
    const boundary = projection.messages[0];
    const summary = projection.messages[1];
    const newCheckpoint = previousTime !== undefined
      && boundary?.role === "user"
      && boundary.content.some((block) => block.type === "text" && block.text.startsWith("<compact-boundary"))
      && summary?.role === "assistant"
      && summary.content.some((block) => block.type === "text" && block.text.startsWith("[CONTEXT COMPACTION - REFERENCE ONLY]"))
      && unchangedPrefixLength < 2;
    const refreshTime = !input.previewOnly && newCheckpoint;
    const currentTime = this.now();
    const currentDate = currentTime.toISOString().slice(0, 10);
    const promptTimestamp = !previousTime || refreshTime ? currentTime.getTime() : previousTime.timestamp;
    // Keep each rollover at its original position so later requests extend the
    // same cache prefix. These request-only messages share the prompt anchor's
    // lifetime. Keep notices inside the unchanged prefix; replace affected
    // notices with the current date at the new tail. This avoids stale indexes
    // after pruning and never changes a prefix that pruning itself preserved.
    const dateUpdates = refreshTime ? [] : (previousTime?.dateUpdates ?? [])
      .filter((update) => update.index <= unchangedPrefixLength);
    const lastDate = dateUpdates.at(-1)?.date ?? new Date(promptTimestamp).toISOString().slice(0, 10);
    if (currentDate !== lastDate) {
      dateUpdates.push({
        index: projection.messages.length,
        date: currentDate,
        message: {
          role: "user",
          content: [{ type: "text", text:
            `<date-update>\ncurrent_date: ${currentDate} (UTC)\n` +
            "The date has changed. Use this date for today and relative dates, " +
            "superseding earlier environment dates.\n</date-update>",
          }],
          metadata: { synthetic: true, purpose: "date_update" },
        },
      });
    }
    const requestMessages: CanonicalMessage[] = [];
    let messageIndex = 0;
    for (const update of dateUpdates) {
      requestMessages.push(...projection.messages.slice(messageIndex, update.index), update.message);
      messageIndex = update.index;
    }
    requestMessages.push(...projection.messages.slice(messageIndex));
    const prompt = this.promptAssembler.assemble({
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
      runMode: input.runMode,
      additionalWorkingDirectories: input.additionalWorkingDirectories,
      tools: effectiveTools,
      customSystemPrompt: input.customSystemPrompt,
      appendSystemPrompt: input.appendSystemPrompt,
      includeExtensionsWithCustomSystemPrompt: this.includeExtensionsWithCustomSystemPrompt,
      includeUserContextInSystemPrompt: runtimeContextSurface === "system_prompt",
      now: () => new Date(promptTimestamp),
    });
    const hasCompleteContribution = contributionSnapshot?.sections.some((section) => section.complete) === true;
    const parts = hasCompleteContribution
      ? [...contributedSections]
      : [...prompt.parts, ...contributedSections];
    const runtimeContexts = [
      ...prompt.sections.userContext.map((text, index) => ({
        name: `pilotdeck:user-context:${index}`,
        text,
      })),
      ...registeredRuntimeContexts.map(({ name, text }) => ({ name, text })),
    ];
    if (runtimeContextSurface === "system_prompt") {
      for (const context of registeredRuntimeContexts) {
        parts.push(context.text);
      }
    }
    if (this.memoryAttachmentBuilder) {
      const memory = await this.memoryAttachmentBuilder.build({
        query: extractRecentUserText(projection.messages) ?? "",
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? input.cwd,
        recentMessages: projection.messages,
        signal: input.abortSignal,
        timeoutMs: this.memoryRetrievalTimeoutMs,
      });
      for (const [blockIndex, block] of memory.attachments.entries()) {
        for (const [contentIndex, content] of block.content.entries()) {
          if (content.type === "text" && content.text.trim().length > 0) {
            if (runtimeContextSurface === "system_prompt") {
              parts.push(content.text);
            }
            runtimeContexts.push({
              name: `pilotdeck:memory:${blockIndex}:${contentIndex}`,
              text: content.text,
            });
          }
        }
      }
      for (const diagnostic of memory.diagnostics) {
        diagnostics.push({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
      if (input.abortSignal?.aborted) {
        const runtimeContextMessages = this.buildRuntimeContextMessages(runtimeContexts, runtimeContextSurface);
        const projectedMessages = insertBeforeLatestUserRequest(requestMessages, runtimeContextMessages);
        return {
          messages: projectedMessages,
          systemPrompt: parts.join("\n\n"),
          systemPromptParts: parts,
          tools: effectiveTools,
          diagnostics,
          boundaries: [],
          metadata: {
            droppedCount: projection.droppedCount,
            toolCount: effectiveTools.length,
          },
          materialization: {
            ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
            promptGeneration: contributionSnapshot?.generation,
            runtimeContexts,
            ...(runtimeContextMessages.length > 0 ? { runtimeContextMessages } : {}),
          },
        };
      }
    }

    let instructionLayers: ContextInstructionSnapshotLayer[] | undefined;
    if (this.instructionDiscovery) {
      try {
        const layers = await this.instructionDiscovery.discover();
        instructionLayers = layers.map((layer) => ({ ...layer }));
        if (layers.length > 0) {
          const blocks = layers.map(l => {
            const desc = instructionScopeDescription(l.scope);
            return `Contents of ${l.path}${desc}:\n\n${l.content}`;
          });
          parts.push(
            `<project-instructions>\nProject instructions are shown below. Adhere to these instructions. ` +
            `IMPORTANT: These instructions OVERRIDE any default behavior.\n\n` +
            `${blocks.join("\n\n")}\n</project-instructions>`,
          );
        }
      } catch {
        diagnostics.push({
          code: "instruction_discovery_failed",
          severity: "warning",
          message: "Failed to discover PILOTDECK.md instruction files.",
        });
      }
    }

    const joined = parts.join("\n\n");
    const runtimeContextMessages = this.buildRuntimeContextMessages(runtimeContexts, runtimeContextSurface);
    const projectedMessages = insertBeforeLatestUserRequest(requestMessages, runtimeContextMessages);

    const cachePlanInput = {
      provider: input.provider,
      model: input.model,
      systemPrompt: joined,
      tools: effectiveTools,
      messages: projectedMessages,
      enabled: input.protocol === "anthropic" && input.supportsPromptCache === true,
    };
    this.trackPromptCacheSession(input.sessionId);
    const cachePlan = this.promptCacheCoordinator.createPlan(input.sessionId, cachePlanInput, {
      commit: !input.previewOnly,
    });

    // Budget probes must not consume resets or commit hypothetical histories.
    if (!input.previewOnly) {
      this.promptTimeState.set(input.sessionId, { timestamp: promptTimestamp, messages: messageFingerprints, dateUpdates });
    }

    return {
      messages: projectedMessages,
      systemPrompt: joined,
      systemPromptParts: parts,
      tools: effectiveTools,
      diagnostics,
      boundaries: [],
      metadata: {
        droppedCount: projection.droppedCount,
        toolCount: effectiveTools.length,
      },
      materialization: {
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
        promptGeneration: contributionSnapshot?.generation,
        runtimeContexts,
        ...(runtimeContextMessages.length > 0 ? { runtimeContextMessages } : {}),
        instructionLayers,
      },
      cacheBreakpoints: cachePlan?.messages,
      cachePlan,
    };
  }

  async applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult> {
    const diagnostics: ContextDiagnostic[] = [];
    let appended: CanonicalMessage = input.toolResultMessage;
    let supplementalMessages = input.supplementalMessages ?? [];
    if (this.toolResultBudget) {
      try {
        appended = await this.toolResultBudget.applyToMessage(input.toolResultMessage, { turnId: input.turnId });
        supplementalMessages = await Promise.all(
          supplementalMessages.map(async ({ toolCallId, message }) => ({
            toolCallId,
            message: await this.toolResultBudget!.applyToSupplementalMessage(
              message,
              toolCallId,
              { turnId: input.turnId },
            ),
          })),
        );
      } catch (error) {
        diagnostics.push({
          code: "tool_result_persistence_failed",
          severity: "error",
          message: `Failed to persist large tool result: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const appendedMessages = [appended, ...supplementalMessages.map(({ message }) => message)];
    return { messages: [...input.messages, ...appendedMessages], appendedMessages, diagnostics };
  }

  private buildRuntimeContextMessages(
    contexts: Array<{ name: string; text: string }>,
    runtimeContextSurface: RuntimeContextSurface = this.runtimeContextSurface,
  ): CanonicalMessage[] {
    if (runtimeContextSurface !== "user_message" || contexts.length === 0) return [];
    return [{
      role: "user",
      content: contexts.map((context) => ({
        type: "text" as const,
        text: `<runtime-context name="${escapeXmlAttribute(context.name)}">\n${context.text}\n</runtime-context>`,
      })),
      metadata: {
        synthetic: true,
        purpose: "runtime_context",
      },
    }];
  }

  async captureTurn(input: ContextCaptureTurnInput): Promise<void> {
    if (!this.memoryResolver) return;
    if (isAlwaysOnSession(input.sessionId)) return;
    try {
      await this.memoryResolver.captureTurn({
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? "",
        messages: input.messages.filter((message) => !message.metadata?.forkCarryover),
        errored: input.errored,
      });
    } catch {
      // Memory capture must never break the agent turn — provider already
      // swallows in EdgeClawMemoryProvider, this catch is belt-and-suspenders.
    }
  }

  dispose(): void {
    for (const sessionId of this.promptCacheSessions) {
      this.promptCacheCoordinator.release(sessionId);
    }
    this.promptCacheSessions.clear();
  }

  async tryAutoCompact(input: CompactionAutoCompactInput): Promise<AutoCompactResult> {
    const sessionId = input.sessionId ?? "";
    const turnId = input.turnId ?? "";
    if (this.compaction?.autoCompact) {
      const result = await this.compaction.autoCompact(input);
      if (result.type === "compacted") {
        this.trackPromptCacheSession(sessionId);
        this.promptCacheCoordinator.reset(sessionId);
      }
      return result;
    }
    // Constructor composition normally guarantees autoCompact for every
    // configured stage provider. Keep the no-provider result explicit for
    // callers that disable compaction entirely.
    if (!this.compaction) {
      logAutoCompactEvent("disabled", {
        sessionId,
        turnId,
      }, {
        hasAutoCompactionPolicy: false,
        hasTokenBudget: false,
        maxContextTokens: input.maxContextTokens ?? this.maxContextTokens,
      });
      return {
        type: "skipped",
        snapshot: {
          tokens: 0,
          maxContextTokens: input.maxContextTokens ?? this.maxContextTokens,
          warningRatio: 0,
          blockingRatio: 0,
          state: "ok",
          ratio: 0,
        },
      };
    }
    // Defensive compatibility path for externally mutated provider objects.
    // Normal construction never reaches the legacy inline implementation.
    return (withCompactionOrchestrator(this.compaction, {
      maxContextTokens: input.maxContextTokens ?? this.maxContextTokens,
      log: logAutoCompactEvent,
    }).autoCompact!)(input);
  }

  async recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision> {
    if (this.compaction?.recovery) {
      return this.compaction.recovery.decide(input);
    }
    // Fallback: inline logic when no ContextOverflowRecovery is injected.
    if (input.error.recoverableViaImageStrip) {
      return {
        type: "strip_images_and_retry",
        reason: "multimodal-processor-error",
      };
    }
    if (input.error.code === "image_too_large") {
      return {
        type: "strip_images_and_retry",
        reason: "image-too-large",
      };
    }
    const isContextError =
      input.error.code === "prompt_too_long" ||
      input.error.code === "context_overflow" ||
      input.error.recoverableViaCompact === true;
    if (!isContextError) {
      return {
        type: "give_up",
        reason: `non_recoverable_model_error:${input.error.code}`,
      };
    }
    if (input.hasAttemptedCompact) {
      return {
        type: "give_up",
        reason: "ptl-exhausted-after-two-attempts",
      };
    }
    return {
      type: "truncate_head_and_retry",
      keepRatio: this.truncateFirstKeepRatio,
      reason: "ptl-first-attempt",
    };
  }

  private trackPromptCacheSession(sessionId: string): void {
    if (sessionId) this.promptCacheSessions.add(sessionId);
  }
}

function insertBeforeLatestUserRequest(
  messages: CanonicalMessage[],
  additions: CanonicalMessage[],
): CanonicalMessage[] {
  if (additions.length === 0) return messages;
  let insertionIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserRequestMessage(messages[index]!)) {
      insertionIndex = index;
      break;
    }
  }
  return [
    ...messages.slice(0, insertionIndex),
    ...additions,
    ...messages.slice(insertionIndex),
  ];
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isAlwaysOnSession(sessionId: string): boolean {
  return [
    "always-on/discovery:",
    "always-on/workspace:",
    "always-on/execute:",
    "always-on/report:",
    "always-on/apply:",
  ].some((prefix) => sessionId.startsWith(prefix));
}

function instructionScopeDescription(scope: InstructionScope): string {
  switch (scope) {
    case "managed":
      return " (managed instructions, set by administrator)";
    case "user":
      return " (user's global instructions for all projects)";
    case "project":
      return " (project instructions, checked into the codebase)";
    case "project-rules":
      return " (project rule, checked into the codebase)";
    case "local":
      return " (user's private project instructions, not checked in)";
  }
}

function extractRecentUserText(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        return block.text;
      }
    }
  }
  return undefined;
}

function logAutoCompactEvent(
  stage: string,
  context: { sessionId?: string; turnId?: string },
  details: Record<string, unknown>,
): void {
  const payload = {
    sessionId: context.sessionId ?? "",
    turnId: context.turnId ?? "",
    ...details,
  };
  try {
    console.warn(`[context:auto-compact] ${stage} ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`[context:auto-compact] ${stage}`);
  }
}
