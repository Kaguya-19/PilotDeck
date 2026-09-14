import type { AgentFileSnapshotRecordedTranscriptEntry, AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import { checkpointRecord, checkpointTranscriptEntries } from "./SessionProjectionCheckpointCodec.js";
import type { SessionProjectionDefinition } from "./SessionProjection.js";
import { SessionProjectionRegistry } from "./SessionProjectionRegistry.js";

export const FILE_HISTORY_PROJECTION_NAMES = {
  snapshots: "file-history.snapshots",
} as const;

export type FileHistorySnapshotProjectionResult = AgentFileSnapshotRecordedTranscriptEntry[];

type FileHistoryProjectionState = {
  entries: AgentFileSnapshotRecordedTranscriptEntry[];
  indexByMessageId: Map<string, number>;
};

const fileHistorySnapshotProjection: SessionProjectionDefinition<
  FileHistoryProjectionState,
  FileHistorySnapshotProjectionResult
> = {
  name: FILE_HISTORY_PROJECTION_NAMES.snapshots,
  version: 1,
  create: () => ({ entries: [], indexByMessageId: new Map() }),
  reduce(state, entry) {
    if (entry.type !== "file_snapshot_recorded") return state;

    const existingIndex = state.indexByMessageId.get(entry.messageId);
    if (existingIndex === undefined) {
      const indexByMessageId = new Map(state.indexByMessageId);
      indexByMessageId.set(entry.messageId, state.entries.length);
      return {
        entries: [...state.entries, entry],
        indexByMessageId,
      };
    }

    const entries = [...state.entries];
    entries[existingIndex] = entry;
    return { entries, indexByMessageId: state.indexByMessageId };
  },
  finalize: (state) => state.entries,
  checkpoint: {
    encode: (state) => ({ entries: state.entries }),
    decode(value) {
      const record = checkpointRecord(value, "file history");
      const entries = checkpointTranscriptEntries(
        record.entries,
        ["file_snapshot_recorded"],
        "file history entries",
      );
      const indexByMessageId = new Map<string, number>();
      entries.forEach((entry, index) => indexByMessageId.set(entry.messageId, index));
      return { entries, indexByMessageId };
    },
  },
};

export function registerFileHistoryProjections(registry: SessionProjectionRegistry): void {
  registry.register(fileHistorySnapshotProjection);
}

export function createFileHistoryProjectionRegistry(): SessionProjectionRegistry {
  const registry = new SessionProjectionRegistry();
  registerFileHistoryProjections(registry);
  return registry;
}

export function projectFileHistorySnapshots(
  entries: readonly AgentTranscriptEntry[],
  registry = createFileHistoryProjectionRegistry(),
): FileHistorySnapshotProjectionResult {
  return registry.project<FileHistorySnapshotProjectionResult>(
    FILE_HISTORY_PROJECTION_NAMES.snapshots,
    entries,
  );
}
