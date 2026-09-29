import { JsonlSessionPersistence } from "../persistence/JsonlSessionPersistence.js";
import type { SessionPersistence } from "../persistence/SessionPersistence.js";
import { JsonFileSessionProjectionCheckpointStore } from "../projection/checkpoint/JsonFileSessionProjectionCheckpointStore.js";
import type { SessionProjectionCheckpointStore } from "../projection/checkpoint/SessionProjectionCheckpointStore.js";
import { listProjectSessions } from "./SessionList.js";
import type { SessionCatalogPort } from "../catalog/SessionCatalogPort.js";
import { nodeProjectSessionForkPort } from "../fork/NodeProjectSessionForkPort.js";
import type { ProjectSessionForkPort } from "../fork/ProjectSessionForkPort.js";
import type { ProjectSessionReplacementPort } from "../replacement/ProjectSessionReplacementPort.js";
import { nodeProjectSessionReplacementPort } from "../replacement/NodeProjectSessionReplacementPort.js";
import type { SessionSearchPort } from "../search/SessionSearchPort.js";

/** The storage layout being composed for one durable Agent session. */
export type ProjectSessionStorageKind = "agent" | "subagent";

/** Stable storage identity supplied to a project-session backend provider. */
export type ProjectSessionStorageProviderInput = {
  kind: ProjectSessionStorageKind;
  sessionId: string;
  parentSessionId?: string;
  transcriptPath: string;
  projectionCheckpointPath: string;
};

/** Backend pair selected for one project-session event stream. */
export type ProjectSessionStorageBackends = {
  persistence: SessionPersistence;
  projectionCheckpointStore: SessionProjectionCheckpointStore;
};

/**
 * Selects the persistence and projection-cache providers for one project
 * session. The event runtime, projection driver, restore order, and disposal
 * stay owned by ProjectSessionStorage; providers do not own another Session
 * state machine.
 */
export type ProjectSessionPersistenceProvider = {
  create(input: ProjectSessionStorageProviderInput): ProjectSessionStorageBackends;
};

/**
 * @deprecated Inject persistence and data-plane ports independently through
 * ProjectSessionDataPlane. This aggregate remains for compatibility only.
 */
export type ProjectSessionStorageProvider = ProjectSessionPersistenceProvider & {
  /**
   * Optional project-level catalog owned by the same durable backend.
   *
   * Persistence `create()` only addresses one exact session and cannot infer
   * enumeration semantics for another backend. Application composition must
   * therefore consume this explicit read-side capability rather than scan
   * JSONL files when a non-native provider is selected.
   *
   * @deprecated Inject SessionCatalogPort through ProjectSessionDataPlane.
   */
  readonly catalog?: SessionCatalogPort;
  /**
   * Optional durable fork transaction owned by this same backend.
   * @deprecated Inject ProjectSessionForkPort through ProjectSessionDataPlane.
   */
  readonly fork?: ProjectSessionForkPort;
  /**
   * Optional prepared turn-replacement transaction owned by this backend.
   * @deprecated Inject ProjectSessionReplacementPort through ProjectSessionDataPlane.
   */
  readonly replacement?: ProjectSessionReplacementPort;
  /**
   * Optional project/session text search owned by the same durable backend.
   * @deprecated Inject SessionSearchPort through ProjectSessionDataPlane.
   */
  readonly search?: SessionSearchPort;
};

/** Native filesystem provider used when application composition selects none. */
export const nodeProjectSessionStorageProvider: ProjectSessionStorageProvider = Object.freeze({
  create(input) {
    return {
      persistence: new JsonlSessionPersistence({ path: input.transcriptPath }),
      projectionCheckpointStore: new JsonFileSessionProjectionCheckpointStore({
        path: input.projectionCheckpointPath,
      }),
    };
  },
  catalog: {
    list: listProjectSessions,
  },
  fork: nodeProjectSessionForkPort,
  replacement: nodeProjectSessionReplacementPort,
});
