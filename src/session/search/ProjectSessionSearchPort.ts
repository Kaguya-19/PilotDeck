import type { ProjectSessionStorageProvider } from "../storage/ProjectSessionStorageProvider.js";
import { createProjectSessionDataPlane } from "../storage/ProjectSessionDataPlane.js";
import type { SessionSearchPort } from "./SessionSearchPort.js";

export { ProjectSessionSearchUnavailableError } from "../storage/ProjectSessionDataPlane.js";

export type CreateProjectSessionSearchPortOptions = {
  /** Application-selected durable backend; native JSONL remains the default. */
  storageProvider?: ProjectSessionStorageProvider;
};

/** Raised when an explicitly selected backend cannot provide text search. */
/**
 * @deprecated Resolve ProjectSessionDataPlane once in application composition.
 *
 * Select the search capability contributed by the application's durable
 * backend. Search is read-only and never owns SessionRuntime or retention.
 */
export function createProjectSessionSearchPort(
  options: CreateProjectSessionSearchPortOptions = {},
): SessionSearchPort {
  return createProjectSessionDataPlane(options).search;
}
