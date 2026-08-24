import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, McpClientError } from "../../src/mcp/client/McpClient.js";
import { McpRuntime } from "../../src/mcp/runtime/McpRuntime.js";
import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";

const specs = [
  { id: "alpha", transport: "stdio" as const, command: "fake" },
  { id: "beta", transport: "stdio" as const, command: "fake" },
  { id: "broken", transport: "stdio" as const, command: "fake" },
];

test("McpRuntime starts clients with bounded concurrency and captures per-server errors", async (t) => {
  let active = 0;
  let peak = 0;
  const originalStart = McpClient.prototype.start;
  const originalStatus = McpClient.prototype.getStatus;
  const originalClose = McpClient.prototype.close;
  t.after(() => {
    McpClient.prototype.start = originalStart;
    McpClient.prototype.getStatus = originalStatus;
    McpClient.prototype.close = originalClose;
  });
  McpClient.prototype.start = async function () {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    active -= 1;
    if (this.spec.id === "broken") throw new McpClientError("broken server", "mcp_handshake_failed", this.spec.id);
    (this as unknown as { status: string }).status = "ready";
  };
  McpClient.prototype.getStatus = function () {
    return ((this as unknown as { status?: string }).status ?? "idle") as never;
  };
  McpClient.prototype.close = async function () {
    (this as unknown as { status: string }).status = "idle";
  };

  const runtime = new McpRuntime(specs, { connectConcurrency: 2 });
  const statuses = await runtime.start();
  assert.equal(peak, 2);
  assert.deepEqual(statuses.sort((a, b) => a.serverId.localeCompare(b.serverId)), [
    { serverId: "alpha", status: "ready" },
    { serverId: "beta", status: "ready" },
    { serverId: "broken", status: "error", error: "broken server" },
  ]);
  assert.equal(runtime.getClient("alpha")?.spec.id, "alpha");
  assert.equal(runtime.getClient("missing"), undefined);
  await runtime.stop();
});

test("McpRuntime aggregates ready tools and sorted instructions", async (t) => {
  const originalStatus = McpClient.prototype.getStatus;
  const originalTools = McpClient.prototype.listTools;
  const originalInstructions = McpClient.prototype.getInstructions;
  t.after(() => {
    McpClient.prototype.getStatus = originalStatus;
    McpClient.prototype.listTools = originalTools;
    McpClient.prototype.getInstructions = originalInstructions;
  });
  McpClient.prototype.getStatus = function () { return this.spec.id === "broken" ? "error" : "ready"; };
  McpClient.prototype.listTools = async function () {
    if (this.spec.id === "beta") throw new Error("list failed");
    return [{ serverId: this.spec.id, toolName: "tool", wireName: `mcp__${this.spec.id}__tool`, description: "", inputSchema: {} }];
  };
  McpClient.prototype.getInstructions = function () { return this.spec.id === "alpha" ? "alpha instructions" : ""; };

  const runtime = new McpRuntime(specs);
  assert.deepEqual((await runtime.listAllTools()).map((tool) => tool.serverId), ["alpha"]);
  assert.deepEqual(runtime.getInstructions(), [{ serverId: "alpha", instructions: "alpha instructions" }]);
  assert.equal(runtime.statuses().length, 3);
});

function bridgeRuntime(client: unknown, tools: unknown[]) {
  return {
    listAllTools: async () => tools,
    getClient: () => client,
  } as never;
}

test("PluginToToolBridge maps annotations, schema, content and metadata", async () => {
  const client = {
    spec: { id: "server", transport: "stdio", cwd: "/tmp" },
    callTool: async () => ({
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "base64", mimeType: "image/png" },
        { type: "resource", uri: "file://x" },
      ],
    }),
  };
  const spec = {
    serverId: "server",
    toolName: "inspect",
    wireName: "mcp__server__inspect",
    description: "Inspect",
    inputSchema: { type: "string" },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: false },
  };
  const [tool] = await createMcpToolDefinitionsFromRuntime(bridgeRuntime(client, [spec]), { callTimeoutMs: 123 });
  assert.equal(tool.isReadOnly({}), true);
  assert.equal(tool.isConcurrencySafe({}), true);
  assert.equal(tool.isDestructive?.({}), true);
  assert.equal(tool.isOpenWorld?.({}), false);
  assert.deepEqual(tool.inputSchema, { type: "object", additionalProperties: true, properties: {} });
  const result = await tool.execute({}, { abortSignal: undefined } as never);
  assert.deepEqual(result.content, [
    { type: "text", text: "done" },
    { type: "image", mimeType: "image/png", data: "base64" },
    { type: "json", value: [{ type: "resource", uri: "file://x" }] },
  ]);
  assert.deepEqual(result.metadata, { mcp: { serverId: "server", toolName: "inspect", wireName: "mcp__server__inspect" } });
});

test("PluginToToolBridge reads markdown image references and maps failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-bridge-"));
  try {
    await writeFile(join(dir, "shot.png"), Buffer.from([1, 2, 3]));
    const client = {
      spec: { id: "server", transport: "stdio", cwd: dir },
      callTool: async (_name: string, input: { mode?: string }) => {
        if (input.mode === "error") return { content: [{ type: "text", text: "not allowed" }], isError: true };
        if (input.mode === "timeout") throw { code: "mcp_call_timeout", message: "timed out" };
        return { content: [{ type: "text", text: "![shot](./shot.png)" }] };
      },
    };
    const spec = { serverId: "server", toolName: "run", wireName: "mcp__server__run", description: "", inputSchema: { type: "object" } };
    const [tool] = await createMcpToolDefinitionsFromRuntime(bridgeRuntime(client, [spec]));
    const imageResult = await tool.execute({}, {} as never);
    assert.deepEqual(imageResult.content, [
      { type: "text", text: "![shot](./shot.png)" },
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
    ]);
    await assert.rejects(() => tool.execute({ mode: "error" }, {} as never), /not allowed/);
    await assert.rejects(() => tool.execute({ mode: "timeout" }, {} as never), /timed out/);

    const missing = await createMcpToolDefinitionsFromRuntime(bridgeRuntime(undefined, [spec]));
    await assert.rejects(() => missing[0].execute({}, {} as never), /not registered/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PluginToToolBridge fails closed for malformed results and maps all client failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-bridge-fallbacks-"));
  try {
    await writeFile(join(dir, "shot.jpg"), Buffer.from([4, 5]));
    await writeFile(join(dir, "shot.gif"), Buffer.from([6, 7]));
    await writeFile(join(dir, "shot.webp"), Buffer.from([8, 9]));
    let mode = "json";
    const client = {
      spec: { id: "server", transport: "stdio", cwd: dir },
      callTool: async () => {
        if (mode === "timeout") throw { code: "mcp_call_timeout" };
        if (mode === "expired") throw { code: "mcp_session_expired" };
        if (mode === "generic") throw { code: "other_error", message: "generic failure" };
        if (mode === "error") return { content: { message: "bad" }, isError: true };
        if (mode === "invalid") return { content: [null, { type: "image", data: 42 }, { type: "audio", data: "x" }] };
        if (mode === "links") return { content: [{ type: "text", text: "![j](./shot.jpg) ![g](./shot.gif) ![w](./shot.webp) ![missing](./missing.png)" }] };
        return { content: { raw: true } };
      },
    };
    const spec = {
      serverId: "server",
      toolName: "run",
      wireName: "mcp__server__run",
      description: "",
      inputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    };
    const [tool] = await createMcpToolDefinitionsFromRuntime(bridgeRuntime(client, [spec]));
    assert.equal(tool.isReadOnly?.({}), false);
    assert.equal(tool.isConcurrencySafe?.({}), false);
    assert.equal(tool.isDestructive?.({}), false);
    assert.equal(tool.isOpenWorld?.({}), true);
    assert.deepEqual(tool.inputSchema, spec.inputSchema);

    assert.deepEqual((await tool.execute({}, {} as never)).content, [{ type: "json", value: { raw: true } }]);
    mode = "invalid";
    assert.deepEqual((await tool.execute({}, {} as never)).content, [
      { type: "json", value: [null, { type: "image", data: 42 }, { type: "audio", data: "x" }] },
    ]);
    mode = "links";
    const links = await tool.execute({}, {} as never);
    assert.equal(links.content.filter((item) => item.type === "image").length, 3);
    mode = "error";
    await assert.rejects(() => tool.execute({}, {} as never), /MCP server server\/run returned isError/);
    mode = "timeout";
    await assert.rejects(() => tool.execute({}, {} as never), /MCP call timed out/);
    mode = "expired";
    await assert.rejects(() => tool.execute({}, {} as never), /MCP session expired/);
    mode = "generic";
    await assert.rejects(() => tool.execute({}, {} as never), /generic failure/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
