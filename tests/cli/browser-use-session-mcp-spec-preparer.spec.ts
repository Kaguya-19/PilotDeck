import assert from "node:assert/strict";
import test from "node:test";

import { BrowserUseSessionMcpSpecPreparer } from "../../src/cli/BrowserUseSessionMcpSpecPreparer.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

test("browser-use session MCP preparer scopes only the browser process to its session output directory", () => {
  const directories: string[] = [];
  const argsCalls: Array<{
    baseArgs: string[];
    outputDir: string;
    configProxy?: { url?: string; noProxy?: string };
  }> = [];
  const preparer = new BrowserUseSessionMcpSpecPreparer({
    env: { TEST_ENV: "1" },
    createDirectory: (path) => { directories.push(path); },
    buildArgs: (baseArgs, outputDir, _env, configProxy) => {
      argsCalls.push({ baseArgs, outputDir, configProxy });
      return [...baseArgs, "--output-dir", outputDir];
    },
  });
  const http = {
    id: "shared",
    transport: "streamable_http" as const,
    url: "http://127.0.0.1:3000/mcp",
  };
  const prepared = preparer.prepare({
    projectRoot: "/workspace/project",
    sessionKey: "channel/session:1",
    proxy: { url: "http://proxy.test:7890", noProxy: "internal.test" },
    specs: [
      http,
      {
        id: "browser-use",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        perSession: true,
      },
      {
        id: "other-stdio",
        transport: "stdio",
        command: "node",
        args: ["other.mjs"],
        perSession: true,
      },
    ],
  });

  const outputDir = `/workspace/project/.pilotdeck/browser_screenshots/${sanitizeSessionIdForPath("channel/session:1")}`;
  assert.equal(prepared[0], http);
  assert.deepEqual(prepared[1], {
    id: "browser-use",
    transport: "stdio",
    command: "node",
    args: ["server.mjs", "--output-dir", outputDir],
    cwd: outputDir,
    perSession: true,
  });
  assert.deepEqual(prepared[2], {
    id: "other-stdio",
    transport: "stdio",
    command: "node",
    args: ["other.mjs"],
    perSession: true,
  });
  assert.deepEqual(directories, [outputDir]);
  assert.deepEqual(argsCalls, [{
    baseArgs: ["server.mjs"],
    outputDir,
    configProxy: { url: "http://proxy.test:7890", noProxy: "internal.test" },
  }]);
});
