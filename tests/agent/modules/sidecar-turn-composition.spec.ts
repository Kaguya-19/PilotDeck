import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultSidecarTurnComposition,
  resolveSidecarTurnCompositionHandlers,
} from "../../../src/agent/modules/transport/sidecarTurnComposition.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { SidecarModuleComposition } from "../../../src/agent/modules/transport/sidecarHostModulePorts.js";

const config: AgentRuntimeConfig = {
  provider: "test",
  model: "test",
  cwd: "/tmp",
  permissionMode: "default",
  permissionContext: createDefaultPermissionContext({ cwd: "/tmp", mode: "default", canPrompt: false }),
};

const modules = {
  model: {},
  capability: { runtimeContext: {} },
} as unknown as SidecarModuleComposition;

test("default sidecar turn composition owns permission mode outside transport", () => {
  const composition = createDefaultSidecarTurnComposition({
    config,
    modules,
  });
  composition.forTurn({ sessionId: "session", turnId: "turn", messages: [], permissionMode: "plan", basePermissionMode: "default" });
  assert.equal(config.permissionMode, "plan");
  assert.equal(config.permissionContext.mode, "plan");
});

test("default sidecar turn composition keeps plan/todo handler turn-bound", async () => {
  const composition = createDefaultSidecarTurnComposition({
    config: { ...config, permissionContext: { ...config.permissionContext } },
    modules,
  });
  const turn = composition.forTurn({ sessionId: "session", turnId: "turn", messages: [] });
  await assert.rejects(
    turn.planTodoHandler({ module: "capability", payload: {}, runId: "run", operationId: "operation", requestId: "request" } as never),
    /Host did not provide a plan\/todo capability/,
  );
});

test("per-module handler factories receive only their own module port", () => {
  const seen: string[] = [];
  const registry = resolveSidecarTurnCompositionHandlers({
    config,
    modules,
    turn: { sessionId: "session", turnId: "turn", messages: [] },
  }, {
    capability: ({ port }) => {
      seen.push("runtimeContext" in port ? "capability" : "unexpected");
      assert.equal("permission" in port, false);
      assert.equal("model" in port, false);
      return async () => ({ ok: true });
    },
  });
  assert.deepEqual(seen, ["capability"]);
  assert.ok(registry?.capability);
  assert.equal(registry?.permission, undefined);
});

test("module handler factories receive a narrow turn view", () => {
  let received: Record<string, unknown> | undefined;
  resolveSidecarTurnCompositionHandlers({
    config,
    modules,
    turn: {
      sessionId: "session",
      turnId: "turn",
      messages: [],
      execution: { runId: "run", operationId: "operation", operationDeadline: "2099-01-01T00:00:00.000Z" },
    },
  }, {
    capability: ({ turn }) => {
      received = turn as unknown as Record<string, unknown>;
      return async () => ({ ok: true });
    },
  });
  assert.deepEqual(received, {
    sessionId: "session",
    turnId: "turn",
    runId: "run",
    operationId: "operation",
    operationDeadline: "2099-01-01T00:00:00.000Z",
  });
  assert.equal("messages" in (received ?? {}), false);
  assert.equal("permissionRules" in (received ?? {}), false);
  assert.equal("cwd" in (received ?? {}), false);
});
