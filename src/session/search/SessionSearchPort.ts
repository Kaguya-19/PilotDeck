/**
 * Read-only chat-history search boundary for application consumers.
 *
 * A provider may scan JSONL, query a derived index, or delegate to another
 * process. It never owns SessionRuntime, transcript writes, or retention.
 */
export type SessionSearchRole = "user" | "assistant";

export type SessionSearchMatch = {
  sessionId: string;
  sessionTitle: string;
  projectKey?: string;
  role: SessionSearchRole;
  text: string;
  snippet: string;
  createdAt: string;
  lineNumber: number;
};

export type SessionSearchInput = {
  pilotHome: string;
  /** When omitted, searches every project under pilotHome. */
  projectRoot?: string;
  query: string;
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  role?: SessionSearchRole | "all";
  sessionId?: string;
  includeInternal?: boolean;
};

export type SessionSearchResult = {
  query: string;
  matches: SessionSearchMatch[];
  truncated: boolean;
  sessionsScanned: number;
};

export type SessionSearchPort = {
  search(input: SessionSearchInput): Promise<SessionSearchResult>;
};
