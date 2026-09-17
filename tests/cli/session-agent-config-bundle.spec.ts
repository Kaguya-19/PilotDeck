import assert from "node:assert/strict";
import test from "node:test";

import { SessionAgentConfigBundle } from "../../src/cli/SessionAgentConfigBundle.js";
import type { ModelRuntime } from "../../src/model/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/index.js";

test("session agent config bundle freezes model, permission, workspace, and subagent selections", () => {
  const config = new SessionAgentConfigBundle({
    runtime: {
      projectRoot: "/project",
      snapshot: snapshot(),
      profile: { runtimeContextSurface: "user_message" },
      model: model(),
    },
    sessionOverride: {
      cwd: "/project/worktree",
      permissionMode: "plan",
      bypassAvailable: false,
    },
    permissionRules: {
      allow: [{ source: "session", behavior: "allow", toolName: "read_file" }],
      deny: [{ source: "project", behavior: "deny", toolName: "bash" }],
      ask: [],
    },
    interaction: { canPrompt: false },
    permissionMode: "default",
    additionalWorkingDirectories: ["/shared"],
    env: { PILOTDECK_MAX_OUTPUT_TOKENS: "512" },
  }).compose();

  assert.equal(config.provider, "main-provider");
  assert.equal(config.model, "main-model");
  assert.equal(config.cwd, "/project/worktree");
  assert.equal(config.permissionMode, "plan");
  assert.equal(config.permissionContext.canPrompt, false);
  assert.equal(config.permissionContext.bypassAvailable, false);
  assert.deepEqual(config.permissionContext.additionalWorkingDirectories, ["/shared"]);
  assert.deepEqual(config.permissionContext.rules.deny, [{
    source: "project", behavior: "deny", toolName: "bash",
  }]);
  assert.equal(config.maxContextTokens, 4_096);
  assert.equal(config.maxOutputTokens, 512);
  assert.deepEqual(config.subagentModel, {
    provider: "sub-provider",
    model: "sub-model",
    modelMultimodal: { input: ["text", "image"] },
    maxContextTokens: 16_384,
    maxOutputTokens: 512,
  });
  assert.equal(config.subagentTimeoutMs, 45_000);
  assert.equal(config.maxSubagentDepth, 3);
  assert.equal(config.runtimeContextSurface, "user_message");
});

test("session agent config bundle accepts the internal max-message parity override only at composition", () => {
  const config = new SessionAgentConfigBundle({
    runtime: { projectRoot: "/project", snapshot: snapshot(), profile: { runtimeContextSurface: "system_prompt" }, model: model() },
    permissionRules: { allow: [], deny: [], ask: [] },
    interaction: { canPrompt: false },
    permissionMode: "default",
    env: {},
    testAgentConfigOverrides: { maxContextMessages: 1 },
  }).compose();
  assert.equal(config.maxContextMessages, 1);
});

function snapshot(): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(0),
    contentHash: "test",
    sources: [],
    diagnostics: [],
    config: {
      agent: {
        model: { id: "main-provider/main-model", provider: "main-provider", model: "main-model" },
        maxContextTokens: 4_096,
        maxOutputTokens: 1_024,
        runtimeContextSurface: "system_prompt",
        subagents: {
          default: { id: "sub-provider/sub-model", provider: "sub-provider", model: "sub-model" },
          timeoutMs: 45_000,
          maxDepth: 3,
        },
      },
      model: { providers: {} },
      extension: { builtinPluginsEnabled: {}, includeHookEvents: false },
    },
  };
}

function model(): ModelRuntime {
  return {
    stream: async function* () {},
    async complete() { return { role: "assistant", content: [], finishReason: "stop" }; },
    getCapabilities(provider, modelName) {
      if (provider === "main-provider" && modelName === "main-model") {
        return capabilities(8_192, 2_048, ["text"]);
      }
      return capabilities(16_384, 4_096, ["text", "image"]);
    },
    getMultimodal(provider, modelName) {
      return provider === "main-provider" && modelName === "main-model"
        ? { input: ["text"] }
        : { input: ["text", "image"] };
    },
    getProviderProtocol() { return "openai" as const; },
    getProviderBaseUrl() { return undefined; },
  };
}

function capabilities(
  maxContextTokens: number,
  maxOutputTokens: number,
  input: Array<"text" | "image">,
) {
  return {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens,
    maxOutputTokens,
    multimodal: { input },
  };
}
