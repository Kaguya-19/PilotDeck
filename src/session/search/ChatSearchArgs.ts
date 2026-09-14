import type { SessionSearchRole } from "./SessionSearchPort.js";

const MAX_LIMIT = 100;

export type ParsedChatSearchArgs = {
  query: string;
  allProjects: boolean;
  limit?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  role?: SessionSearchRole | "all";
  sessionId?: string;
};

/** Parse the shared /search presentation syntax without choosing a provider. */
export function parseChatSearchArgs(raw: string): ParsedChatSearchArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let allProjects = false;
  let limit: number | undefined;
  let regex = false;
  let caseSensitive = false;
  let role: SessionSearchRole | "all" | undefined;
  let sessionId: string | undefined;
  const queryParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--all" || token === "-a") {
      allProjects = true;
    } else if (token === "--regex" || token === "-E") {
      regex = true;
    } else if (token === "--case-sensitive") {
      caseSensitive = true;
    } else if (token === "--limit" || token === "-n") {
      const value = Number(tokens[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        limit = Math.min(Math.floor(value), MAX_LIMIT);
        index += 1;
      }
    } else if (token === "--role" || token === "-r") {
      const value = tokens[index + 1];
      if (value === "user" || value === "assistant" || value === "all") {
        role = value;
        index += 1;
      }
    } else if (token === "--session" || token === "-s") {
      const value = tokens[index + 1];
      if (value) {
        sessionId = value;
        index += 1;
      }
    } else {
      queryParts.push(token);
    }
  }

  return { query: queryParts.join(" "), allProjects, limit, regex, caseSensitive, role, sessionId };
}
