import assert from "node:assert/strict";
import test from "node:test";

import { StaffDeckSopDiscoveryClient } from "../../src/sop/staffdeck/StaffDeckSopDiscoveryClient.js";

test("StaffDeck discovery client sends the authenticated native route request", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new StaffDeckSopDiscoveryClient("https://staffdeck.test/api/v1", "agent-1", "sd_live_secret", {
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        decision: "start_new_task",
        selected_sop_id: "purchase",
        target_step_id: "start",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.route({ message: "buy something", sessionId: "session-1" });
  assert.equal(result.selectedSopId, "purchase");
  assert.equal(request?.url, "https://staffdeck.test/api/v1/agents/agent-1/sops:route");
  assert.equal(request?.init?.headers && new Headers(request.init.headers).get("authorization"), "Bearer sd_live_secret");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    message: "buy something",
    model_source: "pilotdeck_host",
    session_id: "session-1",
  });
});
