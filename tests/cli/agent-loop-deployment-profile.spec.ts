import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAgentLoopDeploymentFactory,
  resolveAgentLoopDeploymentProfile,
} from "../../src/cli/AgentLoopDeploymentProfile.js";
import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { ModelInvokerPort, ToolPort } from "../../src/agent/modules/protocol.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

test("agent loop deployment profile defaults to native execution", () => {
  const profile = resolveAgentLoopDeploymentProfile({ env: {} });

  assert.deepEqual(profile, { transport: "native" });
  assert.equal(createAgentLoopDeploymentFactory(profile), undefined);
});

test("agent loop deployment profile resolves a bounded external TCP provider", () => {
  const profile = resolveAgentLoopDeploymentProfile({
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: "127.0.0.8",
      PILOTDECK_AGENT_LOOP_TCP_PORT: "32123",
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "456",
    },
  });

  assert.deepEqual(profile, {
    transport: "tcp",
    host: "127.0.0.8",
    port: 32123,
    connectTimeoutMs: 456,
  });
  assert.equal(typeof createAgentLoopDeploymentFactory(profile), "function");
});

test("stdio deployment starts the bundled sidecar without inheriting TCP listener state", () => {
  const profile = resolveAgentLoopDeploymentProfile({
    cwd: "/workspace",
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "stdio",
      PILOTDECK_AGENT_LOOP_TCP_HOST: "127.0.0.1",
      PILOTDECK_AGENT_LOOP_TCP_PORT: "32123",
    },
  });

  assert.equal(profile.transport, "stdio");
  if (profile.transport !== "stdio") return;
  assert.equal(profile.command, process.execPath);
  assert.equal(basename(profile.args[0]!), "pilotdeck-agent-loop-sidecar.js");
  assert.equal(profile.env.PILOTDECK_AGENT_LOOP_TCP_HOST, undefined);
  assert.equal(profile.env.PILOTDECK_AGENT_LOOP_TCP_PORT, undefined);
});

test("deployment factory forwards a passive observer to the bundled stdio sidecar", async () => {
  const observations: string[] = [];
  const factory = createAgentLoopDeploymentFactory({
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("../../src/cli/pilotdeck-agent-loop-sidecar.js", import.meta.url))],
    env: {},
  }, {
    transportObserver: { observe: (observation) => { observations.push(observation.type); } },
  });
  assert.ok(factory);
  const session = createAgentSession({
    sessionId: "deployment-observer-session",
    config: {
      provider: "host-provider",
      model: "host-model",
      cwd: "/workspace",
      permissionMode: "default",
      permissionContext: createDefaultPermissionContext({ cwd: "/workspace", canPrompt: false }),
    },
    dependencies: {
      router: {} as never,
      ports: { model: completedModel(), tools: noTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "observe deployment" }, {
    turnId: "deployment-observer-turn",
  })) events.push(event);

  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.deepEqual(observations, ["stream_accepted"]);
});

test("agent loop deployment profile rejects incomplete or unknown transport configuration", () => {
  assert.throws(
    () => resolveAgentLoopDeploymentProfile({ env: { PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp" } }),
    /PILOTDECK_AGENT_LOOP_TCP_PORT is required/,
  );
  assert.throws(
    () => resolveAgentLoopDeploymentProfile({
      env: {
        PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
        PILOTDECK_AGENT_LOOP_TCP_PORT: "invalid",
      },
    }),
    /PILOTDECK_AGENT_LOOP_TCP_PORT must be an integer/,
  );
  assert.throws(
    () => resolveAgentLoopDeploymentProfile({ env: { PILOTDECK_AGENT_LOOP_TRANSPORT: "remote" } }),
    /PILOTDECK_AGENT_LOOP_TRANSPORT must be native, stdio, or tcp/,
  );
});

function completedModel(): ModelInvokerPort {
  return {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "deployment observed" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
}

function noTools(): ToolPort {
  return { list: () => [], executeAll: async () => [] };
}
