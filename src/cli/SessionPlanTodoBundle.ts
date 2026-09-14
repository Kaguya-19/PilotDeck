import {
  createNativePlanTodoRuntime,
  type PlanTodoPort,
} from "../plan-todo/index.js";
import type { SessionProjectionDriver } from "../session/projection/SessionProjectionDriver.js";
import type { AgentTranscriptWriter } from "../session/transcript/TranscriptWriter.js";
import {
  createPlanFileManager,
  type PlanFileManager,
  type PlanStoragePort,
} from "../tool/index.js";

export type SessionPlanTodoBundleOptions = {
  sessionKey: string;
  projectRoot: string;
  storage: {
    transcript: AgentTranscriptWriter;
    projections: SessionProjectionDriver;
  };
  planStorage: PlanStoragePort;
};

export type SessionPlanTodoBundleResult = {
  planFileManager: PlanFileManager;
  planTodoManager: PlanTodoPort;
};

/**
 * Composes the existing plan-file and durable plan/todo consumers for one
 * session. Project execution storage and session event/projection ownership
 * remain with their existing providers.
 */
export class SessionPlanTodoBundle {
  constructor(private readonly options: SessionPlanTodoBundleOptions) {}

  compose(): SessionPlanTodoBundleResult {
    return {
      planFileManager: createPlanFileManager({
        projectRoot: this.options.projectRoot,
        storage: this.options.planStorage,
      }),
      planTodoManager: createNativePlanTodoRuntime({
        sessionId: this.options.sessionKey,
        transcript: this.options.storage.transcript,
        projections: this.options.storage.projections,
      }),
    };
  }
}
