import {
  parseSessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointStore,
} from "./SessionProjectionCheckpointStore.js";

export class InMemorySessionProjectionCheckpointStore implements SessionProjectionCheckpointStore {
  private readonly checkpoints = new Map<string, SessionProjectionCheckpointEnvelope>();

  async load(sessionId: string): Promise<SessionProjectionCheckpointEnvelope | undefined> {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint
      ? parseSessionProjectionCheckpointEnvelope(structuredClone(checkpoint), sessionId)
      : undefined;
  }

  async save(envelope: SessionProjectionCheckpointEnvelope): Promise<void> {
    const stable = parseSessionProjectionCheckpointEnvelope(
      structuredClone(envelope),
      envelope.sessionId,
    );
    this.checkpoints.set(envelope.sessionId, stable);
  }
}
