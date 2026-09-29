import type {
  ExplicitModelSelection,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelSelection,
} from "../../gateway/protocol/types.js";

/** Exact durable session location for a model preference. */
export type SessionModelSelectionScope = {
  projectKey: string;
  sessionKey: string;
};

/**
 * Definition for reading and mutating a session's model preference.
 * Session storage remains the durable owner; this port deliberately does not
 * expose transcript entries or persistence implementation details.
 */
export interface SessionModelSelectionPort {
  read(input: SessionModelSelectionScope): Promise<SessionModelSelection | undefined>;
  write(input: SessionModelSelectionScope & { selection: SessionModelSelection }): Promise<void>;
  clear(input: SessionModelSelectionScope): Promise<void>;
}

/** Model-catalog policy consumed by Gateway session-model composition. */
export interface SessionModelSelectionPolicy {
  listCatalog(input: ModelCatalogListInput): ModelCatalogListResult;
  normalizeSelection(selection: SessionModelSelection): SessionModelSelection;
  restoreSelection(projectKey: string, selection: SessionModelSelection): SessionModelSelection;
  validateSelection(projectKey: string, selection: SessionModelSelection): void;
  validateExplicit(projectKey: string, selection: ExplicitModelSelection): void;
  resolveDefault(projectKey: string): {
    provider: string;
    model: string;
    source: "router" | "default";
  };
}
