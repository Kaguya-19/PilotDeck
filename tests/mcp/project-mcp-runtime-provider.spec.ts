import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectMcpRuntimeProvider,
  type McpRuntimePort,
  type PilotDeckMcpServerSpec,
} from "../../src/mcp/index.js";

test("shared MCP generations retain their exact session leases across a plugin reload", async () => {
  const lifecycle: string[] = [];
  const provider = new ProjectMcpRuntimeProvider({
    projectRoot: "/tmp/pilotdeck-project-mcp-generation",
    pilotHome: "/tmp/pilotdeck-project-mcp-home",
    createRuntime: (servers) => runtimeFor(servers, lifecycle),
  });

  const old = await provider.acquireSharedRuntime({
    old_server: { url: "http://127.0.0.1:1/old" },
  });
  const sameGeneration = await provider.acquireSharedRuntime({
    old_server: { url: "http://127.0.0.1:1/old" },
  });
  const replacement = await provider.acquireSharedRuntime({
    new_server: { url: "http://127.0.0.1:1/new" },
  });

  assert.deepEqual(lifecycle, ["start:old_server", "start:new_server"]);
  assert.deepEqual(old.tools.map((tool) => tool.name), ["mcp__old_server__inspect"]);
  assert.deepEqual(replacement.tools.map((tool) => tool.name), ["mcp__new_server__inspect"]);

  await sameGeneration.release();
  assert.deepEqual(lifecycle, ["start:old_server", "start:new_server"]);

  await replacement.release();
  assert.deepEqual(lifecycle, ["start:old_server", "start:new_server", "stop:new_server"]);

  await old.release();
  assert.deepEqual(lifecycle, ["start:old_server", "start:new_server", "stop:new_server", "stop:old_server"]);
  await provider.dispose();
});

test("an unavailable replacement MCP generation does not stop a still-leased predecessor", async () => {
  const lifecycle: string[] = [];
  const diagnostics: string[] = [];
  const provider = new ProjectMcpRuntimeProvider({
    projectRoot: "/tmp/pilotdeck-project-mcp-failure",
    pilotHome: "/tmp/pilotdeck-project-mcp-home",
    createRuntime: (servers) => runtimeFor(servers, lifecycle, { failStartFor: "broken_server" }),
    onDiagnostic: (message) => diagnostics.push(message),
  });

  const old = await provider.acquireSharedRuntime({
    old_server: { url: "http://127.0.0.1:1/old" },
  });
  const unavailable = await provider.acquireSharedRuntime({
    broken_server: { url: "http://127.0.0.1:1/broken" },
  });

  assert.deepEqual(unavailable.tools, []);
  assert.deepEqual(lifecycle, ["start:old_server", "start:broken_server", "stop:broken_server"]);
  assert.ok(diagnostics.includes("MCP runtime startup partial-failed"));

  await old.release();
  assert.deepEqual(lifecycle, [
    "start:old_server",
    "start:broken_server",
    "stop:broken_server",
    "stop:old_server",
  ]);
  await provider.dispose();
});

function runtimeFor(
  servers: PilotDeckMcpServerSpec[],
  lifecycle: string[],
  options: { failStartFor?: string } = {},
): McpRuntimePort {
  const serverId = servers[0]?.id ?? "none";
  return {
    async start() {
      lifecycle.push(`start:${serverId}`);
      if (serverId === options.failStartFor) {
        throw new Error(`failed to start ${serverId}`);
      }
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
}
