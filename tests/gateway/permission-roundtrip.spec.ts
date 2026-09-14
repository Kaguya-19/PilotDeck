import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

test("local gateway permission provider completes an allow round-trip", async (t) => {
  const fixture = await createFixture(t);
  let decision: unknown;
  let rememberedDecision: unknown;
  const sessionOverrides = new SessionConfigOverrides();
  // Deliberately omit `allow`: this used to create separate temporary arrays
  // for the Gateway hook and PermissionContext.
  sessionOverrides.set("permission-roundtrip", { permissionRules: { deny: [] } });
  const local = createLocalGateway({
    projectRoot: fixture.root,
    pilotHome: fixture.root,
    permissionTimeoutMs: 1_000,
    sessionOverrides,
    __testAgentLoopFactory: ({ config, dependencies }) => createRunner(async (input) => {
      const result = await dependencies.lifecycle!.dispatch({
        event: "PermissionRequest",
        baseInput: { sessionId: input.sessionId, transcriptPath: "", cwd: fixture.root },
        payload: { toolName: "write_file", toolCallId: "call-1", toolInput: { path: "note.txt" } },
        matchQuery: "write_file",
      });
      decision = result.effects.find((effect) => effect.type === "permission_request_result");
      rememberedDecision = await dependencies.permission!.decide(
        { name: "write_file", isReadOnly: () => false } as never,
        { filePath: "note.txt" },
        { permissionContext: config.permissionContext } as never,
        "call-2",
      );
    }),
  });
  t.after(() => local.dispose());

  const iterator = local.gateway.submitTurn({
    sessionKey: "permission-roundtrip",
    channelKey: "test",
    projectKey: fixture.root,
    message: "continue",
    runId: "turn-allow",
    canPrompt: true,
  })[Symbol.asyncIterator]();
  const request = await nextEvent(iterator, "permission_request");

  assert.deepEqual(
    await local.gateway.permissionDecide({
      sessionKey: "permission-roundtrip",
      requestId: request.requestId,
      decision: "allow",
      remember: true,
    }),
    { delivered: true },
  );
  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
    // Drain the turn after the host decision is delivered.
  }

  assert.deepEqual(decision, {
    type: "permission_request_result",
    result: { behavior: "allow" },
  });
  assert.deepEqual(rememberedDecision, {
    type: "allow",
    reason: {
      type: "rule",
      behavior: "allow",
      rule: { source: "session", behavior: "allow", toolName: "write_file" },
      message: "Session allow rule permits write_file.",
    },
  });
});

test("local gateway permission composition times out and rejects a late answer", async (t) => {
  const fixture = await createFixture(t);
  let decision: unknown;
  const local = createLocalGateway({
    projectRoot: fixture.root,
    pilotHome: fixture.root,
    env: { PILOTDECK_PERMISSION_TIMEOUT_MS: "5" },
    __testAgentLoopFactory: ({ dependencies }) => createRunner(async (input) => {
      const result = await dependencies.lifecycle!.dispatch({
        event: "PermissionRequest",
        baseInput: { sessionId: input.sessionId, transcriptPath: "", cwd: fixture.root },
        payload: { toolName: "write_file", toolCallId: "call-1", toolInput: { path: "note.txt" } },
        matchQuery: "write_file",
      });
      decision = result.effects.find((effect) => effect.type === "permission_request_result");
    }),
  });
  t.after(() => local.dispose());

  const iterator = local.gateway.submitTurn({
    sessionKey: "permission-timeout",
    channelKey: "test",
    projectKey: fixture.root,
    message: "continue",
    runId: "turn-timeout",
    canPrompt: true,
  })[Symbol.asyncIterator]();
  const request = await nextEvent(iterator, "permission_request");

  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
    // The configured permission deadline must settle the turn without a host reply.
  }

  assert.deepEqual(decision, {
    type: "permission_request_result",
    result: { behavior: "deny", message: "Permission prompt timed out." },
  });
  assert.deepEqual(
    await local.gateway.permissionDecide({
      sessionKey: "permission-timeout",
      requestId: request.requestId,
      decision: "allow",
    }),
    { delivered: false },
  );
});

test("local Gateway pre-session permission grants seed the same rule provider as the Agent context", async (t) => {
  const fixture = await createFixture(t);
  let decision: unknown;
  const local = createLocalGateway({
    projectRoot: fixture.root,
    pilotHome: fixture.root,
    __testAgentLoopFactory: ({ config, dependencies }) => createRunner(async () => {
      decision = await dependencies.permission!.decide(
        { name: "write_file", isReadOnly: () => false } as never,
        { filePath: "note.txt" },
        { permissionContext: config.permissionContext } as never,
        "pre-session-grant",
      );
    }),
  });
  t.after(() => local.dispose());

  assert.deepEqual(
    await local.gateway.grantSessionPermission({
      sessionKey: "permission-pre-grant",
      entry: "Write",
    }),
    { granted: true, entry: "Write" },
  );

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "permission-pre-grant",
    channelKey: "test",
    projectKey: fixture.root,
    message: "continue",
    mode: "default",
    runId: "pre-session-grant",
  })) {
    // Drain the turn.
  }

  assert.deepEqual(decision, {
    type: "allow",
    reason: {
      type: "rule",
      behavior: "allow",
      rule: { source: "session", behavior: "allow", toolName: "write_file", pattern: undefined },
      message: "Session allow rule permits write_file.",
    },
  });
  await local.gateway.closeSession({ sessionKey: "permission-pre-grant" });
});

async function createFixture(t: { after(callback: () => void | Promise<void>): void }): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-permission-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  return { root };
}

async function nextEvent(
  iterator: AsyncIterator<import("../../src/gateway/protocol/types.js").GatewayEvent>,
  type: "permission_request",
): Promise<Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "permission_request" }>> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) assert.fail(`turn ended before ${type}`);
    if (next.value.type === type) return next.value;
  }
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

const TEST_CONFIG = `
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
