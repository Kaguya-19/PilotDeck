import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type {
  AgentFileArtifactsTranscriptEntry,
  AgentStatusMessageTranscriptEntry,
  AgentTranscriptEntry,
  AgentTurnResultTranscriptEntry,
} from "../transcript/TranscriptEntry.js";
import {
  requireSessionProjectionValue,
  type SessionProjectionDefinition,
} from "./SessionProjection.js";
import {
  checkpointCanonicalUsage,
  checkpointInteger,
  checkpointRecord,
  checkpointStringArray,
  checkpointTranscriptEntries,
} from "./SessionProjectionCheckpointCodec.js";
import { SessionProjectionDriver } from "./SessionProjectionDriver.js";
import { SessionProjectionRegistry } from "./SessionProjectionRegistry.js";

export const WEB_HISTORY_PROJECTION_NAMES = {
  fileArtifacts: "web-history.file-artifacts",
  agentStatuses: "web-history.agent-statuses",
  turnErrors: "web-history.turn-errors",
  tokenUsage: "web-history.token-usage",
  incompleteTurns: "web-history.incomplete-turns",
} as const;

export type IndexedWebTokenUsage = {
  index: number;
  usage: Record<string, unknown>;
};

export type IndexedCompactTokenBudget = {
  index: number;
  preTokens?: number;
  postTokens: number;
  messagesSummarized?: number;
};

export type WebTokenUsageProjectionResult = {
  latestContextBudget?: IndexedWebTokenUsage;
  latestCompactBudget?: IndexedCompactTokenBudget;
  latestTurnUsage?: CanonicalUsage;
};

export type WebHistoryProjectionResult = {
  fileArtifacts: AgentFileArtifactsTranscriptEntry[];
  agentStatuses: AgentStatusMessageTranscriptEntry[];
  turnErrors: AgentTurnResultTranscriptEntry[];
  tokenUsage: WebTokenUsageProjectionResult;
  incompleteTurnIds: string[];
};

type FileArtifactState = {
  entries: AgentFileArtifactsTranscriptEntry[];
  turnsWithToolResults: Set<string>;
};

type TurnErrorState = {
  entries: AgentTurnResultTranscriptEntry[];
  visibleFailureStatusTurnIds: Set<string>;
};

type IncompleteTurnState = {
  durableMessageTurnIds: string[];
  completedTurnIds: Set<string>;
};

const fileArtifactProjection: SessionProjectionDefinition<
  FileArtifactState,
  AgentFileArtifactsTranscriptEntry[]
> = {
  name: WEB_HISTORY_PROJECTION_NAMES.fileArtifacts,
  version: 1,
  create: () => ({ entries: [], turnsWithToolResults: new Set() }),
  reduce(state, entry) {
    if (isDurableMessageEntry(entry) && messageContainsToolResult(entry.message)) {
      return {
        ...state,
        turnsWithToolResults: new Set([...state.turnsWithToolResults, entry.turnId]),
      };
    }
    if (entry.type === "file_artifacts" && entry.artifacts.length > 0) {
      return { ...state, entries: [...state.entries, entry] };
    }
    return state;
  },
  finalize(state) {
    return state.entries.flatMap((entry) => {
      const artifacts = state.turnsWithToolResults.has(entry.turnId)
        ? entry.artifacts
        : entry.artifacts.filter((artifact) => artifact.source !== "workspace_diff");
      return artifacts.length > 0 ? [{ ...entry, artifacts: [...artifacts] }] : [];
    });
  },
  checkpoint: {
    encode: (state) => ({
      entries: state.entries,
      turnsWithToolResults: [...state.turnsWithToolResults],
    }),
    decode(value) {
      const record = checkpointRecord(value, "web file artifacts");
      return {
        entries: checkpointTranscriptEntries(
          record.entries,
          ["file_artifacts"],
          "web file artifact entries",
        ),
        turnsWithToolResults: new Set(checkpointStringArray(
          record.turnsWithToolResults,
          "web file artifact tool-result turns",
        )),
      };
    },
  },
};

const agentStatusProjection: SessionProjectionDefinition<AgentStatusMessageTranscriptEntry[]> = {
  name: WEB_HISTORY_PROJECTION_NAMES.agentStatuses,
  version: 1,
  create: () => [],
  reduce(state, entry) {
    if (entry.type === "agent_status_message") {
      return [...state, entry];
    }
    return state;
  },
  checkpoint: {
    encode: (state) => state,
    decode: (value) => checkpointTranscriptEntries(
      value,
      ["agent_status_message"],
      "web agent statuses",
    ),
  },
};

const turnErrorProjection: SessionProjectionDefinition<
  TurnErrorState,
  AgentTurnResultTranscriptEntry[]
> = {
  name: WEB_HISTORY_PROJECTION_NAMES.turnErrors,
  version: 1,
  create: () => ({ entries: [], visibleFailureStatusTurnIds: new Set() }),
  reduce(state, entry) {
    if (
      entry.type === "agent_status_message" &&
      entry.kind === "error" &&
      entry.detail?.visible !== false
    ) {
      return {
        ...state,
        visibleFailureStatusTurnIds: new Set([
          ...state.visibleFailureStatusTurnIds,
          entry.turnId,
        ]),
      };
    }
    if (entry.type === "turn_result" && entry.result.type === "error") {
      return { ...state, entries: [...state.entries, entry] };
    }
    return state;
  },
  finalize(state) {
    return state.entries.filter((entry) => !state.visibleFailureStatusTurnIds.has(entry.turnId));
  },
  checkpoint: {
    encode: (state) => ({
      entries: state.entries,
      visibleFailureStatusTurnIds: [...state.visibleFailureStatusTurnIds],
    }),
    decode(value) {
      const record = checkpointRecord(value, "web turn errors");
      return {
        entries: checkpointTranscriptEntries(
          record.entries,
          ["turn_result"],
          "web turn error entries",
        ).filter((entry) => {
          if (entry.result.type !== "error") {
            throw new TypeError("Web turn error checkpoint contains a non-error result.");
          }
          return true;
        }),
        visibleFailureStatusTurnIds: new Set(checkpointStringArray(
          record.visibleFailureStatusTurnIds,
          "web visible failure turns",
        )),
      };
    },
  },
};

const tokenUsageProjection: SessionProjectionDefinition<WebTokenUsageProjectionResult> = {
  name: WEB_HISTORY_PROJECTION_NAMES.tokenUsage,
  version: 1,
  create: () => ({}),
  reduce(state, entry, { index }) {
    const contextBudget = projectContextBudget(entry, index);
    if (contextBudget) {
      return { ...state, latestContextBudget: contextBudget };
    }

    const compactBudget = projectCompactBudget(entry, index);
    if (compactBudget) {
      return { ...state, latestCompactBudget: compactBudget };
    }

    if (entry.type === "turn_result" && hasPositiveUsage(entry.result.usage)) {
      return { ...state, latestTurnUsage: { ...entry.result.usage } };
    }
    return state;
  },
  checkpoint: {
    encode: (state) => state,
    decode: decodeWebTokenUsage,
  },
};

const incompleteTurnProjection: SessionProjectionDefinition<IncompleteTurnState, string[]> = {
  name: WEB_HISTORY_PROJECTION_NAMES.incompleteTurns,
  version: 1,
  create: () => ({ durableMessageTurnIds: [], completedTurnIds: new Set() }),
  reduce(state, entry) {
    if (entry.type === "turn_result") {
      return {
        ...state,
        completedTurnIds: new Set([...state.completedTurnIds, entry.turnId]),
      };
    }
    if (!isDurableMessageEntry(entry) || state.durableMessageTurnIds.includes(entry.turnId)) {
      return state;
    }
    return {
      ...state,
      durableMessageTurnIds: [...state.durableMessageTurnIds, entry.turnId],
    };
  },
  finalize(state) {
    return state.durableMessageTurnIds.filter((turnId) => !state.completedTurnIds.has(turnId));
  },
  checkpoint: {
    encode: (state) => ({
      durableMessageTurnIds: state.durableMessageTurnIds,
      completedTurnIds: [...state.completedTurnIds],
    }),
    decode(value) {
      const record = checkpointRecord(value, "web incomplete turns");
      return {
        durableMessageTurnIds: checkpointStringArray(
          record.durableMessageTurnIds,
          "web durable-message turns",
        ),
        completedTurnIds: new Set(checkpointStringArray(
          record.completedTurnIds,
          "web completed turns",
        )),
      };
    },
  },
};

export function registerWebHistoryProjections(registry: SessionProjectionRegistry): void {
  registry.register(fileArtifactProjection);
  registry.register(agentStatusProjection);
  registry.register(turnErrorProjection);
  registry.register(tokenUsageProjection);
  registry.register(incompleteTurnProjection);
}

export function createWebHistoryProjectionRegistry(): SessionProjectionRegistry {
  const registry = new SessionProjectionRegistry();
  registerWebHistoryProjections(registry);
  return registry;
}

export function projectWebHistory(
  entries: readonly AgentTranscriptEntry[],
  registry = createWebHistoryProjectionRegistry(),
): WebHistoryProjectionResult {
  const driver = new SessionProjectionDriver({ registry, entries });
  try {
    const snapshot = driver.snapshot(Object.values(WEB_HISTORY_PROJECTION_NAMES));
    return {
      fileArtifacts: requireSessionProjectionValue<AgentFileArtifactsTranscriptEntry[]>(
        snapshot,
        WEB_HISTORY_PROJECTION_NAMES.fileArtifacts,
      ),
      agentStatuses: requireSessionProjectionValue<AgentStatusMessageTranscriptEntry[]>(
        snapshot,
        WEB_HISTORY_PROJECTION_NAMES.agentStatuses,
      ),
      turnErrors: requireSessionProjectionValue<AgentTurnResultTranscriptEntry[]>(
        snapshot,
        WEB_HISTORY_PROJECTION_NAMES.turnErrors,
      ),
      tokenUsage: requireSessionProjectionValue<WebTokenUsageProjectionResult>(
        snapshot,
        WEB_HISTORY_PROJECTION_NAMES.tokenUsage,
      ),
      incompleteTurnIds: requireSessionProjectionValue<string[]>(
        snapshot,
        WEB_HISTORY_PROJECTION_NAMES.incompleteTurns,
      ),
    };
  } finally {
    driver.dispose();
  }
}

function isDurableMessageEntry(
  entry: AgentTranscriptEntry,
): entry is AgentTranscriptEntry & { message: CanonicalMessage } {
  return entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message";
}

function messageContainsToolResult(message: CanonicalMessage): boolean {
  return message.content.some(
    (block) => block.type === "tool_result" || block.type === "tool_result_reference",
  );
}

function projectContextBudget(
  entry: AgentTranscriptEntry,
  index: number,
): IndexedWebTokenUsage | undefined {
  if (entry.type !== "agent_status_message" || entry.event !== "context_budget") {
    return undefined;
  }
  const detail = isRecord(entry.detail) ? entry.detail : undefined;
  if (!detail) return undefined;

  const used = positiveNumber(detail.displayUsed) ?? positiveNumber(detail.used);
  const total = positiveNumber(detail.total);
  const effectiveTotal = positiveNumber(detail.effectiveTotal) ?? total;
  if (used === undefined || total === undefined || effectiveTotal === undefined) {
    return undefined;
  }

  return {
    index,
    usage: {
      used,
      ...(positiveNumber(detail.displayUsed) !== undefined
        ? { displayUsed: positiveNumber(detail.displayUsed) }
        : {}),
      ...(positiveNumber(detail.budgetUsed) !== undefined
        ? { budgetUsed: positiveNumber(detail.budgetUsed) }
        : {}),
      total,
      effectiveTotal,
      reservedOutputTokens: positiveNumber(detail.reservedOutputTokens) ?? 0,
      ...(typeof detail.state === "string" ? { state: detail.state } : {}),
      ...(typeof detail.ratio === "number" && Number.isFinite(detail.ratio)
        ? { ratio: detail.ratio }
        : {}),
      source: "history",
      exact: true,
    },
  };
}

function projectCompactBudget(
  entry: AgentTranscriptEntry,
  index: number,
): IndexedCompactTokenBudget | undefined {
  if (
    entry.type !== "control_boundary" ||
    entry.boundary.kind !== "compact" ||
    !("subtype" in entry.boundary) ||
    entry.boundary.subtype !== "compact_boundary"
  ) {
    return undefined;
  }
  const metadata = entry.boundary.compactMetadata;
  const postTokens = positiveNumber(metadata.postTokens);
  if (postTokens === undefined) return undefined;

  return {
    index,
    postTokens,
    ...(positiveNumber(metadata.preTokens) !== undefined
      ? { preTokens: positiveNumber(metadata.preTokens) }
      : {}),
    ...(positiveNumber(metadata.messagesSummarized) !== undefined
      ? { messagesSummarized: positiveNumber(metadata.messagesSummarized) }
      : {}),
  };
}

function hasPositiveUsage(usage: CanonicalUsage | undefined): boolean {
  if (!usage) return false;
  return positiveNumber(usage.inputTokens) !== undefined ||
    positiveNumber(usage.outputTokens) !== undefined ||
    positiveNumber(usage.cacheReadTokens) !== undefined ||
    positiveNumber(usage.cacheWriteTokens) !== undefined ||
    positiveNumber(usage.totalTokens) !== undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeWebTokenUsage(value: unknown): WebTokenUsageProjectionResult {
  const record = checkpointRecord(value, "web token usage");
  const result: WebTokenUsageProjectionResult = {};
  if (record.latestContextBudget !== undefined) {
    const context = checkpointRecord(record.latestContextBudget, "web latest context budget");
    result.latestContextBudget = {
      index: checkpointInteger(context.index, "web latest context budget index"),
      usage: structuredClone(checkpointRecord(context.usage, "web latest context budget usage")),
    };
  }
  if (record.latestCompactBudget !== undefined) {
    const compact = checkpointRecord(record.latestCompactBudget, "web latest compact budget");
    const preTokens = optionalNonNegativeNumber(compact.preTokens, "web latest compact budget preTokens");
    const messagesSummarized = optionalNonNegativeNumber(
      compact.messagesSummarized,
      "web latest compact budget messagesSummarized",
    );
    const postTokens = optionalNonNegativeNumber(
      compact.postTokens,
      "web latest compact budget postTokens",
    );
    if (postTokens === undefined) {
      throw new TypeError("Web latest compact budget postTokens is required.");
    }
    result.latestCompactBudget = {
      index: checkpointInteger(compact.index, "web latest compact budget index"),
      ...(preTokens === undefined ? {} : { preTokens }),
      postTokens,
      ...(messagesSummarized === undefined ? {} : { messagesSummarized }),
    };
  }
  if (record.latestTurnUsage !== undefined) {
    result.latestTurnUsage = checkpointCanonicalUsage(record.latestTurnUsage, "web latest turn usage");
  }
  return result;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} checkpoint is invalid.`);
  }
  return value;
}
