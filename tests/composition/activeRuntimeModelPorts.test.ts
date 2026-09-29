import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveRuntimeModelPorts } from "../../src/composition/activeRuntimeModelPorts.js";
import { createRuntimeHostCapabilityProvider } from "../../src/composition/publicHostRuntimeAdapter.js";

const request = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const principal = { pilotDeckUserId: "pd", tenantId: "tenant", actorUserId: "actor" };

function fixture() {
  const seen: Array<Record<string, unknown>> = [];
  const model = {
    getCapabilities: () => ({ maxOutputTokens: 128 }),
    stream: (input: Record<string, unknown>, options: Record<string, unknown>) => {
      seen.push({ input, options });
      return (async function* () { yield { type: "text_delta", text: "real" }; })();
    },
  };
  const config = { providers: { p: { id: "p", models: { m: {
    id: "m", capabilities: { supportsStreaming: true, supportsToolUse: false,
      supportsSystemPrompt: true, maxOutputTokens: 128 }, multimodal: { input: ["text"] },
  } } } } };
  const catalog = async () => ({ items: [{ id: "p/m", provider: "p", model: "m", available: true }] });
  return { seen, ports: createActiveRuntimeModelPorts({ model: model as never, config: config as never, catalog: catalog as never }) };
}

test("prepare and stream use the same selected runtime, exact catalog ID and budget", async () => {
  const { ports, seen } = fixture();
  const prepared = await ports.prepare({ requestId: "r", modelId: "p/m", request, budget: { maxOutputTokens: 64 } });
  assert.deepEqual(prepared.selection, { requestedModelId: "p/m", selectedModelId: "m", providerId: "p" });
  assert.equal(prepared.request.maxOutputTokens, 64);
  const stream = await ports.stream({ requestId: "r", modelId: "p/m", request, budget: { maxOutputTokens: 64, timeoutMs: 1000 } });
  assert.equal(stream.headers["content-type"], "application/x-ndjson");
  const events = [];
  for await (const event of stream.body) events.push(event);
  assert.deepEqual(events, [{ type: "text_delta", text: "real" }]);
  assert.equal((seen[0]!.input as Record<string, unknown>).model, "m");
  assert.equal((seen[0]!.options as Record<string, unknown>).streamTimeoutMs, 1000);
});

test("unavailable or ambiguous IDs, source mismatch, and unmeasured input budget reject", async () => {
  const { ports, seen } = fixture();
  for (const input of [
    { modelId: "m", request },
    { modelId: "p/m", request: { ...request, provider: "other" } },
    { modelId: "p/m", request, budget: { maxInputTokens: 10 } },
    { modelId: "p/m", request, budget: { maxOutputTokens: 129 } },
  ]) await assert.rejects(ports.prepare({ requestId: "r", ...input }));
  assert.equal(seen.length, 0);
});

test("RPC mapper retains stream status and canonical validation error", async () => {
  const { ports } = fixture();
  const provider = createRuntimeHostCapabilityProvider({
    profile: { id: "active" }, model: ports, tools: {}, skills: {},
    context: { forTool: () => { throw Error("unbound"); } },
  });
  const ok = await provider.call("model_stream", { requestId: "r", modelId: "p/m", request }, { principal });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers?.["content-type"], "application/x-ndjson");
  const bad = await provider.call("model_prepare", { requestId: "r", modelId: "missing", request }, { principal });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { code: string }).code, "model_not_available");
});

test("public model stream rejects malformed canonical messages before runtime.stream", async () => {
  const { ports, seen } = fixture();
  const provider = createRuntimeHostCapabilityProvider({
    profile: { id: "active" }, model: ports, tools: {}, skills: {},
    context: { forTool: () => { throw Error("unbound"); } },
  });
  for (const request of [
    { messages: [{ role: "user", content: "hello" }] },
    { messages: [{ role: "user", content: [] }] },
    { messages: [] },
  ]) {
    const response = await provider.call(
      "model_stream",
      { requestId: "r", modelId: "p/m", request },
      { principal },
    );
    assert.equal(response.status, 400);
    assert.equal((response.body as { code: string }).code, "invalid_request");
  }
  assert.equal(seen.length, 0);
});
