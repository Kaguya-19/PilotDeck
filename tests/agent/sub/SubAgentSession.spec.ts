import assert from "node:assert/strict";
import test from "node:test";

import { SubAgentSession } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import {
  ToolRegistry,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

function createNoopTool(
  name: string,
  isReadOnly: PilotDeckToolDefinition["isReadOnly"],
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      data: {},
    }),
  };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

test("explore subagent ignores unrelated input-sensitive read-only tools", async () => {
  const readOnlyChecks: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createNoopTool("execute_code", (input) => {
    readOnlyChecks.push("execute_code");
    return (input as { code: string }).code.length === 0;
  }));
  registry.register(createNoopTool("read_file", () => {
    readOnlyChecks.push("read_file");
    return true;
  }));

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the provided files.",
    parentConfig: {
      provider: "test",
      model: "test-model",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: process.cwd(),
        mode: "bypassPermissions",
        canPrompt: true,
        bypassAvailable: true,
      }),
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown, FINAL_REPORT);
  assert.deepEqual(readOnlyChecks, ["read_file"]);
});
