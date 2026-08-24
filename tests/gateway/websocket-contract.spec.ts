import assert from "node:assert/strict";
import test from "node:test";

import type { Gateway } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";

class FakeSocket {
  readonly sent: unknown[] = [];
  private messageHandler?: (message: string) => void;
  private closeHandler?: () => void;
  closeCode?: number;

  onMessage(handler: (message: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  sendText(message: string): void { this.sent.push(JSON.parse(message)); }
  close(code?: number): void { this.closeCode = code; }
  dispatch(frame: unknown): void { this.messageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame)); }
  disconnect(): void { this.closeHandler?.(); }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function authenticate(socket: FakeSocket): void {
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "token",
  });
}

function gatewayFor(calls: Array<{ name: string; input: unknown }>): Gateway {
  const names: Record<string, string> = {
    abort_turn: "abortTurn", list_sessions: "listSessions", resume_session: "resumeSession",
    new_session: "newSession", close_session: "closeSession", record_agent_status_message: "recordAgentStatusMessage",
    describe_server: "describeServer", active_turn_snapshot: "getActiveTurnSnapshot", cron_create: "cronCreate",
    cron_list: "cronList", cron_update: "cronUpdate", cron_delete: "cronDelete", cron_stop: "cronStop",
    cron_run_now: "cronRunNow", elicitation_respond: "respondElicitation", permission_decide: "permissionDecide",
    grant_session_permission: "grantSessionPermission", read_session_messages: "readSessionMessages",
    read_subagent_messages: "readSubagentMessages", fork_session: "forkSession", list_projects: "listProjects",
    describe_project: "describeProject", reload_config: "reloadConfig", prepare_weixin_login: "prepareWeixinLogin",
    reload_extensions: "reloadExtensions", skill_list: "skillsList", skill_read: "skillRead", skill_write: "skillWrite",
    skill_create: "skillCreate", skill_delete: "skillDelete", skill_import: "skillImport", skill_validate: "skillValidate",
    skill_scan: "skillScan", always_on_apply: "alwaysOnApply", always_on_rerun_plan: "alwaysOnRerunPlan",
  };
  const target: Record<string, unknown> = {
    describeServer: async () => ({ mode: "test" }),
    submitTurn: async function* () {},
  };
  for (const [wire, name] of Object.entries(names)) {
    target[name] = async (input: unknown = {}) => {
      calls.push({ name: wire, input });
      return { method: wire, input };
    };
  }
  return target as unknown as Gateway;
}

test("websocket-contract: hello validates protocol and token", async () => {
  const gateway = gatewayFor([]);
  const badToken = new FakeSocket();
  new GatewayWsConnection(badToken as unknown as TextWebSocketConnection, { gateway, token: "token", serverVersion: "test" });
  badToken.dispatch({ type: "hello", protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, clientName: "test", clientVersion: "test", token: "wrong" });
  await flush();
  assert.equal(badToken.closeCode, 4003);

  const badVersion = new FakeSocket();
  new GatewayWsConnection(badVersion as unknown as TextWebSocketConnection, { gateway, token: "token", serverVersion: "test" });
  badVersion.dispatch({ type: "hello", protocolVersion: "0", clientName: "test", clientVersion: "test", token: "token" });
  await flush();
  assert.equal(badVersion.closeCode, 4001);

  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, { gateway, token: "token", serverVersion: "test" });
  authenticate(socket);
  await flush();
  assert.deepEqual(socket.sent[0], {
    type: "hello_ok", protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, serverVersion: "test", serverInfo: { method: "describe_server", input: {} },
  });
  socket.dispatch("not json");
  assert.equal(socket.closeCode, 4002);
});

test("websocket-contract: malformed authenticated frames and unknown methods return protocol errors", async () => {
  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    gateway: gatewayFor([]),
    token: "token",
    serverVersion: "test",
  });
  socket.dispatch({ type: "hello", protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, clientName: "test", clientVersion: "test", token: "token" });
  await flush();

  socket.dispatch({ type: "request", id: "unknown", method: "not_a_gateway_method", params: {} });
  await flush();
  assert.deepEqual(socket.sent.at(-1), {
    type: "response",
    id: "unknown",
    ok: false,
    error: {
      code: "gateway_request_failed",
      message: "Unknown gateway method not_a_gateway_method.",
    },
  });

  socket.dispatch({ type: "event", name: "not-a-request" });
  await flush();
  assert.equal(socket.closeCode, 4002);
});

test("websocket-contract: unavailable capabilities use a stable structured error", async () => {
  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    gateway: gatewayFor([]),
    token: "token",
    serverVersion: "test",
  });
  authenticate(socket);
  await flush();
  socket.dispatch({ type: "request", id: "capability", method: "project_files_list", params: {} });
  await flush();

  assert.deepEqual(socket.sent.at(-1), {
    type: "response",
    id: "capability",
    ok: false,
    error: {
      code: "CAPABILITY_UNAVAILABLE",
      message: "Gateway capability project_files_list is unavailable.",
    },
  });
});

test("websocket-contract: RPC dispatch matrix", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, { gateway: gatewayFor(calls), token: "token", serverVersion: "test" });
  authenticate(socket);
  await flush();
  const methods = [
    "abort_turn", "list_sessions", "resume_session", "new_session", "close_session", "record_agent_status_message",
    "describe_server", "active_turn_snapshot", "cron_create", "cron_list", "cron_update", "cron_delete", "cron_stop",
    "cron_run_now", "elicitation_respond", "permission_decide", "grant_session_permission", "read_session_messages",
    "read_subagent_messages", "fork_session", "list_projects", "describe_project", "reload_config", "prepare_weixin_login",
    "reload_extensions", "skill_list", "skill_read", "skill_write", "skill_create", "skill_delete", "skill_import",
    "skill_validate", "skill_scan", "always_on_apply", "always_on_rerun_plan",
  ];
  for (const [index, method] of methods.entries()) {
    const params = { marker: method };
    socket.dispatch({ type: "request", id: String(index), method, params });
    await flush();
    const response = socket.sent.at(-1) as { type: string; id: string; ok: boolean; result: unknown };
    assert.equal(response.type, "response");
    assert.equal(response.id, String(index));
    assert.equal(response.ok, true);
    if (method === "abort_turn" || method === "close_session") {
      assert.deepEqual(response.result, { ok: true });
    } else {
      assert.deepEqual(response.result, { method, input: method === "describe_server" || method === "list_projects" || method === "reload_config" || method === "prepare_weixin_login" ? {} : params });
    }
  }
  assert.equal(calls.length, methods.length + 1, "hello also calls describe_server");
});

test("websocket-contract: submit_turn streams sequence and disconnect aborts active turns", async () => {
  const gateway = {
    describeServer: async () => ({ mode: "test" }),
    abortTurn: async () => undefined,
    async *submitTurn() {
      yield { type: "assistant_text_delta", text: "one" };
      yield { type: "tool_call_started", toolCallId: "call", name: "bash" };
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
  } as unknown as Gateway;
  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, { gateway, token: "token", serverVersion: "test" });
  authenticate(socket);
  await flush();
  socket.dispatch({ type: "request", id: "stream", method: "submit_turn", params: { sessionKey: "s", channelKey: "test", message: "go" } });
  await flush();
  await flush();
  const events = socket.sent.filter((value): value is { type: "event"; seq: number; final: boolean; event: { type: string } } =>
    typeof value === "object" && value !== null && (value as { type?: string }).type === "event",
  );
  assert.deepEqual(events.map((event) => [event.seq, event.final, event.event.type]), [
    [0, false, "assistant_text_delta"], [1, false, "tool_call_started"], [2, false, "turn_completed"], [3, true, "turn_completed"],
  ]);

  let aborted: unknown;
  let pause!: () => void;
  const activeSocket = new FakeSocket();
  new GatewayWsConnection(activeSocket as unknown as TextWebSocketConnection, {
    token: "token", serverVersion: "test", gateway: {
      describeServer: async () => ({ mode: "test" }),
      abortTurn: async (input: unknown) => { aborted = input; },
      async *submitTurn() {
        yield { type: "assistant_text_delta", text: "waiting" };
        await new Promise<void>((resolve) => { pause = resolve; });
      },
    } as unknown as Gateway,
  });
  authenticate(activeSocket);
  await flush();
  activeSocket.dispatch({ type: "request", id: "active", method: "submit_turn", params: { sessionKey: "s", channelKey: "test", message: "go" } });
  await flush();
  activeSocket.disconnect();
  await flush();
  assert.deepEqual(aborted, { sessionKey: "s" });
  pause();
});

test("websocket-contract: optional handlers return documented unsupported fallbacks", async () => {
  const socket = new FakeSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "token", serverVersion: "test", gateway: { describeServer: async () => ({ mode: "test" }) } as unknown as Gateway,
  });
  authenticate(socket);
  await flush();
  socket.dispatch({ type: "request", id: "reload", method: "reload_config", params: {} });
  await flush();
  assert.deepEqual(socket.sent.at(-1), { type: "response", id: "reload", ok: true, result: { reloaded: false, reason: "unsupported" } });
  socket.dispatch({ type: "request", id: "skill", method: "skill_list", params: {} });
  await flush();
  assert.deepEqual(socket.sent.at(-1), {
    type: "response", id: "skill", ok: false, error: { code: "not_configured", message: "Skill management is not enabled on this gateway." },
  });
});
