import test from "node:test";
import assert from "node:assert/strict";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpClient, McpClientError } from "../../../src/mcp/client/McpClient.js";

type FakeTransportOptions = {
  initializeError?: boolean;
  initializeSilent?: boolean;
  failToolWith?: "session" | "timeout" | "generic";
  failList?: boolean;
  emptyList?: boolean;
  omitIsError?: boolean;
  closeError?: boolean;
};

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  started = 0;
  closed = 0;
  toolCalls = 0;
  listCalls = 0;

  constructor(private readonly options: FakeTransportOptions = {}) {}

  async start(): Promise<void> {
    this.started += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
    if (this.options.closeError) throw new Error("close failed");
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const request = message as { method?: string; id?: number };
    if (!request.method || typeof request.id !== "number") return;
    const id = request.id;
    if (request.method === "initialize") {
      if (this.options.initializeSilent) return;
      queueMicrotask(() => {
        this.onmessage?.(this.options.initializeError
          ? { jsonrpc: "2.0", id, error: { code: -32603, message: "handshake failed" } }
          : {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "fake-mcp", version: "1" },
              instructions: "Use the fake server",
            },
          });
      });
      return;
    }
    if (request.method === "tools/list") {
      this.listCalls += 1;
      if (this.options.failList) {
        queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32603, message: "list failed" } }));
        return;
      }
      queueMicrotask(() => this.onmessage?.({
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.options.emptyList ? [] : [{
              name: "read\u202E_file",
              description: "x".repeat(2100),
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            }],
        },
      }));
      return;
    }
    if (request.method === "tools/call") {
      this.toolCalls += 1;
      if (this.options.failToolWith === "session" && this.toolCalls === 1) {
        queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP session expired" } }));
      } else if (this.options.failToolWith === "timeout" && this.toolCalls === 1) {
        queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32001, message: "Request timed out" } }));
      } else if (this.options.failToolWith === "generic" && this.toolCalls === 1) {
        queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32603, message: "server exploded" } }));
      } else {
        queueMicrotask(() => this.onmessage?.({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "ok\u202E" }], ...(this.options.omitIsError ? {} : { isError: false }) },
        }));
      }
    }
  }
}

function spec(id = "fake") {
  return { id, transport: "stdio" as const, command: "fake-mcp" };
}

test("McpClient memoizes start, exposes instructions and caches listTools", async () => {
  const transports: FakeTransport[] = [];
  const client = new McpClient(spec(), {
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
  });

  await Promise.all([client.start(), client.start()]);
  assert.equal(transports.length, 1);
  assert.equal(client.getStatus(), "ready");
  assert.equal(client.getInstructions(), "Use the fake server");

  const first = await client.listTools();
  const second = await client.listTools();
  assert.strictEqual(first, second);
  assert.equal(transports[0].listCalls, 1);
  assert.equal(first[0].toolName, "read_file");
  assert.equal(first[0].wireName, "mcp__fake__read_file");
  assert.match(first[0].description, /truncated/);
  await client.close();
  assert.equal(client.getStatus(), "idle");
  assert.equal(transports[0].closed, 1);
});

test("McpClient sanitizes tool results and reconnects after session expiry", async () => {
  const transports: FakeTransport[] = [];
  const client = new McpClient(spec("session"), {
    transportFactory: () => {
      const transport = new FakeTransport({ failToolWith: transports.length === 0 ? "session" : undefined });
      transports.push(transport);
      return transport;
    },
  });

  const result = await client.callTool("echo", { value: "x" });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }], isError: false });
  assert.equal(transports.length, 2);
  assert.equal(transports[0].closed, 1);
  await client.close();
});

test("McpClient recycles transport after timeout and maps unsupported/handshake errors", async () => {
  const transports: FakeTransport[] = [];
  const client = new McpClient(spec("timeout"), {
    transportFactory: () => {
      const transport = new FakeTransport({ failToolWith: transports.length === 0 ? "timeout" : undefined });
      transports.push(transport);
      return transport;
    },
  });
  await assert.rejects(() => client.callTool("slow", {}), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_call_timeout");
  assert.equal(transports[0].closed, 1);
  await client.close();

  const unsupported = new McpClient({ id: "bad", transport: "unsupported" } as never);
  await assert.rejects(() => unsupported.start(), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_unsupported_transport");
  assert.equal(unsupported.getStatus(), "error");

  const handshake = new McpClient(spec("handshake"), {
    transportFactory: () => new FakeTransport({ initializeError: true }),
  });
  await assert.rejects(() => handshake.start(), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_handshake_failed");
  assert.equal(handshake.getStatus(), "error");
});

test("McpClient maps generic tool/list failures and tolerates close cleanup errors", async () => {
  const generic = new McpClient(spec("generic"), {
    transportFactory: () => new FakeTransport({ failToolWith: "generic", closeError: true }),
  });
  await assert.rejects(() => generic.callTool("broken", {}), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_call_failed" && /server exploded/.test(error.message));
  await generic.close();

  const listFailure = new McpClient(spec("list-failure"), {
    transportFactory: () => new FakeTransport({ failList: true }),
  });
  await assert.rejects(() => listFailure.listTools(), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_call_failed");
  await listFailure.close();
});

test("McpClient retries a failed handshake and handles an empty tool response", async () => {
  let attempts = 0;
  const client = new McpClient(spec("retry"), {
    transportFactory: () => new FakeTransport({ initializeError: attempts++ === 0, emptyList: true, omitIsError: true }),
  });
  await assert.rejects(() => client.start(), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_handshake_failed");
  await client.start();
  assert.deepEqual(await client.listTools(), []);
  assert.deepEqual(await client.callTool("empty", null), {
    content: [{ type: "text", text: "ok" }],
    isError: undefined,
  });
  await client.close();
});

test("McpClient maps handshake timeout and cleans per-session stdio directories", async () => {
  let silentTransport: FakeTransport | undefined;
  const timeout = new McpClient(spec("silent"), {
    handshakeTimeoutMs: 5,
    transportFactory: () => {
      silentTransport = new FakeTransport({ initializeSilent: true });
      return silentTransport;
    },
  });
  await assert.rejects(() => timeout.start(), (error: unknown) =>
    error instanceof McpClientError && error.code === "mcp_handshake_failed" && /timed out/.test(error.message));
  await silentTransport?.close();
  assert.equal(timeout.getStatus(), "error");
  await timeout.close();

  const perSession = new McpClient({
    id: "per-session",
    transport: "stdio",
    command: "node",
    perSession: true,
  });
  const transport = (perSession as unknown as { buildTransport(): { close(): Promise<void> } }).buildTransport();
  assert.ok(transport);
  await perSession.close();
  assert.equal(perSession.getStatus(), "idle");
});
