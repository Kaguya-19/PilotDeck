import type { ProjectSessionStorageProvider } from "../storage/ProjectSessionStorageProvider.js";
import { createProjectSessionDataPlane } from "../storage/ProjectSessionDataPlane.js";
import type { SessionCatalogPort } from "./SessionCatalogPort.js";

export { ProjectSessionCatalogUnavailableError } from "../storage/ProjectSessionDataPlane.js";

export type CreateProjectSessionCatalogOptions = {
  /** Application-selected durable backend; JSONL remains the native default. */
  storageProvider?: ProjectSessionStorageProvider;
};

/**
 * Raised when a selected durable backend does not advertise project-level
 * enumeration. Falling back to JSONL in this case could hide sessions or
 * expose stale files from a different backend.
 */
/**
 * @deprecated Resolve ProjectSessionDataPlane once in application composition.
 *
 * Select the catalog contributed by the application's session storage
 * provider. Catalog remains read-only and does not take ownership of
 * SessionRuntime, persistence, projection, or retention policy.
 */
export function createProjectSessionCatalog(
  options: CreateProjectSessionCatalogOptions = {},
): SessionCatalogPort {
  return createProjectSessionDataPlane(options).catalog;
}
