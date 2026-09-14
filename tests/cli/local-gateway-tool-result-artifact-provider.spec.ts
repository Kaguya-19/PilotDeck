import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type {
  GatewayToolResultArtifactInput,
  GatewayToolResultArtifactStorePort,
} from "../../src/gateway/index.js";
import {
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type ModelRuntime,
  type MultimodalConstraints,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

test("local gateway projects tool results through an application-selected advisory artifact store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-artifact-provider-"));
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

  const persisted: GatewayToolResultArtifactInput[] = [];
  const artifactStore: GatewayToolResultArtifactStorePort = {
    persist(input) {
      persisted.push(input);
      return `/preview/${input.sessionId}/${input.turnId}/${input.toolCallId}.txt`;
    },
  };
  const model = new ToolResultModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    permissionMode: "bypassPermissions",
    toolResultArtifactStore: artifactStore,
    __testModelFactory: () => model,
    extraTools: [{
      name: "preview_probe",
      description: "Returns a result that must be projected by the Gateway.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute() {
        return { content: [{ type: "text", text: "provider-owned live preview" }] };
      },
    } satisfies PilotDeckToolDefinition],
  });
  t.after(() => local.dispose());

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "artifact-provider-session",
    channelKey: "test",
    projectKey: root,
    message: "Run the preview probe.",
  })) {
    events.push(event);
  }

  assert.equal(model.requests, 2);
  assert.deepEqual(persisted.map((item) => ({
    sessionId: item.sessionId,
    toolCallId: item.toolCallId,
    text: item.text,
  })), [{
    sessionId: "artifact-provider-session",
    toolCallId: "preview-probe-call",
    text: "provider-owned live preview",
  }]);
  const finished = events.find((event) => event.type === "tool_call_finished");
  assert.ok(finished && finished.type === "tool_call_finished");
  assert.equal(finished.resultPath?.startsWith("/preview/artifact-provider-session/"), true);
});

class ToolResultModel implements ModelRuntime {
  requests = 0;

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    if (!hasToolResult(request, "preview-probe-call")) {
      yield { type: "tool_call_start", id: "preview-probe-call", name: "preview_probe" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "preview-probe-call", name: "preview_probe", input: {} },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "preview projected" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

function hasToolResult(request: CanonicalModelRequest, toolCallId: string): boolean {
  return request.messages.some((message) => message.content.some(
    (block) => block.type === "tool_result" && block.toolCallId === toolCallId,
  ));
}
