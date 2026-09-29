import type { SessionCatalogPort } from "../../session/catalog/SessionCatalogPort.js";
import type { SessionTranscriptReaderPort } from "../../session/history/SessionTranscriptReaderPort.js";

export type ChatSessionDigest = {
  sessionId: string;
  alias: string;
  title: string;
  lastModified: string;
  userPrompts: string[];
};

export type ChatDigest = {
  generatedAt: string;
  sessions: ChatSessionDigest[];
  /** Short alias -> real sessionId, for tool input resolution. */
  aliasMap: Map<string, string>;
};

export type BuildChatDigestOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Application-selected read-only catalog of durable sessions. */
  sessionCatalog: SessionCatalogPort;
  /** Application-selected durable transcript reader. */
  sessionTranscriptReader: SessionTranscriptReaderPort;
  maxSessions?: number;
  maxPromptsPerSession?: number;
  maxPromptLength?: number;
  /** Override for tests. */
  now?: () => Date;
};

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_PROMPTS_PER_SESSION = 8;
const DEFAULT_MAX_PROMPT_LENGTH = 500;

const DIGEST_EXCLUDED_PREFIXES = ["always-on-execute:"];

/**
 * Build a structured digest of recent user chat sessions for injection
 * into the Always-On discovery prompt. Uses the lightweight head+tail
 * reader so it never reads more than 128 KB per session file.
 */
export async function buildChatDigest(
  options: BuildChatDigestOptions,
): Promise<ChatDigest> {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxPrompts = options.maxPromptsPerSession ?? DEFAULT_MAX_PROMPTS_PER_SESSION;
  const maxLen = options.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
  const now = (options.now ?? (() => new Date()))();

  const allSessions = await options.sessionCatalog.list({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
    includeInternal: false,
  });
  const sessions = allSessions.filter(
    (s) => !DIGEST_EXCLUDED_PREFIXES.some((p) => s.sessionId.startsWith(p)),
  );

  const digests: ChatSessionDigest[] = [];
  const aliasMap = new Map<string, string>();
  let aliasCounter = 0;

  for (const session of sessions.slice(0, maxSessions)) {
    const { prompts } = await options.sessionTranscriptReader.readUserPromptDigest({
      projectRoot: options.projectRoot,
      pilotHome: options.pilotHome,
      sessionId: session.sessionId,
      maxPrompts,
      maxPromptLength: maxLen,
    });
    if (prompts.length === 0) continue;

    aliasCounter += 1;
    const alias = `chat_${aliasCounter}`;
    aliasMap.set(alias, session.sessionId);

    digests.push({
      sessionId: session.sessionId,
      alias,
      title: session.summary,
      lastModified: new Date(session.lastModified).toISOString(),
      userPrompts: [...prompts],
    });
  }

  return {
    generatedAt: now.toISOString(),
    sessions: digests,
    aliasMap,
  };
}
