import assert from "node:assert/strict";
import test from "node:test";

import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";
import type { McpRuntimePort } from "../../src/mcp/runtime/McpRuntimePort.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "mcp-port-session",
    turnId: "mcp-port-turn",
    cwd: "/workspace",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/workspace",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("MCP tool bridge consumes McpRuntimePort without a concrete client", async () => {
  const calls: Array<{ serverId: string; toolName: string; input: unknown; timeoutMs?: number }> = [];
  const runtime: McpRuntimePort = {
    async start() { return []; },
    async stop() {},
    async listAllTools() {
      return [{
        serverId: "fake",
        toolName: "inspect",
        wireName: "mcp__fake__inspect",
        description: "Inspect through a fake provider.",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        annotations: { readOnlyHint: true },
      }];
    },
    getServerInfo(serverId) {
      return serverId === "fake" ? { transport: "stdio", cwd: "/workspace" } : undefined;
    },
    async callTool(serverId, toolName, input, options) {
      calls.push({ serverId, toolName, input, timeoutMs: options?.timeoutMs });
      return { content: [{ type: "text", text: "port result" }] };
    },
  };

  const [tool] = await createMcpToolDefinitionsFromRuntime(runtime, { callTimeoutMs: 123 });
  assert.ok(tool);
  const result = await tool.execute({ value: "hello" }, context());

  assert.deepEqual(calls, [{
    serverId: "fake",
    toolName: "inspect",
    input: { value: "hello" },
    timeoutMs: 123,
  }]);
  assert.deepEqual(result.content, [{ type: "text", text: "port result" }]);
  assert.deepEqual(result.metadata, {
    mcp: { serverId: "fake", toolName: "inspect", wireName: "mcp__fake__inspect" },
  });
});

test("MCP tool bridge reports an unavailable server before dispatching a port call", async () => {
  let calls = 0;
  const runtime: McpRuntimePort = {
    async start() { return []; },
    async stop() {},
    async listAllTools() {
      return [{
        serverId: "missing",
        toolName: "inspect",
        wireName: "mcp__missing__inspect",
        description: "Missing server.",
        inputSchema: { type: "object", properties: {} },
      }];
    },
    getServerInfo() { return undefined; },
    async callTool() {
      calls += 1;
      return { content: [] };
    },
  };

  const [tool] = await createMcpToolDefinitionsFromRuntime(runtime);
  await assert.rejects(
    tool!.execute({}, context()),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "unsupported_tool"
    ),
  );
  assert.equal(calls, 0);
});
