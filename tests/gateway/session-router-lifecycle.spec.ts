import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/session/AgentSession.js";
import { AgentHandle } from "../../src/agent/scope/AgentHandle.js";
import { AgentRegistry } from "../../src/agent/scope/AgentRegistry.js";
import {
  SUBAGENT_DEFINITIONS,
  SubagentContinuationManager,
  SubagentProviderRegistry,
} from "../../src/agent/sub/index.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("session router close aborts and waits for the active agent handle", async () => {
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const lifecycle: string[] = [];
  const handle = new AgentHandle({
    async *submit() {
      yield { type: "session_started", sessionId: "session-1" } as const;
      await turnFinished;
    },
    abort(reason?: string) {
      lifecycle.push(`abort:${reason}`);
      finishTurn();
    },
    snapshot() {
      return idleSnapshot("session-1");
    },
  } as unknown as AgentSession, {
    onDispose: () => { lifecycle.push("disposed"); },
  });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => handle,
    onSessionEvict: () => { lifecycle.push("evicted"); },
  });
  const routed = await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" });
  assert.equal(router.beginTurn("session-1", "run-1"), true);
  const iterator = routed.submit({ type: "text", text: "run" }, { turnId: "run-1" });
  await iterator.next();
  const completion = iterator.next();

  const closing = router.close("session-1");
  assert.equal(router.cachedSessionCount(), 0);
  assert.equal(handle.state, "draining");
  assert.deepEqual(lifecycle, ["abort:session_closed"]);

  assert.equal((await completion).done, true);
  await closing;
  assert.equal(router.hasActiveTurn("session-1"), false);
  assert.deepEqual(lifecycle, ["abort:session_closed", "disposed", "evicted"]);
});

test("session router shutdown drains every handle and rejects later creation", async () => {
  const disposed: string[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: ({ sessionKey }) => new AgentHandle(fakeSession(sessionKey), {
      onDispose: () => { disposed.push(sessionKey); },
    }),
  });
  await router.getOrCreate({ sessionKey: "session-a", channelKey: "test" });
  await router.getOrCreate({ sessionKey: "session-b", channelKey: "test" });

  const firstShutdown = router.shutdown();
  const secondShutdown = router.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;

  assert.deepEqual(disposed.sort(), ["session-a", "session-b"]);
  assert.equal(router.cachedSessionCount(), 0);
  assert.equal(router.beginTurn("session-a", "late"), false);
  await assert.rejects(
    router.getOrCreate({ sessionKey: "session-c", channelKey: "test" }),
    /shut down/,
  );
});

test("session router drains a session publication admitted before shutdown", async () => {
  let beginCreate!: () => void;
  let releaseCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { beginCreate = resolve; });
  const createReleased = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const handle = new AgentHandle(fakeSession("late-session"));
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async () => {
      beginCreate();
      await createReleased;
      return handle;
    },
  });

  const creating = router.getOrCreate({ sessionKey: "late-session", channelKey: "test" });
  await createStarted;
  const stopping = router.shutdown();

  releaseCreate();
  await assert.rejects(creating, /shut down during session creation/);
  await stopping;

  assert.equal(handle.state, "disposed");
  assert.equal(router.cachedSessionCount(), 0);
  assert.equal(router.agents.get("late-session"), undefined);
});

test("session router publishes into the injected exact-agent directory", async () => {
  const agents = new AgentRegistry({ name: "shared-gateway-agents" });
  const handle = new AgentHandle(fakeSession("session-1"));
  const router = new SessionRouter({
    agents,
    idleSweepIntervalMs: 0,
    createSession: () => handle,
  });

  assert.equal(await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" }), handle);
  assert.equal(agents.get("session-1"), handle);

  await router.shutdown();
  assert.equal(agents.get("session-1"), undefined);
});

test("session router appends status through the exact live session writer", async () => {
  const statusWrites: Array<{ turnId: string; event: string }> = [];
  const session = {
    ...fakeSession("session-status"),
    async recordAgentStatusMessage(turnId: string, status: { event: string }) {
      statusWrites.push({ turnId, event: status.event });
      return true;
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => new AgentHandle(session),
  });

  assert.deepEqual(
    await router.recordAgentStatusMessage("session-status", "turn-1", {
      event: "context_budget",
      kind: "status",
      text: "context_budget",
    }),
    { owner: "not_live", recorded: false },
  );

  await router.getOrCreate({ sessionKey: "session-status", channelKey: "test" });
  assert.deepEqual(
    await router.recordAgentStatusMessage("session-status", "turn-1", {
      event: "context_budget",
      kind: "status",
      text: "context_budget",
    }),
    { owner: "live", recorded: true },
  );
  assert.deepEqual(statusWrites, [{ turnId: "turn-1", event: "context_budget" }]);
  await router.shutdown();
});

test("session router compacts only an existing idle handle and never invokes its session factory", async () => {
  let creates = 0;
  let compacts = 0;
  const handle = new AgentHandle({
    sessionId: "session-compact",
    compact: async () => {
      compacts += 1;
      return { type: "skipped" as const, turnId: "manual", reason: "no_compactable_history" as const, usage: {} };
    },
    pendingTurnCount: 0,
    pendingTurns: () => [],
    snapshot: () => idleSnapshot("session-compact"),
  } as unknown as AgentSession);
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => {
      creates += 1;
      return handle;
    },
  });

  await assert.rejects(router.compact("session-compact"), /not available/);
  assert.equal(creates, 0);
  await router.getOrCreate({ sessionKey: "session-compact", channelKey: "test" });
  assert.equal(creates, 1);
  const result = await router.compact("session-compact", { turnId: "manual" });
  assert.equal(result.type, "skipped");
  assert.equal(compacts, 1);
  assert.equal(router.beginTurn("session-compact", "active"), true);
  await assert.rejects(router.compact("session-compact"), /active turn/);
  router.endTurn("session-compact", "active");
  await router.shutdown();
});

test("session router reserves a maintenance operation against concurrent Gateway turn admission", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const handle = new AgentHandle({
    sessionId: "session-maintenance",
    compact: async () => {
      started();
      await wait;
      return { type: "skipped" as const, turnId: "manual", reason: "no_compactable_history" as const, usage: {} };
    },
    pendingTurnCount: 0,
    pendingTurns: () => [],
    snapshot: () => idleSnapshot("session-maintenance"),
  } as unknown as AgentSession);
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => handle });
  await router.getOrCreate({ sessionKey: "session-maintenance", channelKey: "test" });
  const maintenance = router.compact("session-maintenance", { turnId: "manual" });
  await begun;
  assert.equal(router.beginTurn("session-maintenance", "ordinary"), false);
  await assert.rejects(router.compact("session-maintenance"), /active turn/);
  release();
  await maintenance;
  assert.equal(router.beginTurn("session-maintenance", "ordinary"), true);
  router.endTurn("session-maintenance", "ordinary");
  await router.shutdown();
});

test("dirty session recreation publishes the replacement and disposes the previous handle", async () => {
  const lifecycle: string[] = [];
  const first = new AgentHandle(fakeSession("session-1"), {
    onDispose: () => { lifecycle.push("first-disposed"); },
  });
  const second = new AgentHandle(fakeSession("session-1"), {
    onDispose: () => { lifecycle.push("second-disposed"); },
  });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => first,
    recreateSession: (_context, previous) => {
      assert.equal(previous, first.session);
      lifecycle.push("recreated");
      return second;
    },
    onSessionEvict: () => { lifecycle.push("evicted"); },
  });

  assert.equal(
    await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" }),
    first,
  );
  assert.equal(router.markAllDirty("config_changed"), 1);
  assert.equal(
    await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" }),
    second,
  );
  assert.equal(first.state, "disposed");
  assert.deepEqual(lifecycle, ["recreated", "evicted", "first-disposed"]);

  await router.shutdown();
  assert.equal(second.state, "disposed");
});

test("failed dirty recreation keeps the previous published handle", async () => {
  const first = new AgentHandle(fakeSession("session-1"));
  const candidate = new AgentHandle(fakeSession("session-1"));
  let evictions = 0;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => first,
    recreateSession: () => candidate,
    setupSession: async (_context, handle, previous) => {
      if (previous) {
        assert.equal(handle, candidate);
        throw new Error("scoped setup failed");
      }
    },
    onSessionEvict: () => { evictions += 1; },
  });

  assert.equal(
    await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" }),
    first,
  );
  router.markAllDirty("config_changed");
  await assert.rejects(
    router.getOrCreate({ sessionKey: "session-1", channelKey: "test" }),
    /scoped setup failed/,
  );

  assert.equal(router.snapshotSession("session-1")?.sessionId, "session-1");
  assert.equal(first.state, "active");
  assert.equal(candidate.state, "disposed");
  assert.equal(evictions, 0);
  await router.shutdown();
});

test("dirty recreation drains continuable children owned by the replaced exact handle", async () => {
  const agents = new AgentRegistry({ name: "recreate-continuation-agents" });
  const providers = new SubagentProviderRegistry();
  providers.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => ({}),
  });
  const childDisposals: string[] = [];
  const child = {
    sessionId: "child-1",
    state: "active",
    session: {
      sessionId: "child-1",
      recordSubagentDescriptor: async () => undefined,
    },
    followup: async (_input: unknown, options: { itemId?: string; turnId?: string; authorizeAdmission?: () => void }) => {
      options.authorizeAdmission?.();
      return { itemId: options.itemId!, turnId: options.turnId! };
    },
    dispose: async (reason?: string) => {
      childDisposals.push(reason ?? "disposed");
    },
  } as unknown as AgentHandle;
  const manager = new SubagentContinuationManager({
    agents,
    providers,
    uuid: ids("child-1", "item-1", "turn-1"),
    host: {
      create: async () => child,
      inspect: async () => { throw new Error("not used"); },
      resume: async () => { throw new Error("not used"); },
    },
  });
  let first!: AgentHandle;
  const router = new SessionRouter({
    agents,
    idleSweepIntervalMs: 0,
    createSession: () => {
      first = new AgentHandle(fakeSession("session-1"));
      first.addDisposeStartListener(() => manager.drainDescendants(first, "parent_recreated"));
      return first;
    },
    recreateSession: () => new AgentHandle(fakeSession("session-1")),
  });

  const parent = await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" });
  await manager.start({
    provider: "continuable",
    label: "recreate child",
    parent,
    definition: SUBAGENT_DEFINITIONS.explore,
    parentConfig: { provider: "test", model: "test" } as never,
    parentDependencies: {} as never,
    input: { type: "text", text: "wait" },
  });

  router.markAllDirty("test_recreate");
  const replacement = await router.getOrCreate({ sessionKey: "session-1", channelKey: "test" });
  assert.notEqual(replacement, first);
  assert.equal(first.state, "disposed");
  assert.deepEqual(childDisposals, ["parent_recreated"]);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
  await router.shutdown();
});

function fakeSession(sessionId: string): AgentSession {
  return {
    sessionId,
    async *submit() {},
    abort() {},
    snapshot() {
      return idleSnapshot(sessionId);
    },
  } as unknown as AgentSession;
}

function idleSnapshot(sessionId: string) {
  return {
    sessionId,
    messages: [],
    usage: {},
    status: "idle" as const,
    permissionDenials: [],
    abortController: new AbortController(),
  };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}
