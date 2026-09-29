import assert from "node:assert/strict";
import test from "node:test";
import { LspError, LspService } from "../../src/lsp/index.js";
import { createLspTool } from "../../src/tool/builtin/lsp.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";

test("LSP service selects providers by extension and releases exact provider ownership", async () => {
  const service = new LspService();
  let disposed = 0;
  const registration = service.registerProvider({
    id: "fake-ts",
    extensionToLanguage: { ".ts": "typescript" },
    query: async (request) => ({
      kind: "locations" as const,
      locations: [{ uri: `file://${request.languageId}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      resolvedWorkspaceUri: "file:///workspace",
    }),
    dispose: () => { disposed += 1; },
  });

  const result = await service.query({
    operation: "goToDefinition",
    filePath: "src/index.ts",
    position: { line: 0, character: 0 },
    workspaceRoot: "/workspace",
  });
  assert.equal(result.kind, "locations");
  if (result.kind === "locations") assert.equal(result.locations[0]?.uri, "file://typescript");
  await registration();
  await registration();
  assert.equal(disposed, 1);
  await assert.rejects(
    service.query({ operation: "hover", filePath: "src/index.ts", position: { line: 0, character: 0 }, workspaceRoot: "/workspace" }),
    (error: unknown) => error instanceof LspError && error.code === "LSP_UNAVAILABLE",
  );
  await service.dispose();
});

test("lsp tool is a real consumer of the service and converts one-based coordinates", async () => {
  let received: unknown;
  const tool = createLspTool({
    registerProvider: () => async () => {},
    query: async (request) => {
      received = request;
      return { kind: "hover" as const, hover: { contents: "symbol" } };
    },
    dispose: async () => {},
  });
  const output = await tool.execute({ operation: "hover", file_path: "src/a.ts", line: 3, character: 7 }, {
    sessionId: "session",
    turnId: "turn",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace" }),
  });
  assert.deepEqual(received, {
    operation: "hover",
    filePath: "src/a.ts",
    position: { line: 2, character: 6 },
    workspaceRoot: "/workspace",
  });
  assert.equal(output.data?.kind, "hover");
  assert.match(output.content[0]?.type === "text" ? output.content[0].text : "", /symbol/);
});
