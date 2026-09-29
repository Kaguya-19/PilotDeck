export {
  AGENT_TRANSCRIPT_PROJECTION_NAMES,
  createAgentTranscriptProjectionRegistry,
  findLastCompactBoundaryIndex,
  projectAgentTranscriptEntries,
  projectSubagentReferences,
  registerAgentTranscriptProjections,
  type AgentTranscriptProjectionResult,
  type SubagentReferenceProjectionResult,
} from "./AgentTranscriptProjections.js";
export { createDefaultSessionProjectionRegistry } from "./BuiltinSessionProjections.js";
export {
  FILE_HISTORY_PROJECTION_NAMES,
  createFileHistoryProjectionRegistry,
  projectFileHistorySnapshots,
  registerFileHistoryProjections,
  type FileHistorySnapshotProjectionResult,
} from "./FileHistoryProjection.js";
export {
  SessionProjectionDriver,
  type SessionProjectionDriverOptions,
} from "./SessionProjectionDriver.js";
export { SessionProjectionRegistry } from "./SessionProjectionRegistry.js";
export {
  WEB_HISTORY_PROJECTION_NAMES,
  createWebHistoryProjectionRegistry,
  projectWebHistory,
  registerWebHistoryProjections,
  type IndexedCompactTokenBudget,
  type IndexedWebTokenUsage,
  type WebHistoryProjectionResult,
  type WebTokenUsageProjectionResult,
} from "./WebHistoryProjections.js";
export type {
  SessionProjectionDefinition,
  SessionProjectionChange,
  SessionProjectionChangeSubscription,
  SessionProjectionCheckpoint,
  SessionProjectionCheckpointRow,
  SessionProjectionDescriptor,
  SessionProjectionReduceContext,
  SessionProjectionRegistration,
  SessionProjectionRegistryChange,
  SessionProjectionRegistrySubscription,
  SessionProjectionReplayContext,
  SessionProjectionSnapshot,
} from "./SessionProjection.js";
export { requireSessionProjectionValue } from "./SessionProjection.js";
export * from "./checkpoint/index.js";
