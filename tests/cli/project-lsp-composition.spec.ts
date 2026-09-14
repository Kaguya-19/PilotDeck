import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { LspService, type LspServicePort } from "../../src/lsp/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalModelResponse, ModelRuntime, MultimodalConstraints } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

test("Local Gateway composes the selected LSP provider into a real model tool turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-lsp-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  const service = new LspService();
  const queries: unknown[] = [];
  const release = service.registerProvider({
    id: "fake-ts",
    extensionToLanguage: { ".ts": "typescript" },
    query: async (request) => {
      queries.push(request);
      return { kind: "hover" as const, hover: { contents: "selected provider result" } };
    },
  });
  const model = new LspCallingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: { PILOT_HOME: root },
    __testModelFactory: () => model,
    lspServiceFactory: () => service,
  });
  t.after(async () => {
    await local.dispose();
    await release();
    await service.dispose();
  });

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "lsp-composition-session",
    channelKey: "test",
    projectKey: root,
    message: "Inspect this TypeScript symbol.",
  })) events.push(event);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], {
    operation: "hover",
    filePath: "src/index.ts",
    position: { line: 1, character: 2 },
    workspaceRoot: root,
    languageId: "typescript",
  });
  assert.ok(events.some((event) => event.type === "tool_call_finished" && JSON.stringify(event).includes("selected provider result")));
});

class LspCallingModel implements ModelRuntime {
  private requestCount = 0;

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requestCount += 1;
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    const hasResult = request.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
    if (!hasResult) {
      yield { type: "tool_call_start", id: "lsp-call", name: "lsp" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "lsp-call", name: "lsp", input: { operation: "hover", file_path: "src/index.ts", line: 2, character: 3 } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "LSP complete." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> { return { role: "assistant", content: [], finishReason: "stop" }; }
  getCapabilities() { return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true, maxContextTokens: 128_000, maxOutputTokens: 8_192 }; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}
