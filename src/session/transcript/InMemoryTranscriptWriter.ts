import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { InMemorySessionEventStore } from "../events/InMemorySessionEventStore.js";
import type {
  SequencedSessionEventStoreOptions,
  SessionEventDraft,
} from "../events/SessionEventStore.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentTranscriptEntry,
  FileHistorySnapshotRecord,
  SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentStatusMessageInput } from "./TranscriptWriter.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type InMemoryTranscriptEntry = AgentTranscriptEntry;

export type InMemoryTranscriptWriterOptions = SequencedSessionEventStoreOptions & {
  eventStore?: InMemorySessionEventStore;
};

export class InMemoryTranscriptWriter implements AgentTranscriptWriter {
  private readonly eventStore: InMemorySessionEventStore;

  constructor(options: InMemoryTranscriptWriterOptions = {}) {
    this.eventStore = options.eventStore ?? new InMemorySessionEventStore(options);
  }

  get entries(): InMemoryTranscriptEntry[] {
    return this.eventStore.entries;
  }

  recordSessionEvent(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    return this.append(sessionId, turnId, event);
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, {
      type: "accepted_input",
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "durable_message", message });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: AgentStatusMessageInput,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "agent_status_message", ...status });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "file_artifacts", artifacts });
  }

  recordFileHistorySnapshot(
    sessionId: string,
    turnId: string,
    snapshot: FileHistorySnapshotRecord,
    snapshotKind: "create" | "update",
  ): void | Promise<void> {
    return this.append(sessionId, turnId, {
      type: "file_snapshot_recorded",
      snapshotKind,
      ...snapshot,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "turn_result", result });
  }

  recordSessionMetadata(
    sessionId: string,
    turnId: string,
    metadata: SessionMetadataValue,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "session_metadata", metadata });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "control_boundary", boundary });
  }

  recordCompactionReplacement(
    sessionId: string,
    turnId: string,
    boundary: Extract<AgentControlBoundaryTranscriptEntry["boundary"], { kind: "compact"; subtype: "compact_boundary" }>,
    messages: CanonicalMessage[],
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "control_boundary",
      boundary: {
        ...boundary,
        replacementMessages: messages.map((message) => structuredClone(message)),
      },
    });
  }

  recordEntry(entry: AgentTranscriptEntry): void | Promise<void> {
    return this.eventStore.appendRecorded(entry);
  }

  snapshotState(): AgentTranscriptWriterState {
    return this.eventStore.snapshotState();
  }

  private append(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    return this.eventStore.append(sessionId, turnId, event).then(() => undefined);
  }
}
