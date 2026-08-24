import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { createGateway } from "../../src/gateway/Gateway.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function session(): AgentSession {
  return {
    async *submit(_input, options) {
      yield {
        type: "turn_completed",
        sessionId: "session",
        turnId: options.turnId,
        result: {
          type: "success",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "",
          completedAt: "",
        },
      };
    },
    abort: () => undefined,
    snapshot: () => ({ sessionId: "session", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
  } as unknown as AgentSession;
}

test("createGateway wires custom sessions, ids, server info and project listing", async () => {
  const listedInput: unknown[] = [];
  const gateway = createGateway({
    uuid: () => "fixed",
    session: {
      create: async () => session(),
      list: async (input) => {
        listedInput.push(input);
        return { sessions: [{ sessionId: "s", sessionKey: "web:s", summary: "hello", lastModified: 1 }] };
      },
    },
    projectStorage: { projectRoot: "/tmp/project", pilotHome: "/tmp/pilot" },
    serverInfo: { serverVersion: "test" },
  });
  assert.deepEqual(await gateway.describeServer(), {
    mode: "in_process",
    projectKey: "/tmp/project",
    serverVersion: "test",
    sessionCount: 0,
    capabilities: [],
  });
  assert.deepEqual(await gateway.newSession({ channelKey: "web", projectKey: "project-a" }), {
    sessionKey: "web:project=project-a:s_fixed",
  });
  assert.deepEqual(await gateway.listSessions({ limit: 5, cursor: "2" }), {
    sessions: [{ sessionId: "s", sessionKey: "web:s", summary: "hello", lastModified: 1 }],
  });
  assert.deepEqual(listedInput, [{ limit: 5, cursor: "2" }]);
  const events = await collect(gateway.submitTurn({ sessionKey: "web:s", channelKey: "web", message: "hello", runId: "run" }));
  assert.deepEqual(events.map((event) => (event as { type: string }).type), ["turn_completed"]);
  (gateway as { shutdown?: () => void }).shutdown?.();
});

test("createGateway defaults to an empty session list without project storage", async () => {
  const gateway = createGateway({ uuid: () => "id" });
  assert.deepEqual(await gateway.listSessions(), { sessions: [] });
  assert.deepEqual(await gateway.newSession({ channelKey: "cli" }), { sessionKey: "cli:s_id" });
});

test("createGateway reports missing agent configuration as a turn failure", async () => {
  const gateway = createGateway({ uuid: () => "id" });
  const events = await collect(gateway.submitTurn({ sessionKey: "cli:s", channelKey: "cli", message: "hello", runId: "run" }));
  const failure = events.find((event) => (event as { type?: string }).type === "error") as { code?: string; message?: string } | undefined;
  assert.equal(failure?.code, "gateway_submit_failed");
  assert.match(failure?.message ?? "", /requires either session\.create or agent options/);
});

test("createGateway default project lister paginates session files and handles invalid cursors", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-home-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  });
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  const accepted = (text: string) => JSON.stringify({
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
  await writeFile(join(chatDir, "first.jsonl"), `${accepted("first prompt")}\n`);
  await writeFile(join(chatDir, "second.jsonl"), `${accepted("second prompt")}\n`);
  await writeFile(join(chatDir, "ignored.txt"), "not a session\n");

  const gateway = createGateway({ projectStorage: { projectRoot, pilotHome } });
  const firstPage = await gateway.listSessions({ limit: 1, cursor: "not-a-number" });
  assert.equal(firstPage.sessions.length, 1);
  assert.equal(firstPage.nextCursor, "1");
  assert.match(firstPage.sessions[0]!.summary, /prompt/);
  const secondPage = await gateway.listSessions({ limit: 1, cursor: "1" });
  assert.equal(secondPage.sessions.length, 1);
  assert.equal(secondPage.nextCursor, "2");
  assert.equal((await gateway.listSessions({ limit: 0 })).sessions.length, 2);
});
