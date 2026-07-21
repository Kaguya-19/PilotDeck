import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { FeishuChannel } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

test("Feishu handles permission replies before the active chat drain finishes", async () => {
  const chatId = "oc_test";
  const decisions: Array<{
    sessionKey: string;
    requestId: string;
    decision: string;
    remember?: boolean;
  }> = [];
  let resolveDecided!: () => void;
  const decided = new Promise<void>((resolve) => {
    resolveDecided = resolve;
  });
  const gateway = {
    permissionDecide: async (input: {
      sessionKey: string;
      requestId: string;
      decision: string;
      remember?: boolean;
    }) => {
      decisions.push(input);
      resolveDecided();
      return { delivered: true };
    },
  } as unknown as Gateway;
  const sent: Array<{ chatId: string; text: string }> = [];
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => {
      sent.push(message);
    },
  });
  await channel.start({ gateway, logger: {} });

  (channel as any).permissions.capture(chatId, "session-1", {
    type: "permission_request",
    requestId: "request-1",
    toolName: "read_file",
    payload: { file_path: "/tmp/a.txt" },
  });
  (channel as any).inboundBatches.set(chatId, { messages: [], draining: true });

  const response = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "1", eventId: "reply-1" }),
  );
  await withTimeout(decided, 1_000);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(decisions, [
    { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
  ]);
  assert.deepEqual(sent, [{ chatId, text: "已允许一次，继续执行。" }]);
  assert.deepEqual((channel as any).inboundBatches.get(chatId), { messages: [], draining: true });
});

function createMockResponse(): { statusCode?: number; body?: string; writeHead(statusCode: number): void; end(body: string): void } {
  return {
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for permission decision")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
