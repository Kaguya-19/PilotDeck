import type {
  CanonicalMessage,
  CanonicalModelError,
  CanonicalToolSchema,
  CachePlan,
  ModelProtocol,
} from "../../model/index.js";
import type { RuntimeContextSurface } from "../RuntimeContextSurface.js";

/** Diagnostic produced by context runtime; non-fatal except for `severity:"fatal"`. */
export type ContextDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error" | "fatal";
  message: string;
  path?: string;
};

/**
 * Boundary metadata exposed to the agent loop after `prepareForModel`.
 * Lets the loop know which compact boundary (if any) the projection sliced
 * messages from.
 */
export type ContextBoundary = {
  type: "compact" | "microcompact" | "snip";
  /** Number of messages retained after the boundary. */
  retainedMessages: number;
  /** Free-form metadata (compact boundary trigger, preTokens, etc). */
  metadata?: Record<string, unknown>;
};

export type ContextRuntimeSnapshotSection = {
  name: string;
  text: string;
};

export type ContextInstructionSnapshotLayer = {
  scope: string;
  path: string;
  content: string;
};

export type ContextMaterialization = {
  /** Stable request-admission step supplied by the durable context adapter. */
  stepId?: number;
  promptGeneration?: number;
  runtimeContexts: ContextRuntimeSnapshotSection[];
  /** Durable user-role projection of runtimeContexts when that profile is enabled. */
  runtimeContextMessages?: CanonicalMessage[];
  instructionLayers?: ContextInstructionSnapshotLayer[];
};

/** Fully-prepared model context produced by `prepareForModel`. */
export type ModelContext = {
  messages: CanonicalMessage[];
  systemPrompt?: string;
  systemPromptParts: string[];
  tools: CanonicalToolSchema[];
  diagnostics: ContextDiagnostic[];
  boundaries: ContextBoundary[];
  metadata?: Record<string, unknown>;
  /** Structured dynamic facts persisted before the corresponding model request. */
  materialization?: ContextMaterialization;
  /** A4: final three non-system message indices for Anthropic recent3 cache layout. */
  cacheBreakpoints?: number[];
  /** Internal provider-boundary cache plan; never persisted to transcript. */
  cachePlan?: CachePlan;
};

export type ContextPrepareInput = {
  /** Budget-only assembly; do not commit prompt time or cache state. */
  previewOnly?: boolean;
  sessionId: string;
  turnId: string;
  /**
   * Optional durable request-admission identity. Native/direct callers may
   * omit it; the session-owned durable context adapter injects it before the
   * provider assembles a model request.
   */
  stepId?: number;
  cwd: string;
  abortSignal?: AbortSignal;
  /** Profile-selected projection for dynamic runtime context. */
  runtimeContextSurface?: RuntimeContextSurface;
  /** Provider/model identifier. */
  provider: string;
  model: string;
  /** Resolved wire protocol for this provider (cache policy must use this). */
  protocol?: ModelProtocol;
  /** Whether this concrete model explicitly supports prompt caching. */
  supportsPromptCache?: boolean;
  /** Permission mode label for prompt assembly. */
  permissionMode: string;
  /** Run mode label for prompt assembly. */
  runMode?: string;
  /** Additional working directories from PermissionContext. */
  additionalWorkingDirectories: string[];
  messages: CanonicalMessage[];
  tools: CanonicalToolSchema[];
  /** Optional full system-prompt override. */
  customSystemPrompt?: string;
  /** Optional system-prompt addendum appended after the base prompt. */
  appendSystemPrompt?: string;
  /** Maximum messages retained when no compact boundary is in play. */
  maxMessages?: number;
};

export type ContextToolResultInput = {
  sessionId: string;
  turnId: string;
  /** New tool result blocks projected by the agent loop. */
  toolResultMessage: CanonicalMessage;
  /** Supplemental user-role media messages emitted after the tool result. */
  supplementalMessages?: ContextSupplementalToolResultMessage[];
  messages: CanonicalMessage[];
};

export type ContextSupplementalToolResultMessage = {
  toolCallId: string;
  message: CanonicalMessage;
};

export type ContextToolResultResult = {
  messages: CanonicalMessage[];
  appendedMessages?: CanonicalMessage[];
  diagnostics: ContextDiagnostic[];
};

export type ContextRecoveryInput = {
  sessionId: string;
  turnId: string;
  error: CanonicalModelError;
  messages: CanonicalMessage[];
  /** Set to true after the loop already ran one truncate-and-retry cycle. */
  hasAttemptedCompact: boolean;
};

export type ContextRecoveryDecision =
  | { type: "truncate_head_and_retry"; keepRatio: number; reason: string }
  | { type: "adjust_output_and_retry"; maxOutputTokens: number; reason: string; scope?: "hard_cap" | "attempt" }
  | { type: "compact_and_retry"; maxContextTokens?: number; maxOutputTokens?: number; reason: string }
  | { type: "strip_images_and_retry"; reason: string }
  | { type: "give_up"; reason: string };

/**
 * Hand-off after a turn finishes (success, failure, or aborted). When a
 * memory provider is wired into context, this is where the runtime forwards
 * the conversation snapshot to the provider's capture pipeline. The hook is
 * advisory — context implementations without memory simply no-op.
 */
export type ContextCaptureTurnInput = {
  sessionId: string;
  turnId: string;
  /** Whole turn-end message history (not the in-flight projection). */
  messages: CanonicalMessage[];
  /** True if the turn ended in error/abort; false on completed success. */
  errored: boolean;
};

/**
 * Public ContextRuntime contract consumed by the agent loop. The runtime is
 * **not** model-aware — `recoverFromModelError` only returns a decision; the
 * loop is responsible for any model calls (CompactionEngine.summarize) needed
 * to fulfill the decision.
 */
export interface ContextRuntime {
  prepareForModel(input: ContextPrepareInput): Promise<ModelContext>;
  applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult>;
  recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision>;
  /**
   * Optional turn-end hook (memory capture). Implementations without a
   * memory provider should leave this absent so the agent loop can short-
   * circuit. Throwing must not break the turn — implementations swallow.
   */
  captureTurn?(input: ContextCaptureTurnInput): Promise<void>;
}
