import assert from "node:assert/strict";
import test from "node:test";

import { SessionMcpRuntimeBundle } from "../../src/cli/SessionMcpRuntimeBundle.js";
import { GatewaySessionResourceLeaseBundle } from "../../src/cli/GatewaySessionResourceLeaseBundle.js";
import { SessionMcpRuntimeRegistry } from "../../src/mcp/runtime/SessionMcpRuntimeRegistry.js";
import {
  ProjectMcpRuntimeProvider,
  type McpRuntimePort,
  type PilotDeckMcpServerSpec,
} from "../../src/mcp/index.js";
import { ToolRegistry } from "../../src/tool/index.js";

test("session MCP bundle snapshots shared and per-session bridges with reverse teardown", async () => {
  const lifecycle: string[] = [];
  const createRuntime = (servers: PilotDeckMcpServerSpec[]): McpRuntimePort => {
    const serverId = servers[0]?.id ?? "none";
    return {
      async start() {
        lifecycle.push(`start:${serverId}`);
        return [];
      },
      async stop() {
        lifecycle.push(`stop:${serverId}`);
      },
      async listAllTools() {
        return [{
          serverId,
          toolName: "inspect",
          wireName: `mcp__${serverId}__inspect`,
          description: `Inspect through ${serverId}.`,
          inputSchema: { type: "object", properties: {} },
        }];
      },
      getServerInfo(id) {
        return id === serverId ? { transport: "streamable_http" } : undefined;
      },
      async callTool() {
        return { content: [] };
      },
    };
  };
  const provider = new ProjectMcpRuntimeProvider({
    projectRoot: "/tmp/pilotdeck-session-mcp-bundle",
    pilotHome: "/tmp/pilotdeck-session-mcp-bundle-home",
    createRuntime,
  });
  const resources = new GatewaySessionResourceLeaseBundle();
  const perSessionRuntimes = new SessionMcpRuntimeRegistry();

  const tools = await new SessionMcpRuntimeBundle({
    sessionKey: "session-mcp-bundle",
    baseTools: new ToolRegistry(),
    mcpProvider: provider,
    mcpServers: {
      shared: { url: "http://127.0.0.1:1/shared" },
      session: { command: "node", args: ["session.mjs"], perSession: true },
    },
    resources,
    perSessionRuntimes,
    maxPerSessionInstances: 1,
    createRuntime,
  }).compose();

  assert.deepEqual(lifecycle, ["start:shared", "start:session"]);
  assert.deepEqual(tools.list().map((tool) => tool.name), [
    "mcp__session__inspect",
    "mcp__shared__inspect",
  ]);
  assert.equal(perSessionRuntimes.size, 1);

  await resources.release();
  assert.deepEqual(lifecycle, [
    "start:shared",
    "start:session",
    "stop:session",
    "stop:shared",
  ]);
  assert.equal(perSessionRuntimes.size, 0);
  await provider.dispose();
  await perSessionRuntimes.dispose();
});
