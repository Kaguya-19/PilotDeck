import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeUnicodeString, recursivelySanitizeUnicode } from "../../src/mcp/runtime/sanitize.js";
import { buildMcpToolWireName, parseMcpToolWireName } from "../../src/mcp/runtime/wireName.js";
import { MAX_MCP_TOOL_DESCRIPTION_LENGTH, truncateMcpToolDescription } from "../../src/mcp/runtime/truncate.js";
import { loadMcpServerConfig } from "../../src/mcp/config/loadMcpServerConfig.js";
import { parsePluginMcpServers } from "../../src/mcp/runtime/parsePluginMcpServers.js";

test("MCP sanitization removes bidi controls recursively but keeps visible text", () => {
  assert.equal(sanitizeUnicodeString("a\u202Eb"), "ab");
  assert.deepEqual(recursivelySanitizeUnicode({ "bad\u200Fkey": "x\u200B", nested: ["中\uFFFD"] }), { "badkey": "x", nested: ["中"] });
});

test("MCP wire names round-trip safe segments", () => {
  const wire = buildMcpToolWireName("server one", "read/file");
  assert.equal(wire, "mcp__server_one__read_file");
  assert.deepEqual(parseMcpToolWireName(wire), { serverId: "server_one", toolName: "read_file" });
  assert.equal(parseMcpToolWireName("not-mcp"), null);
  assert.equal(parseMcpToolWireName("mcp____tool"), null);
});

test("MCP descriptions are truncated only above the protocol cap", () => {
  assert.equal(truncateMcpToolDescription("short"), "short");
  const result = truncateMcpToolDescription("x".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH + 10));
  assert.equal(result.length, MAX_MCP_TOOL_DESCRIPTION_LENGTH + "… [truncated]".length);
  assert.match(result, /truncated/);
});

test("MCP config merges global and project servers and reports malformed files", async () => {
  const home = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-home-"));
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-project-"));
  try {
    await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { global: { command: "${env:MCP_CMD}" } } }));
    await writeFile(join(project, ".pilotdeck-mcp-placeholder"), "");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(project, ".pilotdeck"), { recursive: true }));
    await writeFile(join(project, ".pilotdeck", "mcp.json"), "not-json");
    const result = loadMcpServerConfig(project, home);
    assert.ok(result.servers.global);
    assert.equal(result.diagnostics.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("MCP config rejects invalid roots and non-object server maps without throwing", async () => {
  const home = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-invalid-home-"));
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-invalid-project-"));
  try {
    await writeFile(join(home, "mcp.json"), JSON.stringify([]));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(project, ".pilotdeck"), { recursive: true }));
    await writeFile(join(project, ".pilotdeck", "mcp.json"), JSON.stringify({ mcpServers: [] }));
    const invalid = loadMcpServerConfig(project, home);
    assert.deepEqual(invalid.servers, {});
    assert.deepEqual(invalid.diagnostics.map((item) => item.message), [
      "MCP config root must be an object.",
      "mcpServers must be an object.",
    ]);

    await rm(join(home, "mcp.json"), { force: true });
    await rm(join(project, ".pilotdeck", "mcp.json"), { force: true });
    assert.deepEqual(loadMcpServerConfig(project, home), { servers: {}, diagnostics: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("plugin MCP parser accepts stdio/http and records unsupported entries", () => {
  const result = parsePluginMcpServers({
    stdio: { command: "node", args: ["${env:ARG}", 1], env: { TOKEN: "${env:TOKEN}" }, callTimeoutMs: 100 },
    http: { httpUrl: "https://mcp.test", headers: { Authorization: "Bearer ${env:TOKEN}" } },
    bad: { name: "unknown" },
  });
  assert.equal(result.servers.length, 2);
  assert.equal(result.servers[0].transport, "stdio");
  assert.equal(result.servers[1].transport, "streamable_http");
  assert.equal(result.diagnostics.length, 1);
});
