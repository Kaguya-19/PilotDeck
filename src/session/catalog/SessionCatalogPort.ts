/**
 * Read-only session catalog boundary for application consumers.
 *
 * The catalog does not own SessionRuntime, transcript writes, projection
 * state, or retention. It only provides an index-like view over a project's
 * already durable sessions.
 */
export type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  parentSessionId?: string;
  forkedFromTurnId?: string;
};

export type SessionCatalogListInput = {
  projectRoot: string;
  pilotHome: string;
  limit?: number;
  offset?: number;
  includeInternal?: boolean;
};

export type SessionCatalogPort = {
  list(input: SessionCatalogListInput): Promise<SessionInfo[]>;
};
