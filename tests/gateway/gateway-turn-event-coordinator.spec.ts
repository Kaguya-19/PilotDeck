import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayTurnEventCoordinator } from "../../src/gateway/client/GatewayTurnEventCoordinator.js";
import type { GatewayTurnEventCoordinatorPort } from "../../src/gateway/client/GatewayTurnEventCoordinatorPort.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("GatewayTurnEventCoordinator publishes a run-scoped live event and keeps bounded terminal replay", () => {
  const events: unknown[] = [];
  const coordinator = new GatewayTurnEventCoordinator();
  coordinator.start("web:event", "run-event", (event) => { events.push(event); });
  coordinator.record("web:event", { type: "assistant_text_delta", text: "recorded" });
  assert.equal(coordinator.emit("web:event", { type: "agent_status", event: "retry_progress" }), true);
  assert.deepEqual(events, [{ type: "agent_status", event: "retry_progress", runId: "run-event" }]);
  assert.deepEqual(coordinator.snapshot({ sessionKey: "web:event" }), {
    active: true,
    sessionKey: "web:event",
    runId: "run-event",
    events: [
      { type: "assistant_text_delta", text: "recorded" },
      { type: "agent_status", event: "retry_progress", runId: "run-event" },
    ],
  });

  coordinator.retainTerminal("web:event", "run-event");
  assert.equal(coordinator.emit("web:event", { type: "assistant_text_delta", text: "late" }), false);
  assert.equal(coordinator.snapshot({ sessionKey: "web:event" }).terminal, true);
  coordinator.dispose();
  assert.deepEqual(coordinator.snapshot({ sessionKey: "web:event" }), {
    active: false,
    sessionKey: "web:event",
    events: [],
  });
});

test("InProcessGateway delegates live event/replay ownership to an injected coordinator", async () => {
  const calls: string[] = [];
  const coordinator: GatewayTurnEventCoordinatorPort = {
    start: () => { calls.push("start"); },
    record: () => { calls.push("record"); },
    emit: () => {
      calls.push("emit");
      return true;
    },
    retainTerminal: () => { calls.push("retain"); },
    snapshot: (input) => {
      calls.push("snapshot");
      return { active: false, sessionKey: input.sessionKey, events: [] };
    },
    dispose: () => { calls.push("dispose"); },
  };
  const gateway = new InProcessGateway({} as SessionRouter, { turnEventCoordinator: coordinator });

  assert.equal(gateway.emitForSession("web:injected-event", { type: "assistant_text_delta", text: "visible" }), true);
  assert.deepEqual(await gateway.getActiveTurnSnapshot({ sessionKey: "web:injected-event" }), {
    active: false,
    sessionKey: "web:injected-event",
    events: [],
  });
  gateway.dispose();
  assert.deepEqual(calls, ["emit", "snapshot", "dispose"]);
});
