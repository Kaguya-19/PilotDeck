import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { createNodeStdioLspProvider } from "../../src/lsp/index.js";

test("node stdio provider initializes, opens a document, normalizes locations, and tears down", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-lsp-"));
  const server = join(root, "server.mjs");
  const source = join(root, "index.ts");
  await writeFile(source, "const answer = 42;\n", "utf8");
  await writeFile(server, `
let buffer = Buffer.alloc(0);
let initializeId;
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n');
    if (split < 0) break;
    const match = /Content-Length: (\\d+)/i.exec(buffer.subarray(0, split).toString('ascii'));
    if (!match) process.exit(2);
    const size = Number(match[1]);
    const start = split + 4;
    if (buffer.length < start + size) break;
    const msg = JSON.parse(buffer.subarray(start, start + size).toString('utf8'));
    buffer = buffer.subarray(start + size);
    if (msg.method === 'exit') process.exit(0);
    if (msg.id === 99 && msg.result?.[0]?.strict === true && initializeId !== undefined) {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: initializeId, result: { capabilities: { definitionProvider: true, textDocumentSync: { openClose: true } } } }));
      process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
      process.stdout.write(body);
      initializeId = undefined;
      continue;
    }
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      initializeId = msg.id;
      const config = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: { items: [{ section: 'typescript' }] } }));
      process.stdout.write('Content-Length: ' + config.length + '\\r\\n\\r\\n');
      process.stdout.write(config);
      continue;
    }
    let result = null;
    if (msg.method === 'textDocument/definition') result = [{ uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }];
    if (msg.method === 'shutdown') result = null;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
    process.stdout.write(body);
  }
});
`, "utf8");
  const provider = createNodeStdioLspProvider({
    id: "typescript",
    command: execPath,
    args: [server],
    extensionToLanguage: { ".ts": "typescript" },
    configuration: { typescript: { strict: true } },
  });
  try {
    const result = await provider.query({
      operation: "goToDefinition",
      filePath: source,
      position: { line: 0, character: 6 },
      workspaceRoot: root,
      languageId: "typescript",
    });
    assert.equal(result.kind, "locations");
    if (result.kind === "locations") {
      assert.equal(result.locations.length, 1);
      assert.match(result.locations[0]!.uri, /^file:/u);
      assert.equal(result.resolvedWorkspaceUri, `file://${root}`);
    }
  } finally {
    await provider.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("node stdio provider maps a stalled server request to LSP_TIMEOUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-lsp-timeout-"));
  const server = join(root, "server.mjs");
  const source = join(root, "index.ts");
  await writeFile(source, "const answer = 42;\n", "utf8");
  await writeFile(server, `process.stdin.resume();`, "utf8");
  const provider = createNodeStdioLspProvider({
    id: "typescript-timeout",
    command: execPath,
    args: [server],
    extensionToLanguage: { ".ts": "typescript" },
    requestTimeoutMs: 20,
    shutdownTimeoutMs: 20,
  });
  try {
    await assert.rejects(
      provider.query({
        operation: "hover",
        filePath: source,
        position: { line: 0, character: 0 },
        workspaceRoot: root,
        languageId: "typescript",
      }),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "LSP_TIMEOUT",
    );
  } finally {
    await provider.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
