import assert from "node:assert/strict";
import test from "node:test";
import { loadBuiltinPlugins } from "../../src/extension/plugins/builtin/loadBuiltinPlugins.js";

test("browser-use builtin exposes lazy install skill", () => {
  const browserUse = loadBuiltinPlugins().find((plugin) => plugin.name === "browser-use");

  assert.ok(browserUse, "browser-use builtin plugin should load");
  assert.ok(browserUse.manifest.mcpServers?.["browser-use"], "browser-use MCP server should remain configured");
  const skill = browserUse.skills?.find((entry) => entry.name === "browser-use-install");
  assert.ok(skill, "browser-use-install skill should load");
  assert.match(
    String(skill.frontmatter.description ?? ""),
    /browser-use|Playwright MCP|missing browser|Executable doesn't exist/,
  );
});
