import {
  materializeMediaReferences,
  messageContent,
  type CanonicalMessage,
  type CanonicalModelRequest,
} from "../../model/index.js";
import { buildCachePlan } from "../../context/cache/CachePlan.js";
import type { ModelContext } from "../../context/protocol/types.js";
import type { PermissionMode } from "../../permission/index.js";

export const PLAN_MODE_REMINDER_MESSAGE = [
  "Plan mode is active.",
  "Read first using read-only tools, then write or refine plan markdown only under `.pilotdeck/plans/`.",
  "Do not make implementation changes while planning.",
  "When the plan is ready for user review, call `exit_plan_mode` with the plan file path.",
].join("\n");

/** Normalize durable history before every context preparation, including previews. */
export function normalizeMessagesForModelRequest(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const rawMessage of messages) {
    const message: CanonicalMessage = {
      ...rawMessage,
      content: messageContent(rawMessage),
    };
    const last = out[out.length - 1];
    if (last?.role === "assistant" && message.role === "assistant" && canMergeAssistantMessages(last, message)) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...messageContent(last), ...messageContent(message)],
        metadata: mergeMessageMetadata(last.metadata, message.metadata),
      };
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0) continue;
    out.push(message);
  }
  return out;
}

/**
 * Apply the post-context request steps shared by native execution and a host
 * that evaluates sidecar compaction candidates. The caller owns preparation;
 * this helper owns only deterministic canonical request assembly.
 */
export async function finalizePreparedModelRequest(input: {
  request: CanonicalModelRequest;
  prepared: ModelContext;
  permissionMode: PermissionMode;
  fallbackSystemPrompt?: string;
}): Promise<{
  request: CanonicalModelRequest;
  diagnostics: Awaited<ReturnType<typeof materializeMediaReferences>>["diagnostics"];
}> {
  const materialized = await materializeMediaReferences(input.prepared.messages);
  const messages = input.permissionMode === "plan"
    ? appendPlanModeReminder(materialized.messages)
    : materialized.messages;
  const cachePlan = input.prepared.cachePlan
    ? buildCachePlan({
        provider: input.request.provider,
        model: input.request.model,
        systemPrompt: input.prepared.systemPrompt,
        tools: input.prepared.tools,
        messages,
        enabled: true,
      }, input.prepared.cachePlan.generation)
    : undefined;
  return {
    request: {
      ...input.request,
      messages,
      systemPrompt: input.prepared.systemPrompt ?? input.fallbackSystemPrompt,
      tools: input.prepared.tools,
      cacheBreakpoints: cachePlan?.messages ?? (
        input.permissionMode === "plan" ? undefined : input.prepared.cacheBreakpoints
      ),
      cachePlan,
    },
    diagnostics: materialized.diagnostics,
  };
}

function appendPlanModeReminder(messages: CanonicalMessage[]): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: PLAN_MODE_REMINDER_MESSAGE }],
      metadata: { synthetic: true, purpose: "plan_mode_reminder" },
    },
  ];
}

function canMergeAssistantMessages(first: CanonicalMessage, second: CanonicalMessage): boolean {
  return !hasToolCallBlock(first) && !hasToolCallBlock(second);
}

function hasToolCallBlock(message: CanonicalMessage): boolean {
  return messageContent(message).some((block) => block.type === "tool_call");
}

function mergeMessageMetadata(
  first: CanonicalMessage["metadata"],
  second: CanonicalMessage["metadata"],
): CanonicalMessage["metadata"] {
  if (!first && !second) return undefined;
  return { ...(first ?? {}), ...(second ?? {}) };
}
