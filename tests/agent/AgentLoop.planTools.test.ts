import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentLoop } from "../../src/agent/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDependencies } from "../../src/agent/index.js";
import type { CanonicalModelRequest } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { createBuiltinRegistry } from "../../src/tool/index.js";

function makeLoop(mode: AgentRuntimeConfig["permissionMode"] = "default") {
  const requests: CanonicalModelRequest[] = [];
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "model",
    cwd: "/tmp/pilotdeck-test",
    permissionMode: mode,
    permissionContext: createDefaultPermissionContext({
      cwd: "/tmp/pilotdeck-test",
      mode,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
      decide: async ({ request }) => {
        requests.push(request);
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      execute: async function* () {
        yield { type: "message_start", role: "assistant" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () {},
    },
    tools: {
      registry: createBuiltinRegistry(),
      scheduler: {
        executeAll: async () => [],
      },
    },
    now: () => new Date(0),
  };

  return { loop: new AgentLoop(config, dependencies), requests };
}

async function runOnce(loop: AgentLoop, options: { allowPlanModeTools?: boolean; permissionMode?: AgentRuntimeConfig["permissionMode"] } = {}) {
  for await (const _event of loop.run({
    sessionId: "s",
    turnId: "t",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTurns: 1,
    ...options,
  })) {
    // drain
  }
}

test("agent loop hides plan mode tools when not explicitly allowed", async () => {
  const { loop, requests } = makeLoop();

  await runOnce(loop);

  const toolNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.equal(toolNames.includes("enter_plan_mode"), false);
  assert.equal(toolNames.includes("exit_plan_mode"), false);
});

test("agent loop exposes exit_plan_mode during explicit plan turns", async () => {
  const { loop, requests } = makeLoop();

  await runOnce(loop, { permissionMode: "plan", allowPlanModeTools: true });

  const toolNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.equal(toolNames.includes("enter_plan_mode"), false);
  assert.equal(toolNames.includes("exit_plan_mode"), true);
});
