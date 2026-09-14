import { listProjectSessions } from "../storage/SessionList.js";
import type { SessionCatalogPort } from "./SessionCatalogPort.js";

/** Native JSONL-backed provider for the read-only SessionCatalogPort. */
export function createNodeSessionCatalog(): SessionCatalogPort {
  return {
    list(input) {
      return listProjectSessions(input);
    },
  };
}
