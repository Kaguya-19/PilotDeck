import type { CanonicalThinkingConfig, CanonicalToolChoice, MultimodalConstraints } from "../../model/index.js";
import type { PermissionContext, PermissionMode } from "../../permission/index.js";
import type { PilotDeckCustomErrorHint, PilotDeckCustomToolValidator } from "../../tool/index.js";

export type AgentRuntimeConfig = {
  provider: string;
  model: string;
  /** Multimodal constraints of the selected model (absent = text-only). */
  modelMultimodal?: MultimodalConstraints;
  cwd: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: CanonicalThinkingConfig;
  toolChoice?: CanonicalToolChoice;
  maxContextMessages?: number;
  stopOnStructuredOutput?: boolean;
  permissionMode: PermissionMode;
  /** Who last set the current mode: "user" (UI/CLI) or "tool" (enter_plan_mode). */
  permissionModeOrigin?: "user" | "tool";
  /** Saved mode before entering plan mode, restored on exit. */
  permissionModeBeforePlan?: PermissionMode;
  permissionContext: PermissionContext;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  metadata?: Record<string, unknown>;
  /** Marks the agent as a subagent. RouterRuntime uses this for sticky/scenario decisions. */
  isSubagent?: boolean;
  /**
   * Subagent fork depth — incremented on each level of `agent` tool fork.
   * Top-level agent runs at depth 0; `agent` tool refuses to spawn another
   * subagent once `subagentDepth >= maxSubagentDepth`. Default 0.
   */
  subagentDepth?: number;
  /**
   * Cap on `subagentDepth`. Defaults to 1 (one level of forking allowed,
   * but no nested forks). Increase only when intentional.
   */
  maxSubagentDepth?: number;
  /** Optional timeout budget for forked subagents spawned by the `agent` tool. */
  subagentTimeoutMs?: number;
  /** Enable automatic JSON self-correction retry on invalid_tool_arguments. Default false. */
  jsonSelfCorrect?: boolean;
  /**
   * Maximum number of tool calls the agent will execute from a single model
   * turn. Extra calls receive invalid_tool_input results asking the model to
   * split work across turns. Default 32.
   */
  maxToolCallsPerTurn?: number;
  /**
   * Maximum number of concurrency-safe tool calls to execute at once within a
   * single turn. Default 8.
   */
  maxConcurrentToolCalls?: number;
  /**
   * Coalesce identical read-only, concurrency-safe tool calls emitted in the
   * same turn. Default true.
   */
  dedupeSameTurnReadOnlyToolCalls?: boolean;
  /**
   * Tool call format hint — controls which self-correct prompt is used.
   * "auto" (default) detects from text markers; explicit values select a
   * specific format from the registry (e.g. "qwen_xml", "hermes", "dsml").
   */
  toolCallFormat?: string;
  /**
   * User-defined tool name aliases for fuzzy name repair.
   * Maps common model-emitted names to canonical tool names.
   * Example: { "search": "grep", "cat": "read" }
   */
  toolAliases?: Record<string, string>;
  /** Optional host/user validators that run before permission checks. */
  customToolValidators?: PilotDeckCustomToolValidator[];
  /** Optional host/user recovery hints appended to model-visible tool errors. */
  customErrorHints?: PilotDeckCustomErrorHint[];
  /**
   * The agent's default-model context window (tokens). Passed through so the
   * loop can compare it with the routed model's window and trigger a
   * post-routing compaction pass when the routed window is smaller.
   */
  maxContextTokens?: number;
};
