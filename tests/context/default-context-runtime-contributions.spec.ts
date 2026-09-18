import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DefaultContextRuntime,
  InstructionDiscovery,
  PromptAssembler,
  PromptContributionRegistry,
  type ContextPrepareInput,
  type MemoryResolver,
} from "../../src/context/index.js";
import type { CanonicalToolSchema } from "../../src/model/index.js";

const now = () => new Date("2026-09-06T00:00:00.000Z");

test("DefaultContextRuntime preserves the native prompt when no contribution registry is configured", async () => {
  const request = input();
  const result = await new DefaultContextRuntime({ now }).prepareForModel(request);
  const expected = new PromptAssembler({
    listMcpInstructions: () => [],
    listCommands: () => [],
    listSkills: () => [],
  }).assemble({
    cwd: request.cwd,
    provider: request.provider,
    model: request.model,
    permissionMode: request.permissionMode,
    runMode: request.runMode,
    additionalWorkingDirectories: request.additionalWorkingDirectories,
    tools: request.tools,
    now,
  });

  assert.equal(result.systemPrompt, expected.joined);
  assert.deepEqual(result.systemPromptParts, expected.parts);
  assert.deepEqual(result.tools, request.tools);
});

test("DefaultContextRuntime materializes contributions, memory, instructions, and effective tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-context-"));
  const pilotHome = join(root, ".pilotdeck-home");
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(root, "PILOTDECK.md"), "Follow the project rules.\n", "utf8");
  try {
    const contributions = new PromptContributionRegistry();
    contributions.registerSection({
      name: "deployment",
      order: 100,
      text: "deployment={{model}} cwd={{cwd}}",
    });
    contributions.registerRuntimeContext({
      name: "mode",
      order: 10,
      text: "mode={{permission_mode}}",
    });
    const memoryResolver: MemoryResolver = {
      async retrieve() {
        return { systemContext: "remembered fact", diagnostics: [] };
      },
      async captureTurn() {},
    };
    const runtime = new DefaultContextRuntime({
      now,
      promptContributions: contributions,
      memoryResolver,
      projectRoot: root,
      instructionDiscovery: new InstructionDiscovery(root, root, pilotHome),
    });

    const result = await runtime.prepareForModel(input({ cwd: root }));

    assert.match(result.systemPrompt ?? "", /deployment=model-a cwd=/);
    assert.match(result.systemPrompt ?? "", /mode=default/);
    assert.match(result.systemPrompt ?? "", /<memory-context>\nremembered fact\n<\/memory-context>/);
    assert.match(result.systemPrompt ?? "", /Follow the project rules\./);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["alpha", "zeta"]);
    assert.deepEqual(result.materialization?.runtimeContexts.map((context) => context.name), [
      "pilotdeck:user-context:0",
      "mode",
      "pilotdeck:memory:0:0",
    ]);
    assert.deepEqual(result.materialization?.instructionLayers, [{
      scope: "project",
      path: join(root, "PILOTDECK.md"),
      content: "Follow the project rules.",
    }]);
    assert.equal(result.materialization?.promptGeneration, contributions.generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-message runtime context is durable-shaped and precedes the latest user request", async () => {
  const contributions = new PromptContributionRegistry();
  contributions.registerRuntimeContext({
    name: "mode",
    order: 10,
    text: "mode={{permission_mode}}",
  });
  const runtime = new DefaultContextRuntime({
    now,
    promptContributions: contributions,
    memoryResolver: {
      async retrieve() {
        return { systemContext: "remembered fact", diagnostics: [] };
      },
      async captureTurn() {},
    },
  });

  const result = await runtime.prepareForModel(input({ runtimeContextSurface: "user_message" }));

  assert.doesNotMatch(result.systemPrompt ?? "", /<user-context>|mode=default|remembered fact/);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.role, "user");
  assert.deepEqual(result.messages[0]?.metadata, { synthetic: true, purpose: "runtime_context" });
  assert.match(JSON.stringify(result.messages[0]), /mode=default/);
  assert.match(JSON.stringify(result.messages[0]), /remembered fact/);
  assert.equal(result.messages[1]?.content[0]?.type, "text");
  assert.equal(result.messages[1]?.content[0]?.text, "hello");
  assert.deepEqual(result.materialization?.runtimeContextMessages, [result.messages[0]]);
});

test("user-message runtime context replaces a prior request-only projection", async () => {
  const runtime = new DefaultContextRuntime({ now });
  const first = await runtime.prepareForModel(input({ runtimeContextSurface: "user_message" }));
  const second = await runtime.prepareForModel(input({
    runtimeContextSurface: "user_message",
    messages: [
      ...first.messages,
      { role: "assistant", content: [{ type: "text", text: "first response" }] },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ],
  }));

  assert.equal(
    second.messages.filter((message) => message.metadata?.purpose === "runtime_context").length,
    1,
  );
  const latestBlock = second.messages.at(-1)?.content[0];
  assert.equal(latestBlock?.type, "text");
  if (latestBlock?.type === "text") assert.equal(latestBlock.text, "follow up");
});

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    runMode: "agent",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [tool("zeta"), tool("alpha")],
    ...overrides,
  };
}

function tool(name: string): CanonicalToolSchema {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  };
}
