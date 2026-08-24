import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayElicitationChannel } from "../../src/gateway/elicitation/GatewayElicitationChannel.js";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import { createGatewayPermissionHook } from "../../src/gateway/permission/createGatewayPermissionHook.js";
import { parseReloadConfigResult } from "../../src/gateway/protocol/reloadConfigResult.js";
import { connectRemoteGatewayIfAvailable, probeGatewayServer } from "../../src/gateway/client/probeServer.js";

const elicitationRequest = {
  toolCallId: "call-1",
  toolName: "ask_user_question",
  previewFormat: "markdown" as const,
  questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "first" }] }],
  metadata: { source: "test" },
};

test("GatewayElicitationChannel emits a request and resolves an answered response through the session bus", async () => {
  const bus = new GatewayElicitationBus();
  const events: unknown[] = [];
  const hooks: unknown[] = [];
  const agentEvents: unknown[] = [];
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-1",
    bus,
    uuid: () => "request-1",
    emit: (event) => events.push(event),
    dispatchHook: (event, payload) => hooks.push({ event, payload }),
    emitAgentEvent: (type, payload) => agentEvents.push({ type, payload }),
  });
  const answerPromise = channel.askUser(elicitationRequest);
  assert.equal(bus.hasPending("session-1", "request-1"), true);
  assert.equal((events[0] as { type: string }).type, "elicitation_request");
  assert.deepEqual(hooks[0], { event: "Elicitation", payload: { requestId: "request-1", toolName: "ask_user_question", toolCallId: "call-1" } });
  assert.deepEqual(agentEvents[0], { type: "elicitation_requested", payload: { requestId: "request-1", toolName: "ask_user_question" } });
  const pending = bus.consume("session-1", "request-1");
  pending?.resolve({ type: "answered", answers: { Which: "A" } });
  assert.deepEqual(await answerPromise, { type: "answered", answers: { Which: "A" } });
  assert.equal(bus.pendingCount("session-1"), 0);
});

test("GatewayElicitationChannel converts both pre-abort and late abort to cancellation events", async () => {
  const bus = new GatewayElicitationBus();
  const events: Array<{ type: string; requestId?: string; reason?: string }> = [];
  const pre = new AbortController();
  pre.abort("already stopped");
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-1", bus, uuid: () => "pre", emit: (event) => events.push(event as typeof events[number]),
  });
  assert.deepEqual(await channel.askUser({ ...elicitationRequest, signal: pre.signal }), { type: "cancelled", reason: "aborted" });
  const late = new AbortController();
  const pendingAnswer = channel.askUser({ ...elicitationRequest, signal: late.signal });
  late.abort("stop");
  assert.deepEqual(await pendingAnswer, { type: "cancelled", reason: "aborted" });
  assert.deepEqual(events.map((event) => event.type), ["elicitation_request", "elicitation_cancelled", "elicitation_request", "elicitation_cancelled"]);
  assert.equal(bus.pendingCount("session-1"), 0);
});

test("Gateway permission hook denies undeliverable prompts and resolves remembered session rules", async () => {
  const noSink = createGatewayPermissionHook({
    sessionKey: "session-1", bus: new GatewayPermissionBus(), emit: () => false, permissionRules: [], uuid: () => "no-sink",
  });
  const baseInput = {
    sessionId: "session-1", transcriptPath: "", cwd: "/workspace", hookEventName: "PermissionRequest" as const,
    toolName: "bash", toolCallId: "call-1", toolInput: { command: "ls" },
  };
  const denied = await noSink({ hookInput: baseInput });
  assert.equal(typeof denied, "object");
  assert.equal((denied as { specific?: { decision?: { behavior?: string } } }).specific?.decision?.behavior, "deny");

  const bus = new GatewayPermissionBus();
  const rules: Array<{ source: "session"; behavior: "allow"; toolName: string; pattern?: string }> = [];
  const hook = createGatewayPermissionHook({
    sessionKey: "session-1", bus, emit: () => true, permissionRules: rules, uuid: () => "request-1",
  });
  const promise = hook({
    hookInput: {
      ...baseInput,
      permissionSuggestions: [{ id: "allow_session", label: "Always allow", rules: [{ toolName: "bash", pattern: "*.sh" }] }],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = bus.consume("session-1", "request-1");
  pending?.resolve({ requestId: "request-1", decision: "allow", remember: true });
  const allowed = await promise;
  assert.equal((allowed as { specific?: { decision?: { behavior?: string } } }).specific?.decision?.behavior, "allow");
  assert.deepEqual(rules, [{ source: "session", behavior: "allow", toolName: "bash", pattern: "*.sh" }]);

  const duplicate = hook({ hookInput: { ...baseInput, permissionSuggestions: [{ id: "allow_session", label: "Always", rules: [{ toolName: "bash", pattern: "*.sh" }] }] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  bus.consume("session-1", "request-1")?.resolve({ requestId: "request-1", decision: "allow", remember: true });
  await duplicate;
  assert.equal(rules.length, 1);
});

test("Gateway permission hook handles deny reasons, fallback payloads and abort", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({ sessionKey: "session-2", bus, emit: () => true, permissionRules: [], uuid: () => "deny" });
  const promise = hook({ hookInput: { sessionId: "s", transcriptPath: "", cwd: "/tmp", hookEventName: "PermissionRequest", toolUseId: "call-2", input: { path: "x" } } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  bus.consume("session-2", "deny")?.resolve({ requestId: "deny", decision: "deny", reason: "unsafe" });
  const denied = await promise;
  assert.equal((denied as { specific?: { decision?: { behavior?: string; message?: string } } }).specific?.decision?.behavior, "deny");
  assert.equal((denied as { specific?: { decision?: { message?: string } } }).specific?.decision?.message, "unsafe");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    hook({ hookInput: { sessionId: "s", transcriptPath: "", cwd: "/tmp", hookEventName: "PermissionRequest", toolName: "bash" }, signal: controller.signal }),
    /aborted before permission decision/,
  );
});

test("Gateway buses isolate sessions, consume once, and reject all pending entries", () => {
  const bus = new GatewayPermissionBus();
  let rejected = 0;
  const entry = (requestId: string) => ({ requestId, toolCallId: requestId, toolName: "bash", resolve: () => {}, reject: () => { rejected += 1; } });
  bus.register("a", entry("a-1"));
  bus.register("b", entry("b-1"));
  assert.equal(bus.pendingCount("a"), 1);
  assert.equal(bus.consume("a", "a-1")?.requestId, "a-1");
  assert.equal(bus.consume("a", "a-1"), undefined);
  bus.rejectSession("b", "closed");
  assert.equal(rejected, 1);
  assert.equal(bus.pendingCount("b"), 0);
});

test("Gateway elicitation bus drops empty sessions and rejects every pending request", () => {
  const bus = new GatewayElicitationBus();
  assert.equal(bus.consume("missing", "request"), undefined);
  assert.equal(bus.hasPending("missing", "request"), false);
  assert.equal(bus.pendingCount("missing"), 0);
  const errors: string[] = [];
  const pending = (requestId: string) => ({
    requestId,
    toolCallId: requestId,
    toolName: "ask_user_question",
    resolve: () => {},
    reject: (error: Error) => errors.push(error.message),
  });
  bus.register("session", pending("one"));
  bus.register("session", pending("two"));
  bus.rejectSession("session", "turn closed");
  bus.rejectSession("session", "ignored");
  assert.deepEqual(errors, ["turn closed", "turn closed"]);
  assert.equal(bus.pendingCount("session"), 0);
});

test("reload config parser accepts stable results and rejects malformed shapes", () => {
  assert.deepEqual(parseReloadConfigResult({ reloaded: true, changedPaths: ["agent.model"] }), { reloaded: true, changedPaths: ["agent.model"] });
  assert.deepEqual(parseReloadConfigResult({ reloaded: false, reason: "unchanged" }), { reloaded: false, reason: "unchanged" });
  for (const value of [null, { reloaded: "yes" }, { reloaded: true, changedPaths: [1] }, { reloaded: false, reason: "bad" }]) {
    assert.throws(() => parseReloadConfigResult(value), /Invalid reload_config response/);
  }
});

test("probeGatewayServer normalizes health failure, transport failure and explicit-token success", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("unhealthy")) return new Response("no", { status: 503 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await probeGatewayServer({ url: "http://unhealthy.invalid", token: "token" }), {
    ok: false, url: "http://unhealthy.invalid", wsUrl: "ws://unhealthy.invalid/ws",
  });
  assert.deepEqual(await probeGatewayServer({ url: "https://healthy.invalid", token: "token" }), {
    ok: true, url: "https://healthy.invalid", wsUrl: "wss://healthy.invalid/ws", token: "token",
  });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal((await probeGatewayServer({ url: "http://offline.invalid", token: "token" })).ok, false);
});

test("probeGatewayServer reads an isolated auth token and connect short-circuits without one", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.PILOT_HOME;
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-probe-"));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = originalHome;
    await rm(pilotHome, { recursive: true, force: true });
  });
  process.env.PILOT_HOME = pilotHome;
  await writeFile(join(pilotHome, "server-token"), "isolated-token\n");
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  assert.deepEqual(await probeGatewayServer(), {
    ok: true,
    url: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789/ws",
    token: "isolated-token",
  });

  await rm(join(pilotHome, "server-token"));
  const noToken = await probeGatewayServer({ url: "https://healthy.invalid" });
  assert.deepEqual(noToken, { ok: false, url: "https://healthy.invalid", wsUrl: "wss://healthy.invalid/ws", token: undefined });
  assert.equal(await connectRemoteGatewayIfAvailable({ url: "https://healthy.invalid" }), undefined);

  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("socket unavailable");
    }
  } as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  await writeFile(join(pilotHome, "server-token"), "isolated-token\n");
  assert.equal(await connectRemoteGatewayIfAvailable({ url: "https://healthy.invalid" }), undefined);
});

test("probeGatewayServer converts an aborted health request into an unavailable result", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = ((_: string | URL, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  assert.deepEqual(await probeGatewayServer({ url: "http://slow.invalid", timeoutMs: 1 }), {
    ok: false,
    url: "http://slow.invalid",
    wsUrl: "ws://slow.invalid/ws",
  });
});
