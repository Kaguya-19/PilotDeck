import assert from "node:assert/strict";
import test from "node:test";

import { noopCustomRouterRegistry, type PilotDeckCustomRouter } from "../../src/router/customRouter/customRouter.js";

test("noop custom router registry has no implicit routing behavior", async () => {
  assert.equal(noopCustomRouterRegistry.lookupRouter("missing"), undefined);
  const router: PilotDeckCustomRouter = {
    id: "custom",
    decide: async () => ({ provider: "openai", model: "custom-model" }),
  };
  assert.deepEqual(await router.decide({
    context: { sessionId: "session", isMainAgent: true, scenarios: [] },
    request: { provider: "openai", model: "base", messages: [], tools: [] },
  } as never), { provider: "openai", model: "custom-model" });
});
