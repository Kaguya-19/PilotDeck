import assert from "node:assert/strict";
import test from "node:test";

import { createNativeHostCapabilityProvider, type NativePublicHostRuntime } from "../../src/composition/nativeHostCapabilityProvider.js";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../src/model/protocol/canonical.js";

test("native host catalog and stream use the same selected provider/model", async () => {
  const config = parseModelConfig({ providers: { provider1: { protocol: "openai",
    url: "https://model.test/v1", apiKey: "test-key", models: { selected: {} } } } });
  const requests: CanonicalModelRequest[] = [];
  const runtime = {
    modelConfig: config,
    defaultSelection: { provider: "provider1", model: "selected" },
    modelRuntime: { stream(request: CanonicalModelRequest) {
      requests.push(request);
      return (async function* () { yield { type: "text_delta", text: "{}" }; yield { type: "message_end", finishReason: "stop" }; })();
    } },
  } as unknown as NativePublicHostRuntime;
  const provider = createNativeHostCapabilityProvider(runtime);
  const options = { principal: { pilotDeckUserId: "pd", tenantId: "tenant", actorUserId: "actor", agentId: "target" } };
  const catalog = await provider.call("list_model_catalog", {}, options);
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body, { data: [{ id: "provider1/selected", name: "selected",
    model: "selected", provider: "provider1", enabled: true, is_default: true }] });
  const request = { provider: "provider1", model: "selected", systemPrompt: "Choose a visible SOP",
    messages: [{ role: "user", content: [{ type: "text", text: "route" }] }], stream: true };
  const response = await provider.call("model_stream", { modelId: "provider1/selected", request }, options);
  assert.equal(response.status, 200);
  assert.equal(response.headers?.["content-type"], "application/x-ndjson");
  assert.deepEqual(requests, [request]);
  const wrong = await provider.call("model_stream", { modelId: "provider1/other", request }, options);
  assert.notEqual(wrong.status, 200);
  assert.equal(requests.length, 1);
});
