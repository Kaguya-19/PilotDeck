import { join } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import {
  nodeProjectSessionStorageProvider,
  type ProjectSessionStorageProvider,
} from "../storage/ProjectSessionStorageProvider.js";
import {
  readAgentProjectSessionPersistence,
  sanitizeSessionIdForPath,
} from "../storage/ProjectSessionStorage.js";
import { readSessionLite } from "../storage/SessionLiteReader.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionTranscriptReaderPort,
  SessionTranscriptReadInput,
  SessionUserPromptDigestInput,
  SessionUserPromptDigestResult,
} from "./SessionTranscriptReaderPort.js";

export type CreateProjectSessionTranscriptReaderOptions = {
  /** Application-selected durable backend; JSONL remains the native default. */
  storageProvider?: ProjectSessionStorageProvider;
};

/**
 * Native SessionTranscriptReaderPort provider.
 *
 * Full conversation reads always go through the selected persistence provider.
 * The native JSONL provider retains the existing head/tail optimization for
 * discovery prompts; that filesystem detail stays confined to this provider.
 */
export function createProjectSessionTranscriptReader(
  options: CreateProjectSessionTranscriptReaderOptions = {},
): SessionTranscriptReaderPort {
  const storageProvider = options.storageProvider;
  const usesNativeJsonl = storageProvider === undefined || storageProvider === nodeProjectSessionStorageProvider;
  const read = async (input: SessionTranscriptReadInput) => {
    const result = await readAgentProjectSessionPersistence({
      projectRoot: input.projectRoot,
      pilotHome: input.pilotHome,
      sessionId: input.sessionId,
      ...(storageProvider ? { storageProvider } : {}),
    });
    return {
      entries: result.entries.map((entry) => structuredClone(entry)),
      diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  };
  return {
    read,
    async readUserPromptDigest(input) {
      if (usesNativeJsonl) {
        const chatDir = getPilotProjectChatDir(input.projectRoot, input.pilotHome);
        const lite = await readSessionLite(join(chatDir, `${sanitizeSessionIdForPath(input.sessionId)}.jsonl`));
        return { prompts: lite ? extractUserPromptsFromJsonl(`${lite.head}\n${lite.tail}`, input) : [] };
      }
      const result = await read(input);
      return { prompts: extractUserPromptsFromEntries(result.entries, input) };
    },
  };
}

export function extractUserPromptsFromEntries(
  entries: readonly AgentTranscriptEntry[],
  options: Pick<SessionUserPromptDigestInput, "maxPrompts" | "maxPromptLength">,
): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "accepted_input") continue;
    for (const message of entry.messages) {
      for (const block of message.content) {
        if (block.type !== "text" || !block.text.trim() || seen.has(block.text.trim())) continue;
        const text = block.text.trim();
        seen.add(text);
        prompts.push(text.length > options.maxPromptLength ? `${text.slice(0, options.maxPromptLength)}...` : text);
        if (prompts.length >= options.maxPrompts) return prompts;
      }
    }
  }
  return prompts;
}

export function extractUserPromptsFromJsonl(
  source: string,
  options: Pick<SessionUserPromptDigestInput, "maxPrompts" | "maxPromptLength">,
): string[] {
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) continue;
    try {
      const entry = JSON.parse(line) as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
      for (const message of entry.messages ?? []) {
        for (const block of message.content ?? []) {
          if (block.type !== "text" || typeof block.text !== "string") continue;
          const text = block.text.trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          prompts.push(text.length > options.maxPromptLength ? `${text.slice(0, options.maxPromptLength)}...` : text);
          if (prompts.length >= options.maxPrompts) return prompts;
        }
      }
    } catch {
      // Keep the native lightweight reader's malformed-line behavior.
    }
  }
  return prompts;
}
