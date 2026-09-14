import {
  createProjectSessionCatalog,
  type SessionCatalogPort,
} from "../catalog/index.js";
import type { ProjectSessionStorageProvider } from "../storage/ProjectSessionStorageProvider.js";
import {
  createProjectSessionTranscriptReader,
} from "./ProjectSessionTranscriptReader.js";
import type { SessionTranscriptReaderPort } from "./SessionTranscriptReaderPort.js";

/** Application-selected read-only session capabilities for one durable backend. */
export type ProjectSessionReadSideBundle = Readonly<{
  catalog: SessionCatalogPort;
  transcriptReader: SessionTranscriptReaderPort;
}>;

export type CreateProjectSessionReadSideBundleOptions = {
  /** Durable backend used for default catalog and transcript-reader selection. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Explicit application override for project/session enumeration. */
  sessionCatalog?: SessionCatalogPort;
  /** Explicit application override for exact transcript reads and digest projection. */
  sessionTranscriptReader?: SessionTranscriptReaderPort;
};

/**
 * Composes the two existing read-side Definitions from one selected durable
 * backend. It deliberately owns no SessionRuntime, persistence instance,
 * projection driver, search, retention, or write transaction.
 */
export function createProjectSessionReadSideBundle(
  options: CreateProjectSessionReadSideBundleOptions = {},
): ProjectSessionReadSideBundle {
  const storageOptions = options.storageProvider ? { storageProvider: options.storageProvider } : {};
  return Object.freeze({
    catalog: options.sessionCatalog ?? createProjectSessionCatalog(storageOptions),
    transcriptReader: options.sessionTranscriptReader
      ?? createProjectSessionTranscriptReader(storageOptions),
  });
}
