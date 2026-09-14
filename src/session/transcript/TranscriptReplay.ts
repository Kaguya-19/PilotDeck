import {
  findLastCompactBoundaryIndex,
  projectAgentTranscriptEntries,
  type AgentTranscriptProjectionResult,
} from "../projection/AgentTranscriptProjections.js";
import type { AgentTranscriptEntry } from "./TranscriptEntry.js";

export type AgentTranscriptReplayResult = AgentTranscriptProjectionResult;

export { findLastCompactBoundaryIndex };

export function replayTranscriptEntries(entries: AgentTranscriptEntry[]): AgentTranscriptReplayResult {
  return projectAgentTranscriptEntries(entries);
}
