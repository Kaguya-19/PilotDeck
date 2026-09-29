import { createNativeGoalRuntime, type GoalPort } from "../goal/index.js";
import type { SessionProjectionDriver } from "../session/projection/SessionProjectionDriver.js";
import type { AgentTranscriptWriter } from "../session/transcript/TranscriptWriter.js";

export type SessionGoalBundleOptions = {
  sessionKey: string;
  storage: {
    transcript: AgentTranscriptWriter;
    projections: SessionProjectionDriver;
  };
  uuid?: () => string;
};

export type SessionGoalBundleResult = { goalManager: GoalPort };

/** Composes the session-bound durable goal runtime over the shared event log. */
export class SessionGoalBundle {
  constructor(private readonly options: SessionGoalBundleOptions) {}

  compose(): SessionGoalBundleResult {
    return {
      goalManager: createNativeGoalRuntime({
        sessionId: this.options.sessionKey,
        transcript: this.options.storage.transcript,
        projections: this.options.storage.projections,
        uuid: this.options.uuid,
      }),
    };
  }
}
