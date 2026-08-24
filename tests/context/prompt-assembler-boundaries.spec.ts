import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

function base(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/workspace/project",
    provider: "openai",
    model: "test-model",
    permissionMode: "default",
    additionalWorkingDirectories: [] as string[],
    tools: [] as Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

test("PromptAssembler renders tool-aware policies, modes, directories, commands, skills and MCP instructions", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [
      { name: "deploy", description: "Deploy app", argumentHint: "[env]" },
      { name: "status" },
    ],
    listSkills: () => [
      { name: "zeta", path: "/skills/zeta/SKILL.md" },
      { name: "alpha", description: "Alpha skill", path: "/skills/alpha/SKILL.md" },
    ],
    listMcpInstructions: () => [
      { serverName: "z&<", instructions: " z instructions " },
      { serverName: "empty", instructions: "   " },
      { serverName: "a\"server", instructions: "a instructions" },
    ],
  };
  const joined = new PromptAssembler(extension).assemble(base({
    permissionMode: "plan",
    runMode: "ask",
    additionalWorkingDirectories: ["/workspace/shared", "/tmp/tools"],
    tools: [
      { name: "web_search", inputSchema: { type: "object" } },
      { name: "web_fetch", inputSchema: { type: "object" } },
    ],
  })).joined;
  assert.match(joined, /Documentation lookup policy:/);
  assert.match(joined, /web_search for discovery/);
  assert.match(joined, /Permission mode: plan/);
  assert.match(joined, /Run mode: ask/);
  assert.match(joined, /Additional working directories/);
  assert.match(joined, /<available-commands>/);
  assert.match(joined, /- \/deploy \[env\] — Deploy app/);
  assert.match(joined, /- \/status/);
  assert.match(joined, /<available-skills>/);
  assert.match(joined, /<mcp-instructions>/);
  assert.match(joined, /<server name="a&quot;server">/);
  assert.match(joined, /<server name="z&amp;&lt;">/);
  assert.doesNotMatch(joined, /name="empty"/);
  assert.match(joined, /now: 2026-08-23/);
  assert.match(joined, /model: openai\/test-model/);
});

test("PromptAssembler supports custom replacement and always-last appended prompts", () => {
  const extension: ExtensionResolver = { listCommands: () => [], listSkills: () => [], listMcpInstructions: () => [] };
  const custom = new PromptAssembler(extension).assemble(base({
    customSystemPrompt: "  custom system  ",
    appendSystemPrompt: "  appended policy  ",
    permissionMode: "bypassPermissions",
    runMode: "plan",
  }));
  assert.equal(custom.parts[0], "custom system");
  assert.equal(custom.parts.at(-1), "appended policy");
  assert.doesNotMatch(custom.joined, /You are PilotDeck/);
  assert.match(custom.joined, /<user-context>/);
  assert.doesNotMatch(custom.joined, /<environment>/);

  const emptyCustom = new PromptAssembler(extension).assemble(base({ customSystemPrompt: "   " }));
  assert.equal(emptyCustom.parts[0], emptyCustom.sections.userContext[0]);
});

test("PromptAssembler selects the default policy for each permission and run mode", () => {
  const extension: ExtensionResolver = { listCommands: () => [], listSkills: () => [], listMcpInstructions: () => [] };
  for (const permissionMode of ["default", "plan", "bypassPermissions", "custom"] as const) {
    const prompt = new PromptAssembler(extension).assemble(base({ permissionMode })).joined;
    assert.match(prompt, new RegExp(`Permission mode: ${permissionMode}`));
  }
  assert.match(new PromptAssembler(extension).assemble(base({ runMode: "plan" })).joined, /Run mode: plan/);
  assert.doesNotMatch(new PromptAssembler(extension).assemble(base({ runMode: "other" })).joined, /Run mode:/);
});
