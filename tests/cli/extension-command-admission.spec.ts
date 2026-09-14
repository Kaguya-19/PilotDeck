import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentLoopRunner } from "../../src/agent/turn/TurnRunner.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;

test("Gateway sessions admit the body from their frozen extension command generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-command-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), CONFIG, "utf8");
  await writePluginCommand(root, "first-generation instruction");

  const messagesBySession = new Map<string, CanonicalMessage[]>();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testAgentLoopFactory: () => recordingRunner(messagesBySession),
  });
  t.after(() => local.dispose());

  const oldHandle = await local.registry.createSession({
    sessionKey: "command-old",
    projectKey: root,
    channelKey: "test",
  });

  await writePluginCommand(root, "second-generation instruction");
  local.registry.invalidate(root);
  const newHandle = await local.registry.createSession({
    sessionKey: "command-new",
    projectKey: root,
    channelKey: "test",
  });
  t.after(() => oldHandle.dispose("test_complete"));
  t.after(() => newHandle.dispose("test_complete"));

  await drain(oldHandle.submit({ type: "text", text: "/demo:deploy api" }, { turnId: "turn-old" }));
  await drain(newHandle.submit({ type: "text", text: "/demo:deploy api" }, { turnId: "turn-new" }));

  const oldText = userText(messagesBySession.get("command-old"));
  const newText = userText(messagesBySession.get("command-new"));
  assert.match(oldText, /first-generation instruction/);
  assert.doesNotMatch(oldText, /second-generation instruction/);
  assert.match(newText, /second-generation instruction/);
  assert.match(oldText, /<command-argument>[\s\S]*api/);
});

test("direct createAgentSession retains native input admission without an extension processor", async () => {
  const messagesBySession = new Map<string, CanonicalMessage[]>();
  const session = createAgentSession({
    sessionId: "direct-command-admission",
    config: sessionConfig(process.cwd()),
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
    __agentLoopFactory: () => recordingRunner(messagesBySession),
  });

  await drain(session.submit({ type: "text", text: "/demo:deploy api" }, { turnId: "turn-direct" }));

  assert.equal(userText(messagesBySession.get("direct-command-admission")), "/demo:deploy api");
});

async function writePluginCommand(root: string, content: string): Promise<void> {
  const pluginDir = join(root, ".pilotdeck", "plugins", "demo");
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
  await writeFile(
    join(pluginDir, "commands", "deploy.md"),
    `---\ndescription: Deploy the selected service\nargument-hint: service\n---\n${content}\n`,
    "utf8",
  );
}

function recordingRunner(messagesBySession: Map<string, CanonicalMessage[]>): AgentLoopRunner {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      messagesBySession.set(input.sessionId, input.messages.map((message) => ({ ...message })));
      const result: AgentLoopRunResult["result"] = {
        type: "success",
        sessionId: input.sessionId,
        turnId: input.turnId,
        finalMessage: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.001Z",
      };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
  };
}

function sessionConfig(cwd: string) {
  return {
    provider: "test",
    model: "test",
    cwd,
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    // Drive the session through its regular turn finalization path.
  }
}

function userText(messages: CanonicalMessage[] | undefined): string {
  const message = messages?.at(-1);
  const block = message?.content[0];
  assert.equal(block?.type, "text");
  return block.text;
}
