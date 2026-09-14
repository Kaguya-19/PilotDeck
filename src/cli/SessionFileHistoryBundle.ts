import {
  FILE_HISTORY_PROJECTION_NAMES,
  FileHistoryStore,
  requireSessionProjectionValue,
  type AgentProjectSessionStorage,
  type FileHistorySnapshotProjectionResult,
} from "../session/index.js";

export type SessionFileHistoryBundleOptions = {
  sessionKey: string;
  storage: Pick<
    AgentProjectSessionStorage,
    "fileHistoryDir" | "transcript" | "projections"
  >;
  now: () => Date;
};

/**
 * Composes the per-session file-history consumer over existing durable
 * storage. The storage runtime remains the sole event/projection owner.
 */
export class SessionFileHistoryBundle {
  constructor(private readonly options: SessionFileHistoryBundleOptions) {}

  compose(): FileHistoryStore {
    const fileHistory = new FileHistoryStore({
      backupDir: this.options.storage.fileHistoryDir,
      now: this.options.now,
      onSnapshotRecorded: (snapshot, snapshotKind) =>
        this.options.storage.transcript.recordFileHistorySnapshot(
          this.options.sessionKey,
          snapshot.messageId,
          snapshot,
          snapshotKind,
        ),
    });
    const projectionSnapshot = this.options.storage.projections.snapshot([
      FILE_HISTORY_PROJECTION_NAMES.snapshots,
    ]);
    fileHistory.replayFromTranscript(
      requireSessionProjectionValue<FileHistorySnapshotProjectionResult>(
        projectionSnapshot,
        FILE_HISTORY_PROJECTION_NAMES.snapshots,
      ),
    );
    return fileHistory;
  }
}
