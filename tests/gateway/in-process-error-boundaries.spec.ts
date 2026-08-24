import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function completedSession(): AgentSession {
  return {
    async *submit(_input, options = {}) {
      const turnId = options.turnId ?? "turn";
      yield { type: "turn_started", sessionId: "s", turnId };
      yield {
        type: "turn_completed",
        sessionId: "s",
        turnId,
        result: {
          type: "success",
          sessionId: "s",
          turnId,
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
    snapshot: () => ({
      sessionId: "s",
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
  } as unknown as AgentSession;
}

function routerWith(sessionFactory: () => AgentSession | Promise<AgentSession>): SessionRouter {
  return new SessionRouter({ idleSweepIntervalMs: 0, createSession: sessionFactory });
}

function eventTypes(events: unknown[]): string[] {
  return events.map((event) => (event as { type: string }).type);
}

function activeReplayStore(gateway: InProcessGateway) {
  return (gateway as unknown as {
    activeTurnReplays: Map<string, { sessionKey: string; runId: string; events: unknown[]; bytes: number; truncated: boolean }>;
    emitSinks: Map<string, (event: unknown) => void>;
  });
}

test("InProcessGateway rejects invalid permission modes before creating a session", async (t) => {
  let created = false;
  const router = routerWith(() => {
    created = true;
    return completedSession();
  });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);

  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "hello",
    mode: "invalid-mode" as never,
  }));
  assert.deepEqual(events, [{
    type: "error",
    code: "INVALID_PERMISSION_MODE",
    message: "Invalid mode: invalid-mode.",
    recoverable: true,
  }]);
  assert.equal(created, false);
});

test("InProcessGateway rejects an invalid base permission mode", async (t) => {
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);
  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "hello",
    basePermissionMode: "plan" as never,
  }));
  assert.equal((events[0] as { code: string }).code, "INVALID_PERMISSION_MODE");
  assert.match((events[0] as { message: string }).message, /basePermissionMode/);
});

test("InProcessGateway turns an empty plan command into usage without starting a turn", async (t) => {
  let created = false;
  const router = routerWith(() => {
    created = true;
    return completedSession();
  });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);

  const events = await collect(gateway.submitTurn({ sessionKey: "s", channelKey: "web", message: " /plan " }));
  assert.deepEqual(eventTypes(events), ["assistant_text_delta", "turn_completed"]);
  assert.equal((events[0] as { text: string }).text, "用法：/plan <任务>\n例如：/plan 设计一个新功能");
  assert.equal(created, false);
});

test("InProcessGateway keeps the previous config snapshot when refresh fails", async (t) => {
  let refreshCount = 0;
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    refreshConfigBeforeTurn: async () => {
      refreshCount += 1;
      throw new Error("temporary config read failure");
    },
  });

  const events = await collect(gateway.submitTurn({ sessionKey: "s", channelKey: "web", message: "hello" }));
  assert.deepEqual(eventTypes(events), ["turn_started", "turn_completed"]);
  assert.equal(refreshCount, 1);
});

test("InProcessGateway preserves workspace cwd and emits a changed model selection", async (t) => {
  let cwd: { sessionKey: string; cwd: string } | undefined;
  const session: AgentSession = {
    async *submit(_input, options = {}) {
      yield {
        type: "model_event",
        sessionId: "s",
        turnId: options.turnId ?? "run",
        event: { type: "request_started", provider: "actual", model: "actual-model" },
      };
      yield {
        type: "turn_completed",
        sessionId: "s",
        turnId: options.turnId ?? "run",
        result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" },
      };
    },
    abort: () => undefined,
    snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
  } as unknown as AgentSession;
  const router = routerWith(() => session);
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    setSessionCwd: (sessionKey, value) => { cwd = { sessionKey, cwd: value }; },
    resolveTurnModelSelection: async () => ({
      selection: { mode: "model", provider: "selected", model: "selected-model", temperature: 0.2 },
      source: "session",
    }),
  });
  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    workspaceCwd: "/project/worktree",
    message: "hello",
    runId: "run-selection",
  }));
  assert.deepEqual(cwd, { sessionKey: "s", cwd: "/project/worktree" });
  assert.deepEqual(events.filter((event) => (event as { type: string }).type === "model_selection_changed").map((event) => (event as { provider: string; model: string }).provider), ["selected", "actual"]);
});

test("InProcessGateway reports uploaded attachment resolver failures as turn errors", async (t) => {
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    resolveUploadedAttachments: async () => {
      throw new Error("attachment resolver unavailable");
    },
  });

  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    projectKey: "/project",
    message: "inspect",
    uploadedAttachments: [{ id: "upload-1", name: "note.txt", mimeType: "text/plain" }],
    runId: "run-upload",
  }));
  const failure = events.find((event) => (event as { type: string }).type === "error") as { code: string; message: string };
  assert.equal(failure.code, "gateway_submit_failed");
  assert.equal(failure.message, "attachment resolver unavailable");
  assert.equal(router.hasActiveTurn("s"), false);
});

test("InProcessGateway reports missing project for uploaded attachments", async (t) => {
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    resolveUploadedAttachments: async () => [],
  });

  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "inspect",
    uploadedAttachments: [{ id: "upload-1", name: "note.txt" }],
  }));
  const failure = events.find((event) => (event as { type: string }).type === "error") as { code: string; message: string };
  assert.equal(failure.code, "gateway_submit_failed");
  assert.match(failure.message, /projectKey is required/);
});

test("InProcessGateway fails closed for unsupported reasoning values", async (t) => {
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);

  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "hello",
    modelOverride: { mode: "model", provider: "test", model: "model", reasoning: 0.3 },
    runId: "run-model",
  }));
  const failure = events.find((event) => (event as { type: string }).type === "error") as { code: string; message: string };
  assert.equal(failure.code, "gateway_submit_failed");
  assert.match(failure.message, /Unsupported reasoning value: 0\.3/);
  assert.equal(router.hasActiveTurn("s"), false);
});

test("InProcessGateway times out a turn, rejects pending interaction and closes the session", async (t) => {
  let release!: () => void;
  let abortCalls = 0;
  let closeCalls = 0;
  const session: AgentSession = {
    async *submit(_input, options = {}) {
      const turnId = options.turnId ?? "run";
      yield { type: "turn_started", sessionId: "s", turnId };
      await new Promise<void>((resolve) => { release = resolve; });
      yield {
        type: "turn_completed",
        sessionId: "s",
        turnId,
        result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" },
      };
    },
    abort: () => { abortCalls += 1; release?.(); },
    snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "busy", abortController: new AbortController() }),
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => session,
    onSessionEvict: () => { closeCalls += 1; },
  });
  t.after(() => {
    release?.();
    router.shutdown();
  });
  const gateway = new InProcessGateway(router);
  const events = await collect(gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "long",
    runId: "run-timeout",
    timeoutMs: 5,
  }));
  assert.equal(events.some((event) => (event as { code?: string }).code === "turn_timeout"), true);
  assert.equal(abortCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(router.hasActiveTurn("s"), false);
});

test("InProcessGateway lists files only for a registered project and delegates Always-On calls", async (t) => {
  const root = process.cwd();
  const calls: string[] = [];
  const router = routerWith(() => completedSession());
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    listProjects: async () => ({ projects: [{ projectKey: root }] }),
    alwaysOnApply: async () => { calls.push("apply"); return { sessionKey: "always-on:s" }; },
    alwaysOnRerunPlan: async () => { calls.push("rerun"); return { runId: "run" }; },
  });
  const files = await gateway.projectFilesList({ projectKey: root, limit: 1 });
  assert.equal(files.projectKey, root);
  assert.equal(files.items.length <= 1, true);
  assert.deepEqual(await gateway.alwaysOnApply({} as never), { sessionKey: "always-on:s" });
  assert.deepEqual(await gateway.alwaysOnRerunPlan({} as never), { runId: "run" });
  assert.deepEqual(calls, ["apply", "rerun"]);
});

test("InProcessGateway bounds active replay buffers and marks truncation", async (t) => {
  const gateway = new InProcessGateway(routerWith(() => completedSession()), { uuid: () => "run" });
  t.after(() => undefined);
  const stores = activeReplayStore(gateway);
  stores.activeTurnReplays.set("s", { sessionKey: "s", runId: "run", events: [], bytes: 0, truncated: false });
  stores.emitSinks.set("s", () => undefined);
  for (let index = 0; index < 501; index += 1) {
    gateway.emitForSession("s", { type: "assistant_text_delta", text: String(index) });
  }
  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: "s" });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.events.length <= 500, true);
});
