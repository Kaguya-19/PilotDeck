import { createNodeSessionCatalog } from "../catalog/NodeSessionCatalog.js";
import type { SessionCatalogPort } from "../catalog/SessionCatalogPort.js";
import { nodeProjectSessionForkPort } from "../fork/NodeProjectSessionForkPort.js";
import type { ProjectSessionForkPort } from "../fork/ProjectSessionForkPort.js";
import { nodeProjectSessionReplacementPort } from "../replacement/NodeProjectSessionReplacementPort.js";
import type {
  ProjectSessionReplacementPort,
  ProjectSessionReplacementRecoveryResult,
} from "../replacement/ProjectSessionReplacementPort.js";
import { createNodeSessionSearchPort } from "../search/NodeSessionSearchPort.js";
import type { SessionSearchPort } from "../search/SessionSearchPort.js";
import {
  nodeProjectSessionStorageProvider,
  type ProjectSessionPersistenceProvider,
  type ProjectSessionStorageProvider,
} from "./ProjectSessionStorageProvider.js";

export type ProjectSessionDataPlane = Readonly<{
  persistence: ProjectSessionPersistenceProvider;
  catalog: SessionCatalogPort;
  fork: ProjectSessionForkPort;
  replacement: ProjectSessionReplacementPort;
  search: SessionSearchPort;
}>;

export type CreateProjectSessionDataPlaneOptions = {
  persistenceProvider?: ProjectSessionPersistenceProvider;
  /** @deprecated Compatibility aggregate for pre-data-plane integrations. */
  storageProvider?: ProjectSessionStorageProvider;
  catalog?: SessionCatalogPort;
  fork?: ProjectSessionForkPort;
  replacement?: ProjectSessionReplacementPort;
  search?: SessionSearchPort;
};

export class ProjectSessionCatalogUnavailableError extends Error {
  constructor() {
    super("The selected project session storage provider does not support session catalog reads.");
    this.name = "ProjectSessionCatalogUnavailableError";
  }
}

export class ProjectSessionForkUnavailableError extends Error {
  constructor() {
    super("The selected project session storage provider does not support session fork writes.");
    this.name = "ProjectSessionForkUnavailableError";
  }
}

export class ProjectSessionReplacementUnavailableError extends Error {
  constructor() {
    super("The selected project session storage provider does not support replacement transactions.");
    this.name = "ProjectSessionReplacementUnavailableError";
  }
}

export class ProjectSessionSearchUnavailableError extends Error {
  constructor() {
    super("The selected project session storage provider does not support session search.");
    this.name = "ProjectSessionSearchUnavailableError";
  }
}

/** Resolve the complete application data plane once at composition startup. */
export function createProjectSessionDataPlane(
  options: CreateProjectSessionDataPlaneOptions = {},
): ProjectSessionDataPlane {
  const persistence = options.persistenceProvider
    ?? options.storageProvider
    ?? nodeProjectSessionStorageProvider;
  const legacy = options.storageProvider
    && (!options.persistenceProvider || options.persistenceProvider === options.storageProvider)
    ? options.storageProvider
    : undefined;
  const native = persistence === nodeProjectSessionStorageProvider;

  return Object.freeze({
    persistence,
    catalog: options.catalog ?? legacy?.catalog ?? (native
      ? createNodeSessionCatalog()
      : unavailableProjectSessionCatalog),
    fork: options.fork ?? legacy?.fork ?? (native
      ? nodeProjectSessionForkPort
      : unavailableProjectSessionFork),
    replacement: options.replacement ?? legacy?.replacement ?? (native
      ? nodeProjectSessionReplacementPort
      : unavailableProjectSessionReplacement),
    search: options.search ?? legacy?.search ?? (native
      ? createNodeSessionSearchPort()
      : unavailableProjectSessionSearch),
  });
}

const unavailableProjectSessionCatalog: SessionCatalogPort = Object.freeze({
  async list() {
    throw new ProjectSessionCatalogUnavailableError();
  },
});

const unavailableProjectSessionFork: ProjectSessionForkPort = Object.freeze({
  async fork() {
    throw new ProjectSessionForkUnavailableError();
  },
});

const unavailableProjectSessionReplacement: ProjectSessionReplacementPort = Object.freeze({
  async prepare() {
    throw new ProjectSessionReplacementUnavailableError();
  },
  async finalize() {
    throw new ProjectSessionReplacementUnavailableError();
  },
  recover(): ProjectSessionReplacementRecoveryResult {
    return { committed: 0, rolledBack: 0, cleaned: 0, skipped: 0, failures: [] };
  },
});

const unavailableProjectSessionSearch: SessionSearchPort = Object.freeze({
  async search(): Promise<never> {
    throw new ProjectSessionSearchUnavailableError();
  },
});
