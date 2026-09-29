import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import {
  isAgentTurnCapabilities,
  type AgentLoopRuntimeFactoryInput,
} from "../../src/agent/index.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

test("headless interaction profile composes deterministic questions and fail-closed permission without Gateway pending state", async (t) => {
  const root = await createFixture(t, "  interactionProfile: headless");
  let answer: unknown;
  let permission: unknown;
  let canPrompt: boolean | undefined;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testAgentLoopFactory: ({ config, dependencies }) => createRunner(async () => {
      canPrompt = config.permissionContext.canPrompt;
      answer = await dependencies.elicitation!.askUser({
        toolCallId: "headless-turn",
        toolName: "ask_user_question",
        questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes", description: "Yes" }] }],
      });
      permission = await dependencies.permission!.decide(
        { name: "write_file", isReadOnly: () => false } as never,
        {},
        { permissionContext: config.permissionContext } as never,
        "call-permission",
      );
    }),
  });
  t.after(() => local.dispose());

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "headless-profile",
    channelKey: "test",
    projectKey: root,
    message: "continue",
    runId: "headless-turn",
  })) {
    events.push(event);
  }

  assert.equal(canPrompt, true);
  assert.deepEqual(answer, { type: "answered", answers: { "Proceed?": "yes" } }, JSON.stringify(events));
  assert.deepEqual(permission, {
    type: "deny",
    reason: { type: "runtime", message: "No interaction answerer is available." },
    message: "No interaction answerer is available.",
  });
  assert.equal(events.some((event) => event.type === "elicitation_request"), false);
  assert.equal(events.some((event) => event.type === "permission_request"), false);
});

test("legacy autoElicitation option resolves to the headless profile", async (t) => {
  const root = await createFixture(t);
  let answer: unknown;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    autoElicitation: true,
    __testAgentLoopFactory: ({ dependencies }) => createRunner(async () => {
      answer = await dependencies.elicitation!.askUser({
        toolCallId: "legacy-headless-turn",
        toolName: "ask_user_question",
        questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes", description: "Yes" }] }],
      });
    }),
  });
  t.after(() => local.dispose());

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "legacy-headless-profile",
    channelKey: "test",
    projectKey: root,
    message: "continue",
    runId: "legacy-headless-turn",
  })) {
    // Drain the turn.
  }

  assert.deepEqual(answer, { type: "answered", answers: { "Proceed?": "yes" } });
});

test("application interaction override is frozen into the project runtime profile", async (t) => {
  const root = await createFixture(t, "  interactionProfile: headless");
  let canPrompt: boolean | undefined;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    interactionProfile: "disabled",
    autoElicitation: true,
    __testAgentLoopFactory: ({ config }) => createRunner(async () => {
      canPrompt = config.permissionContext.canPrompt;
    }),
  });
  t.after(() => local.dispose());

  assert.equal(
    local.registry.resolve(root).profile.interaction.name,
    "disabled",
    "the application override must win before the runtime generation is published",
  );

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "explicit-profile",
    channelKey: "test",
    projectKey: root,
    message: "continue",
    runId: "explicit-profile-turn",
  })) {
    // Drain the turn.
  }

  assert.equal(canPrompt, false, "session composition must consume the published runtime profile");
});

test("session agent config consumes the project generation runtime-context surface", async (t) => {
  const root = await createFixture(t, "  runtimeContextSurface: system_prompt");
  let runtimeContextSurface: string | undefined;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testAgentLoopFactory: ({ config }) => createRunner(async () => {
      runtimeContextSurface = config.runtimeContextSurface;
    }),
  });
  t.after(() => local.dispose());

  assert.equal(local.registry.resolve(root).profile.runtimeContextSurface, "system_prompt");

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "context-surface-profile",
    channelKey: "test",
    projectKey: root,
    message: "continue",
    runId: "context-surface-profile-turn",
  })) {
    // Drain the turn.
  }

  assert.equal(runtimeContextSurface, "system_prompt");
});

test("local gateway exposes only capability-scoped input to an external AgentLoop factory", async (t) => {
  const root = await createFixture(t);
  const factoryInputs: AgentLoopRuntimeFactoryInput[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    agentLoopFactory: (input) => {
      factoryInputs.push(input);
      assert.equal(isAgentTurnCapabilities(input.capabilities), true);
      assert.equal("dependencies" in (input as object), false);
      return createRunner(async () => {});
    },
  });
  t.after(() => local.dispose());

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "external-loop-factory",
    channelKey: "test",
    projectKey: root,
    message: "complete without tools",
    runId: "external-loop-turn",
  })) {
    events.push(event);
  }

  assert.equal(factoryInputs.length, 1);
  assert.equal(factoryInputs[0]?.config.cwd, root);
  assert.equal(events.some((event) => event.type === "turn_completed"), true);
});

test("local gateway preserves its run identity through an external AgentLoop runner", async (t) => {
  const root = await createFixture(t);
  let execution: AgentLoopInput["execution"];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    agentLoopFactory: () => createRunner(async (input) => {
      execution = input.execution;
    }),
  });
  t.after(() => local.dispose());

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "external-loop-identity",
    channelKey: "test",
    projectKey: root,
    message: "keep the host run identity",
    runId: "gateway-run-identity",
  })) {
    // Drain the complete turn.
  }

  assert.deepEqual(execution, {
    runId: "gateway-run-identity",
    operationId: "gateway-run-identity",
  });
});

async function createFixture(
  t: { after(callback: () => void | Promise<void>): void },
  interactionLine = "",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-interaction-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    interactionLine,
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test:",
    "          capabilities:",
    "            supportsToolUse: true",
    "            maxContextTokens: 8192",
    "            maxOutputTokens: 1024",
    "",
  ].filter(Boolean).join("\n"), "utf8");
  return root;
}

function createRunner(onRun: (input: AgentLoopInput) => Promise<void>) {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await onRun(input);
      const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
      const result: AgentLoopRunResult = {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          finalMessage,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        messages: [...input.messages, finalMessage],
      };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: result.result };
      return result;
    },
  };
}
