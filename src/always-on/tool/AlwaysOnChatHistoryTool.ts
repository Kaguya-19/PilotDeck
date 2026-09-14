import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
import { replayTranscriptEntries } from "../../session/transcript/TranscriptReplay.js";
import type { SessionCatalogPort } from "../../session/catalog/SessionCatalogPort.js";
import type { SessionTranscriptReaderPort } from "../../session/history/SessionTranscriptReaderPort.js";
import type { AlwaysOnRunContextRegistry } from "../runtime/AlwaysOnRunContextRegistry.js";

export type AlwaysOnChatHistoryInput = {
  sessionId: string;
};

export type AlwaysOnChatHistoryConversationEntry = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type AlwaysOnChatHistoryOutput = {
  sessionId: string;
  title: string;
  messageCount: number;
  conversation: AlwaysOnChatHistoryConversationEntry[];
};

export type CreateAlwaysOnChatHistoryToolOptions = {
  runContexts: AlwaysOnRunContextRegistry;
  /** Application-selected read-only catalog used only for session metadata. */
  sessionCatalog: SessionCatalogPort;
  /** Application-selected durable transcript reader. */
  sessionTranscriptReader: SessionTranscriptReaderPort;
};

export const ALWAYS_ON_CHAT_HISTORY_TOOL_NAME = "always_on_read_chat_history";

const ASSISTANT_TEXT_LIMIT = 300;

export function createAlwaysOnChatHistoryTool(
  options: CreateAlwaysOnChatHistoryToolOptions,
): PilotDeckToolDefinition<AlwaysOnChatHistoryInput, AlwaysOnChatHistoryOutput> {
  return {
    name: ALWAYS_ON_CHAT_HISTORY_TOOL_NAME,
    aliases: ["AlwaysOnReadChatHistory"],
    description:
      "Read the full conversation from a user chat session. " +
      "Use the sessionId from the chat digest in the discovery prompt to expand a session of interest. " +
      "Only available during Always-On discovery (Phase 1).",
    kind: "session",
    requiredRuntimeCapabilities: ["always_on_run_context"],
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId of the chat session to read (from the chat digest).",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const ctx = options.runContexts.getDiscovery(context.sessionId);
      if (!ctx) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `${ALWAYS_ON_CHAT_HISTORY_TOOL_NAME} is only available during Always-On discovery (Phase 1).`,
        );
      }

      const realSessionId = ctx.chatSessionAliases?.get(input.sessionId) ?? input.sessionId;

      const { entries, diagnostics } = await options.sessionTranscriptReader.read({
        projectRoot: ctx.projectKey,
        pilotHome: ctx.paths.pilotHome,
        sessionId: realSessionId,
      });
      if (entries.length === 0) {
        const reason = diagnostics.length > 0
          ? diagnostics[0].message
          : "No transcript entries found.";
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `Could not read session ${input.sessionId}: ${reason}`,
        );
      }

      const { messages, metadata } = replayTranscriptEntries([...entries]);

      const sessions = await options.sessionCatalog.list({
        projectRoot: ctx.projectKey,
        pilotHome: ctx.paths.pilotHome,
        includeInternal: false,
      });
      const sessionInfo = sessions.find((s) => s.sessionId === realSessionId);
      const title = metadata.title ?? metadata.aiTitle ?? sessionInfo?.summary ?? realSessionId;

      const conversation: AlwaysOnChatHistoryConversationEntry[] = [];
      for (const msg of messages) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const textParts = msg.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
          .map((b) => b.text.trim())
          .filter((t) => t.length > 0);

        if (textParts.length === 0) continue;

        const fullText = textParts.join("\n\n");
        const role = msg.role as "user" | "assistant";
        const text = role === "assistant" && fullText.length > ASSISTANT_TEXT_LIMIT
          ? `${fullText.slice(0, ASSISTANT_TEXT_LIMIT)}...`
          : fullText;

        conversation.push({ role, text, createdAt: "" });
      }

      const data: AlwaysOnChatHistoryOutput = {
        sessionId: realSessionId,
        title,
        messageCount: conversation.length,
        conversation,
      };

      return {
        content: [
          { type: "text", text: `Session "${title}" — ${conversation.length} messages.` },
          { type: "json", value: data },
        ],
        data,
        metadata: { runId: ctx.runId },
      };
    },
  };
}
