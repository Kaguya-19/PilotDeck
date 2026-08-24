import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { SessionRouter, type GatewaySessionContext } from "../../src/gateway/SessionRouter.js";

function fakeSession(sessionId: string, messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]): AgentSession {
  return {
    abort: () => undefined,
    snapshot: () => ({
      sessionId,
      messages,
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
  } as unknown as AgentSession;
}

function context(sessionKey: string, projectKey?: string, channelKey = "web"): GatewaySessionContext {
  return { sessionKey, projectKey, channelKey };
}

test("SessionRouter caches sessions, merges context, and recreates dirty runtimes", async () => {
  const created: GatewaySessionContext[] = [];
  const recreated: Array<{ context: GatewaySessionContext; previous: AgentSession }> = [];
  const evictions: string[] = [];
  const first = fakeSession("first");
  const second = fakeSession("second");
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async (received) => { created.push(received); return first; },
    recreateSession: async (received, previous) => { recreated.push({ context: received, previous }); return second; },
    onSessionEvict: (sessionKey) => evictions.push(sessionKey),
  });

  assert.equal(await router.getOrCreate(context("s", "project-a", "web")), first);
  assert.equal(await router.getOrCreate(context("s", undefined, "cli")), first);
  assert.deepEqual(created, [context("s", "project-a", "web")]);
  assert.equal(router.markProjectDirty("other"), 0);
  assert.equal(router.markProjectDirty("project-a", "config changed"), 1);
  assert.equal(await router.getOrCreate(context("s", undefined, "cli")), second);
  assert.deepEqual(recreated, [{ context: context("s", "project-a", "cli"), previous: first }]);
  assert.deepEqual(evictions, ["s"]);
  router.shutdown();
});

test("SessionRouter lists snapshots and delegates custom listing", async () => {
  let now = 100;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    now: () => new Date(now),
    createSession: async ({ sessionKey }) => fakeSession(sessionKey, [
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]),
  });
  await router.getOrCreate(context("with-summary"));
  await router.getOrCreate(context("without-text"));
  const listed = await router.list();
  assert.deepEqual(listed.sessions.map((session) => [session.sessionKey, session.summary, session.lastModified]), [
    ["with-summary", "answer", 100],
    ["without-text", "answer", 100],
  ]);
  assert.deepEqual(router.snapshotSession("with-summary")?.sessionId, "with-summary");
  assert.equal(router.snapshotSession("missing"), undefined);
  router.shutdown();

  let received: unknown;
  const delegated = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async () => fakeSession("unused"),
    listSessions: async (input) => { received = input; return { sessions: [], nextCursor: "next" }; },
  });
  assert.deepEqual(await delegated.list({ limit: 2, cursor: "1" }), { sessions: [], nextCursor: "next" });
  assert.deepEqual(received, { limit: 2, cursor: "1" });
  delegated.shutdown();
  now += 1;
});

test("SessionRouter evicts idle sessions with a diagnostic snapshot and skips active turns", async () => {
  let now = 0;
  const idleSnapshots: unknown[] = [];
  const evictions: string[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    idleSessionTimeoutMs: 10,
    now: () => new Date(now),
    createSession: async ({ sessionKey }) => fakeSession(sessionKey),
    onSessionEvict: (sessionKey) => evictions.push(sessionKey),
    onSessionIdleEvict: (_sessionKey, snapshot) => idleSnapshots.push(snapshot),
  });
  await router.getOrCreate(context("idle", "project-a", "web"));
  await router.getOrCreate(context("active", "project-a", "web"));
  assert.equal(router.beginTurn("active", "run-1"), true);
  now = 11;
  assert.equal(router.sessionCount(), 1);
  assert.deepEqual(evictions, ["idle"]);
  assert.deepEqual(idleSnapshots, [{
    sessionKey: "idle",
    lastUsedAt: 0,
    context: context("idle", "project-a", "web"),
    messageCount: 1,
  }]);
  assert.equal(router.hasActiveTurn("active"), true);
  router.endTurn("active", "wrong-run");
  assert.equal(router.hasActiveTurn("active"), true);
  router.endTurn("active", "run-1");
  assert.equal(router.hasActiveTurn("active"), false);
  router.shutdown();
  router.shutdown();
});

test("SessionRouter filters always-on and cron turns from project busy checks", async () => {
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async ({ sessionKey }) => fakeSession(sessionKey),
  });
  await router.getOrCreate(context("always-on/project-a/run", "project-a", "always-on"));
  await router.getOrCreate(context("cron:task", "project-a", "cron"));
  await router.getOrCreate(context("user", "project-a", "web"));
  await router.getOrCreate(context("other", "project-b", "web"));
  assert.equal(router.beginTurn("always-on/project-a/run", "always"), true);
  assert.equal(router.beginTurn("cron:task", "cron"), true);
  assert.equal(router.beginTurn("user", "user-run"), true);
  assert.equal(router.beginTurn("other", "other-run"), true);
  assert.equal(router.hasActiveUserTurn("project-a"), true);
  router.endTurn("user", "user-run");
  assert.equal(router.hasActiveUserTurn("project-a"), false);
  assert.equal(router.hasActiveUserTurn("project-b"), true);
  router.shutdown();
});

test("SessionRouter handles close, abort, dirty-all and shutdown cleanup", async () => {
  let abortReason: string | undefined;
  const evicted: string[] = [];
  const session = fakeSession("s");
  session.abort = (reason?: string) => { abortReason = reason; };
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async () => session,
    onSessionEvict: (sessionKey) => evicted.push(sessionKey),
  });
  await router.getOrCreate(context("s"));
  assert.equal(await router.abort("s", "stop"), undefined);
  assert.equal(abortReason, "stop");
  assert.equal(router.markAllDirty("reload"), 1);
  await router.close("s");
  await router.close("s");
  assert.deepEqual(evicted, ["s"]);
  assert.equal(router.cachedSessionCount(), 0);
  router.shutdown();
});
