import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalModelResponse, ModelRuntime, MultimodalConstraints } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { readAgentProjectSessionPersistence } from "../../src/session/index.js";

test("Local Gateway composes the durable goal provider into a real model tool turn", async (t) => {
  const { events, model } = await submitGoalTurn(t);

  assert.equal(model.seenGoalTool, true);
  assert.ok(events.some((event) => event.type === "tool_call_finished" && JSON.stringify(event).includes("Deliver durable goals")));
});

test("stdio sidecar executes the goal tool through the host session context", async (t) => {
  const { events, model, root, sessionKey } = await submitGoalTurn(t, { PILOTDECK_AGENT_LOOP_TRANSPORT: "stdio" });

  assert.equal(model.seenGoalTool, true);
  assert.ok(events.some((event) => event.type === "tool_call_finished" && JSON.stringify(event).includes("Deliver durable goals")));
  const persisted = await readAgentProjectSessionPersistence({ projectRoot: root, pilotHome: root, sessionId: sessionKey });
  const goals = persisted.entries.filter((entry) => entry.type === "goal_changed");
  assert.equal(goals.length, 1, "the host session is the sole durable Goal writer");
  assert.equal(goals[0]?.type === "goal_changed" && goals[0].goal?.objective, "Deliver durable goals");
});

async function submitGoalTurn(
  t: { after(callback: () => void | Promise<void>): void },
  extraEnv: Record<string, string> = {},
): Promise<{ events: Array<{ type: string }>; model: GoalCallingModel; root: string; sessionKey: string }> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-goal-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));
  const model = new GoalCallingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: { PILOT_HOME: root, ...extraEnv },
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  const events = [];
  const sessionKey = "goal-composition-session";
  for await (const event of local.gateway.submitTurn({
    sessionKey,
    channelKey: "test",
    projectKey: root,
    message: "Track this delivery objective.",
  })) events.push(event);

  return { events, model, root, sessionKey };
}

class GoalCallingModel implements ModelRuntime {
  seenGoalTool = false;
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const hasResult = request.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
    if (!hasResult) {
      this.seenGoalTool = request.tools?.some((tool) => tool.name === "create_goal") === true;
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "goal-call", name: "create_goal" };
      yield { type: "tool_call_end", toolCall: { id: "goal-call", name: "create_goal", input: { objective: "Deliver durable goals" } } };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "Goal recorded." };
    yield { type: "message_end", finishReason: "stop" };
  }
  async complete(): Promise<CanonicalModelResponse> { return { role: "assistant", content: [], finishReason: "stop" }; }
  getCapabilities() { return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true, maxContextTokens: 128_000, maxOutputTokens: 8_192 }; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}
