import type { SessionCommittedEventSubscription, SessionEventStore } from "../../events/SessionEventStore.js";
import type { AgentTranscriptEntry } from "../../transcript/TranscriptEntry.js";
import { SessionProjectionDriver } from "../SessionProjectionDriver.js";
import {
  createSessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointStore,
} from "./SessionProjectionCheckpointStore.js";

export type SessionProjectionCheckpointBindingOptions = {
  sessionId: string;
  runtime: SessionEventStore;
  projections: SessionProjectionDriver;
  store: SessionProjectionCheckpointStore;
  onError?: (error: unknown) => void;
};

export class SessionProjectionCheckpointBinding {
  private readonly subscription: SessionCommittedEventSubscription;
  private writeTail: Promise<void> = Promise.resolve();
  private activeValue = true;

  constructor(private readonly options: SessionProjectionCheckpointBindingOptions) {
    this.subscription = options.runtime.subscribe((entry) => {
      if (entry.type === "turn_result") this.schedule();
    });
  }

  get active(): boolean {
    return this.activeValue;
  }

  async flush(): Promise<void> {
    if (!this.activeValue) return;
    this.schedule();
    await this.writeTail;
  }

  async dispose(): Promise<void> {
    if (!this.activeValue) return;
    this.activeValue = false;
    this.subscription.dispose();
    await this.writeTail;
  }

  private schedule(): void {
    if (!this.activeValue) return;
    const write = this.writeTail.then(() => this.captureAndSave());
    this.writeTail = write.catch((error) => {
      try {
        this.options.onError?.(error);
      } catch {
        // Cache diagnostics must not make a disposable projection cache authoritative.
      }
    });
  }

  private async captureAndSave(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const readResult = await this.options.runtime.read();
      const projectionAsOf = this.options.projections.snapshot([]).asOfSequence;
      const checkpoint = this.options.projections.checkpoint();
      const logAsOf = lastSequence(readResult.entries);
      if (projectionAsOf !== logAsOf) continue;

      await this.options.store.save(createSessionProjectionCheckpointEnvelope(
        this.options.sessionId,
        projectionAsOf,
        checkpoint,
        readResult.entries,
      ));
      return;
    }
    throw new Error(`Could not capture a consistent projection checkpoint for ${this.options.sessionId}.`);
  }
}

function lastSequence(entries: readonly AgentTranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, entry.sequence), -1);
}
