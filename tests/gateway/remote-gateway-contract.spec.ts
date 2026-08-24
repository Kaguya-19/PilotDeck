import assert from "node:assert/strict";
import test from "node:test";

import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";

test("remote-gateway-contract: every Gateway method maps to its wire method", async () => {
  const calls: Array<{ kind: "request" | "stream"; method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ kind: "request", method, params });
      if (method === "reload_config") return { reloaded: false, reason: "unchanged" };
      return { method, params };
    },
    stream: (method: string, params: unknown) => {
      calls.push({ kind: "stream", method, params });
      return (async function* () { yield { type: "assistant_text_delta", text: "ok" }; })();
    },
    onNotification: () => undefined,
  } as unknown as GatewayWsClient;
  const gateway = new RemoteGateway(client);
  const input = { marker: "input" };
  const operations: Array<[string, () => Promise<unknown>]> = [
    ["abort_turn", () => gateway.abortTurn(input as never)], ["list_sessions", () => gateway.listSessions(input as never)],
    ["resume_session", () => gateway.resumeSession(input as never)], ["new_session", () => gateway.newSession(input as never)],
    ["close_session", () => gateway.closeSession(input as never)], ["record_agent_status_message", () => gateway.recordAgentStatusMessage(input as never)],
    ["describe_server", () => gateway.describeServer()], ["active_turn_snapshot", () => gateway.getActiveTurnSnapshot(input as never)],
    ["cron_create", () => gateway.cronCreate(input as never)], ["cron_list", () => gateway.cronList(input as never)], ["cron_update", () => gateway.cronUpdate(input as never)],
    ["cron_delete", () => gateway.cronDelete(input as never)], ["cron_stop", () => gateway.cronStop(input as never)], ["cron_run_now", () => gateway.cronRunNow(input as never)],
    ["elicitation_respond", () => gateway.respondElicitation(input as never)], ["permission_decide", () => gateway.permissionDecide(input as never)],
    ["grant_session_permission", () => gateway.grantSessionPermission(input as never)], ["read_session_messages", () => gateway.readSessionMessages(input as never)],
    ["read_subagent_messages", () => gateway.readSubagentMessages(input as never)], ["fork_session", () => gateway.forkSession(input as never)],
    ["list_projects", () => gateway.listProjects()], ["describe_project", () => gateway.describeProject(input as never)],
    ["reload_config", () => gateway.reloadConfig()], ["prepare_weixin_login", () => gateway.prepareWeixinLogin()], ["reload_extensions", () => gateway.reloadExtensions(input as never)],
    ["skill_list", () => gateway.skillsList(input as never)], ["skill_read", () => gateway.skillRead(input as never)], ["skill_write", () => gateway.skillWrite(input as never)],
    ["skill_create", () => gateway.skillCreate(input as never)], ["skill_delete", () => gateway.skillDelete(input as never)], ["skill_import", () => gateway.skillImport(input as never)],
    ["skill_validate", () => gateway.skillValidate(input as never)], ["skill_scan", () => gateway.skillScan(input as never)],
    ["always_on_apply", () => gateway.alwaysOnApply(input as never)], ["always_on_rerun_plan", () => gateway.alwaysOnRerunPlan(input as never)],
  ];
  for (const [method, invoke] of operations) {
    const result = await invoke();
    if (method === "abort_turn" || method === "close_session") {
      assert.equal(result, undefined);
    } else if (method === "reload_config") {
      assert.deepEqual(result, { reloaded: false, reason: "unchanged" });
    } else {
      assert.deepEqual(result, { method, params: method === "describe_server" || method === "list_projects" || method === "reload_config" || method === "prepare_weixin_login" ? {} : input });
    }
  }
  const stream = gateway.submitTurn(input as never);
  assert.deepEqual((await stream[Symbol.asyncIterator]().next()).value, { type: "assistant_text_delta", text: "ok" });
  assert.equal(calls.length, 36);
  assert.deepEqual(calls.at(-1), { kind: "stream", method: "submit_turn", params: input });
});

test("remote-gateway-contract: notification subscription delegates to the WebSocket client", () => {
  let received: unknown;
  const handler = (name: string, payload: unknown) => { received = { name, payload }; };
  const client = { onNotification: (candidate: typeof handler) => candidate("config_changed", { paths: ["agent.model"] }) } as unknown as GatewayWsClient;
  new RemoteGateway(client).onNotification(handler);
  assert.deepEqual(received, { name: "config_changed", payload: { paths: ["agent.model"] } });
});
