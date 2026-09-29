import assert from "node:assert/strict";
import test from "node:test";

import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "../../src/gateway/permission/GatewaySessionPermissionModeRegistry.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("Gateway carries successful plan transitions into later turns and restores on exit", async () => {
  const modes = new GatewaySessionPermissionModeRegistry();
  const submittedModes: Array<string | undefined> = [];
  const submittedBaseModes: Array<string | undefined> = [];
  let submitCount = 0;
  const session = fakeSession(() => {
    submitCount += 1;
    if (submitCount === 1) return "plan";
    if (submitCount === 3) return "default";
    return undefined;
  }, (mode) => submittedModes.push(mode), (_mode, baseMode) => submittedBaseModes.push(baseMode));
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, {
    uuid: (() => {
      let next = 0;
      return () => `run-${++next}`;
    })(),
    permissionModes: modes,
    defaultPermissionMode: "default",
  });

  for (let index = 0; index < 4; index += 1) {
    for await (const _event of gateway.submitTurn({
      sessionKey: "session-mode",
      channelKey: "test",
      message: `turn-${index}`,
    })) {
      // Drain the stream so Gateway finalization records the live mode.
    }
  }

  assert.deepEqual(submittedModes.slice(1), ["plan", "plan", "default"]);
  assert.deepEqual(submittedBaseModes.slice(1), ["default", "default", "default"]);
  assert.equal(modes.get("session-mode"), "default");

  await gateway.closeSession({ sessionKey: "session-mode" });
  assert.equal(modes.get("session-mode"), undefined);
});

test("permission mode registry clears volatile session state", () => {
  const registry = new GatewaySessionPermissionModeRegistry();
  registry.transition("session-a", "plan", "default");
  assert.equal(registry.get("session-a"), "plan");
  assert.equal(registry.getBase("session-a"), "default");
  registry.transition("session-a", "default");
  assert.equal(registry.getBase("session-a"), undefined);
  registry.clear("session-a");
  assert.equal(registry.get("session-a"), undefined);
  registry.set("session-b", "default");
  registry.dispose();
  assert.equal(registry.get("session-b"), undefined);
});

test("Gateway uses the application base permission mode when client mode is omitted", async () => {
  const submitted: Array<{ mode?: string; baseMode?: string }> = [];
  const session = fakeSession(
    () => undefined,
    () => undefined,
    (mode, baseMode) => submitted.push({ mode, baseMode }),
  );
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, { defaultPermissionMode: "default" });

  for await (const _event of gateway.submitTurn({
    sessionKey: "session-base-mode",
    channelKey: "test",
    message: "turn",
  })) {
    // Drain the turn.
  }

  assert.deepEqual(submitted, [{ mode: "default", baseMode: "default" }]);
});

test("Gateway remains compatible with permission mode ports that only implement get and set", async () => {
  const stored = new Map<string, "default" | "plan">();
  const legacyPort: GatewaySessionPermissionModePort = {
    get: (sessionKey) => stored.get(sessionKey),
    set: (sessionKey, mode) => stored.set(sessionKey, mode as "default" | "plan"),
    clear: (sessionKey) => { stored.delete(sessionKey); },
    dispose: () => { stored.clear(); },
  };
  const session = fakeSession(() => "plan", () => undefined);
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, {
    permissionModes: legacyPort,
    defaultPermissionMode: "default",
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "legacy-port",
    channelKey: "test",
    message: "enter plan",
  })) {
    // Drain the turn so the mode transition is applied.
  }

  assert.equal(stored.get("legacy-port"), "plan");
});

function fakeSession(
  requestedMode: () => "plan" | "default" | undefined,
  observeMode: (mode: string | undefined) => void,
  observeModes?: (mode: string | undefined, baseMode: string | undefined) => void,
): AgentSession {
  return {
    async *submit(_input: AgentInput, options: AgentSubmitOptions = {}) {
      observeMode(options.permissionMode);
      observeModes?.(options.permissionMode, options.basePermissionMode);
      const turnId = options.turnId ?? "turn-mode";
      yield { type: "turn_started", sessionId: "session-mode", turnId };
      const mode = requestedMode();
      if (mode) {
        yield { type: "mode_change_requested", sessionId: "session-mode", turnId, mode };
      }
      yield {
        type: "turn_completed",
        sessionId: "session-mode",
        turnId,
        result: {
          type: "success",
          sessionId: "session-mode",
          turnId: options.turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-12T00:00:00.000Z",
          completedAt: "2026-09-12T00:00:01.000Z",
        },
      };
    },
    abort() {},
    snapshot() {
      return {
        sessionId: "session-mode",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}
