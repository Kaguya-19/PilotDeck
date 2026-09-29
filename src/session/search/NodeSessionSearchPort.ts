import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { sanitizeSessionIdForPath } from "../storage/ProjectSessionStorage.js";
import { readSessionInfo, type SessionInfo } from "../storage/SessionList.js";
import type {
  SessionSearchInput,
  SessionSearchMatch,
  SessionSearchPort,
  SessionSearchResult,
  SessionSearchRole,
} from "./SessionSearchPort.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SNIPPET_RADIUS = 60;

/** Native JSONL-backed provider for the read-only SessionSearchPort. */
export function createNodeSessionSearchPort(): SessionSearchPort {
  return { search: searchNodeSessionHistory };
}

/**
 * Execute the native JSONL implementation without exposing Node I/O to
 * application consumers. Kept exported for provider-focused tests and the
 * legacy compatibility facade.
 */
export async function searchNodeSessionHistory(options: SessionSearchInput): Promise<SessionSearchResult> {
  const query = options.query.trim();
  if (!query) {
    return { query, matches: [], truncated: false, sessionsScanned: 0 };
  }

  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const matcher = buildMatcher(query, {
    caseSensitive: options.caseSensitive ?? false,
    regex: options.regex ?? false,
  });
  const roleFilter = options.role ?? "all";
  const includeInternal = options.includeInternal ?? false;
  const sessionFiles = await collectSessionFiles({
    pilotHome: options.pilotHome,
    projectRoot: options.projectRoot,
    sessionId: options.sessionId,
    includeInternal,
  });
  const titleBySession = await buildSessionTitleIndex(sessionFiles);
  const matches: SessionSearchMatch[] = [];
  let truncated = false;

  for (const file of sessionFiles) {
    const fileMatches = await searchSessionFile(file, matcher, roleFilter);
    for (const match of fileMatches) {
      const title = titleBySession.get(`${file.projectKey ?? ""}:${match.sessionId}`) ?? match.sessionId;
      matches.push({ ...match, sessionTitle: title, projectKey: file.projectKey });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { query, matches, truncated, sessionsScanned: sessionFiles.length };
}

type SessionFileTarget = { path: string; projectKey?: string };

type SearchableLine = {
  role: SessionSearchRole;
  text: string;
  createdAt: string;
};

type Matcher = {
  test: (text: string) => boolean;
  findIndex: (text: string) => number;
};

function buildMatcher(query: string, options: { caseSensitive: boolean; regex: boolean }): Matcher {
  if (options.regex) {
    const pattern = new RegExp(query, options.caseSensitive ? "" : "i");
    return {
      test: (text) => pattern.test(text),
      findIndex: (text) => {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        return match?.index ?? -1;
      },
    };
  }

  const needle = options.caseSensitive ? query : query.toLowerCase();
  return {
    test: (text) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle),
    findIndex: (text) => (options.caseSensitive ? text : text.toLowerCase()).indexOf(needle),
  };
}

async function collectSessionFiles(options: {
  pilotHome: string;
  projectRoot?: string;
  sessionId?: string;
  includeInternal: boolean;
}): Promise<SessionFileTarget[]> {
  if (options.sessionId) {
    const projectRoot = options.projectRoot ?? process.cwd();
    if (!options.includeInternal && isInternalSession(options.sessionId)) return [];
    return [{
      path: join(
        getPilotProjectChatDir(projectRoot, options.pilotHome),
        `${sanitizeSessionIdForPath(options.sessionId)}.jsonl`,
      ),
      projectKey: projectRoot,
    }];
  }

  if (options.projectRoot) {
    return listJsonlFiles(
      getPilotProjectChatDir(options.projectRoot, options.pilotHome),
      options.projectRoot,
      options.includeInternal,
    );
  }

  let projectIds: string[];
  try {
    projectIds = await readdir(resolve(options.pilotHome, "projects"));
  } catch {
    return [];
  }

  const files: SessionFileTarget[] = [];
  for (const projectId of projectIds) {
    files.push(...await listJsonlFiles(
      join(options.pilotHome, "projects", projectId, "chats"),
      projectId,
      options.includeInternal,
    ));
  }
  return files;
}

async function listJsonlFiles(
  chatDir: string,
  projectKey: string,
  includeInternal: boolean,
): Promise<SessionFileTarget[]> {
  let names: string[];
  try {
    names = await readdir(chatDir);
  } catch {
    return [];
  }

  return names.flatMap((name): SessionFileTarget[] => {
    if (!name.endsWith(".jsonl")) return [];
    const sessionId = name.slice(0, -".jsonl".length);
    if (!includeInternal && isInternalSession(sessionId)) return [];
    return [{ path: join(chatDir, name), projectKey }];
  });
}

async function buildSessionTitleIndex(files: SessionFileTarget[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  await Promise.all(files.map(async (file) => {
    const sessionId = file.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "");
    if (!sessionId) return;
    const info = await readSessionInfo(file.path, sessionId, file.projectKey);
    if (!info) return;
    titles.set(`${file.projectKey ?? ""}:${sessionId}`, formatSessionTitle(info));
  }));
  return titles;
}

function formatSessionTitle(session: SessionInfo): string {
  return session.customTitle ?? session.aiTitle ?? session.summary ?? session.sessionId;
}

async function searchSessionFile(
  file: SessionFileTarget,
  matcher: Matcher,
  roleFilter: SessionSearchRole | "all",
): Promise<Omit<SessionSearchMatch, "sessionTitle" | "projectKey">[]> {
  const matches: Omit<SessionSearchMatch, "sessionTitle" | "projectKey">[] = [];
  const stream = createReadStream(file.path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : file.path;
    const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
    for (const item of extractSearchableLines(entry)) {
      if (roleFilter !== "all" && item.role !== roleFilter) continue;
      if (!matcher.test(item.text)) continue;
      matches.push({
        sessionId,
        role: item.role,
        text: item.text,
        snippet: buildSnippet(item.text, matcher),
        createdAt,
        lineNumber,
      });
    }
  }

  return matches;
}

function extractSearchableLines(entry: Record<string, unknown>): SearchableLine[] {
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  if (entry.type === "accepted_input" && Array.isArray(entry.messages)) {
    const text = extractCanonicalText(entry.messages);
    return text ? [{ role: "user", text, createdAt }] : [];
  }
  if ((entry.type === "assistant_message" || entry.type === "durable_message") && isRecord(entry.message)) {
    const text = extractCanonicalText([entry.message]);
    return text ? [{ role: "assistant", text, createdAt }] : [];
  }
  return [];
}

function extractCanonicalText(messages: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "text") continue;
      if (typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function buildSnippet(text: string, matcher: Matcher): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const center = Math.max(0, matcher.findIndex(normalized));
  const start = Math.max(0, center - SNIPPET_RADIUS);
  const end = Math.min(normalized.length, center + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

function isInternalSession(sessionId: string): boolean {
  return ALWAYS_ON_AUXILIARY_PATTERN.test(sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
