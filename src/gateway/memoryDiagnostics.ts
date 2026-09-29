import type { CanonicalContentBlock, CanonicalMessage, CanonicalToolResultContentBlock } from "../model/index.js";

export type GatewayMemoryDiagnosticSession = {
  sessionKey: string;
  projectKey?: string;
  runId?: string;
  messageCount?: number;
  estimatedMessageBytes?: number;
  toolResultReferences?: number;
  mediaBlocks?: number;
  mediaBytes?: number;
};

export type GatewayMemoryDiagnosticInput = {
  event: "turn_completed" | "session_idle_evicted" | "runtime_invalidated";
  session?: GatewayMemoryDiagnosticSession;
  sessionCount?: number;
  projectKey?: string;
  reason?: string;
};

export function isGatewayMemoryDiagnosticsEnabled(
  env: Record<string, string | undefined>,
  configEnabled?: boolean,
): boolean {
  const value = env.PILOTDECK_MEMORY_DIAGNOSTICS;
  return configEnabled === true || value === "1" || value === "true";
}

export function summarizeCanonicalMessages(messages: CanonicalMessage[]): Omit<
  GatewayMemoryDiagnosticSession,
  "sessionKey" | "projectKey" | "runId"
> {
  let estimatedMessageBytes = 0;
  let toolResultReferences = 0;
  let mediaBlocks = 0;
  let mediaBytes = 0;

  for (const message of messages) {
    for (const block of message.content) {
      const stats = summarizeBlock(block);
      estimatedMessageBytes += stats.estimatedBytes;
      toolResultReferences += stats.toolResultReferences;
      mediaBlocks += stats.mediaBlocks;
      mediaBytes += stats.mediaBytes;
    }
  }

  return {
    messageCount: messages.length,
    estimatedMessageBytes,
    toolResultReferences,
    mediaBlocks,
    mediaBytes,
  };
}

export function logGatewayMemoryDiagnostic(input: GatewayMemoryDiagnosticInput): void {
  const memory = process.memoryUsage();
  const payload = {
    event: input.event,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    ...(input.sessionCount !== undefined ? { sessionCount: input.sessionCount } : {}),
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.session ? { session: input.session } : {}),
  };
  // Keep this parseable for log collectors while staying invisible unless enabled upstream.
  console.log(`[pilotdeck:memory] ${JSON.stringify(payload)}`);
}

function summarizeBlock(block: CanonicalContentBlock | CanonicalToolResultContentBlock): {
  estimatedBytes: number;
  toolResultReferences: number;
  mediaBlocks: number;
  mediaBytes: number;
} {
  switch (block.type) {
    case "text":
    case "thinking":
      return { estimatedBytes: Buffer.byteLength(block.text, "utf8"), toolResultReferences: 0, mediaBlocks: 0, mediaBytes: 0 };
    case "image":
    case "pdf":
    case "audio": {
      const bytes = ("bytes" in block ? block.bytes : undefined) ?? Buffer.byteLength(block.data, "utf8");
      return { estimatedBytes: Buffer.byteLength(block.data, "utf8"), toolResultReferences: 0, mediaBlocks: 1, mediaBytes: bytes };
    }
    case "tool_call":
      return { estimatedBytes: estimateJsonBytes(block.input), toolResultReferences: 0, mediaBlocks: 0, mediaBytes: 0 };
    case "tool_result": {
      let estimatedBytes = 0;
      let mediaBlocks = 0;
      let mediaBytes = 0;
      for (const item of block.content) {
        const stats = summarizeBlock(item);
        estimatedBytes += stats.estimatedBytes;
        mediaBlocks += stats.mediaBlocks;
        mediaBytes += stats.mediaBytes;
      }
      return { estimatedBytes, toolResultReferences: 0, mediaBlocks, mediaBytes };
    }
    case "tool_result_reference":
      return {
        estimatedBytes: Buffer.byteLength(block.preview, "utf8") + Buffer.byteLength(block.path, "utf8"),
        toolResultReferences: 1,
        mediaBlocks: 0,
        mediaBytes: 0,
      };
    case "media_reference":
      return {
        estimatedBytes: Buffer.byteLength(block.preview, "utf8") + Buffer.byteLength(block.path, "utf8"),
        toolResultReferences: 1,
        mediaBlocks: 0,
        mediaBytes: 0,
      };
  }
  return { estimatedBytes: 0, toolResultReferences: 0, mediaBlocks: 0, mediaBytes: 0 };
}

function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
