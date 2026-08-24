import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

function router(): SessionRouter {
  return {
    sessionCount: () => 0,
    list: async () => ({ sessions: [] }),
    beginTurn: () => false,
    endTurn: () => undefined,
    getOrCreate: async () => ({}) as never,
    abort: async () => undefined,
    close: async () => undefined,
  } as unknown as SessionRouter;
}

const input = { marker: "test" } as never;

test("InProcessGateway reports unavailable optional capabilities explicitly", async () => {
  const gateway = new InProcessGateway(router());
  assert.deepEqual(await gateway.recordAgentStatusMessage(input), { recorded: false });
  assert.deepEqual(await gateway.describeServer(), { mode: "in_process", sessionCount: 0, capabilities: [] });
  await assert.rejects(gateway.projectFilesList(input), /unavailable/);
  await assert.rejects(gateway.commandsList(input), /unavailable/);
  await assert.rejects(gateway.modelCatalogList(input), /unavailable/);
  await assert.rejects(gateway.sessionModelGet(input), /unavailable/);
  await assert.rejects(gateway.sessionModelSet(input), /unavailable/);
  await assert.rejects(gateway.sessionModelClear(input), /unavailable/);
  await assert.rejects(gateway.readSessionMessages(input), /read_session_messages is not configured/);
  await assert.rejects(gateway.readSubagentMessages(input), /read_subagent_messages is not configured/);
  await assert.rejects(gateway.forkSession(input), /fork_session is not configured/);
  await assert.rejects(gateway.listProjects(), /list_projects is not configured/);
  await assert.rejects(gateway.describeProject(input), /describe_project is not configured/);
  await assert.rejects(gateway.cronCreate(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.cronList(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.cronUpdate(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.cronDelete(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.cronStop(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.cronRunNow(input), /Cron runtime is not configured/);
  await assert.rejects(gateway.skillsList(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillRead(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillWrite(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillCreate(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillDelete(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillImport(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillValidate(input), /Skill manager is not configured/);
  await assert.rejects(gateway.skillScan(input), /Skill manager is not configured/);
  assert.deepEqual(await gateway.reloadConfig(), { reloaded: false, reason: "unsupported" });
  assert.deepEqual(await gateway.reloadExtensions(), { reloaded: false, reason: "unsupported" });
  const weixin = await gateway.prepareWeixinLogin();
  assert.equal(weixin.requested, false);
  assert.equal(weixin.reason, "unsupported");
  assert.deepEqual(await gateway.alwaysOnApply(input), { sessionKey: "", error: { code: "not_configured", message: "Always-On apply is not configured on this gateway." } });
  assert.deepEqual(await gateway.alwaysOnRerunPlan(input), { runId: "", error: { code: "not_configured", message: "Always-On rerun is not configured on this gateway." } });
  assert.deepEqual(await gateway.getActiveTurnSnapshot({ sessionKey: "missing" }), { active: false, sessionKey: "missing", events: [] });
});

test("InProcessGateway delegates configured APIs and exposes capability metadata", async () => {
  const calls: string[] = [];
  const cron = {
    createTask: async () => { calls.push("cronCreate"); return { taskId: "1" }; },
    listTasks: async () => { calls.push("cronList"); return { tasks: [] }; },
    updateTask: async () => { calls.push("cronUpdate"); return { taskId: "1" }; },
    deleteTask: async () => { calls.push("cronDelete"); return { deleted: true }; },
    stopTask: async () => { calls.push("cronStop"); return { stopped: true }; },
    runTaskNow: async () => { calls.push("cronRunNow"); return { accepted: true }; },
  };
  const skillManager = {
    list: async () => { calls.push("skillList"); return { skills: [] }; },
    read: async () => { calls.push("skillRead"); return { content: "" }; },
    write: async () => { calls.push("skillWrite"); return { written: true }; },
    create: async () => { calls.push("skillCreate"); return { created: true }; },
    delete: async () => { calls.push("skillDelete"); return { deleted: true }; },
    import: async () => { calls.push("skillImport"); return { imported: true }; },
    validate: async () => { calls.push("skillValidate"); return { valid: true }; },
    scan: async () => { calls.push("skillScan"); return { findings: [] }; },
  } as never;
  const gateway = new InProcessGateway(router(), {
    serverInfo: { serverVersion: "test" },
    cron,
    skillManager,
    listProjects: async () => { calls.push("listProjects"); return { projects: [{ projectKey: "/known" }] }; },
    describeProject: async () => { calls.push("describeProject"); return { projectKey: "/known" }; },
    commandsList: async () => { calls.push("commandsList"); return { commands: [] }; },
    modelCatalogList: async () => { calls.push("modelCatalogList"); return { models: [] }; },
    sessionModelGet: async () => { calls.push("sessionModelGet"); return { projectKey: "/known" }; },
    sessionModelSet: async () => { calls.push("sessionModelSet"); return { projectKey: "/known" }; },
    sessionModelClear: async () => { calls.push("sessionModelClear"); },
    readSessionMessages: async () => { calls.push("readSessionMessages"); return { sessionKey: "s", messages: [] }; },
    readSubagentMessages: async () => { calls.push("readSubagentMessages"); return { sessionKey: "s", subagentId: "a", messages: [] }; },
    forkSession: async () => { calls.push("forkSession"); return { sessionKey: "forked" }; },
    reloadConfig: async () => { calls.push("reloadConfig"); return { reloaded: true, changedPaths: [] }; },
    reloadExtensions: async () => { calls.push("reloadExtensions"); return { reloaded: true, changed: true }; },
    prepareWeixinLogin: async () => { calls.push("prepareWeixinLogin"); return { requested: true, requestedAt: "now" }; },
    alwaysOnApply: async () => { calls.push("alwaysOnApply"); return { sessionKey: "s" }; },
    alwaysOnRerunPlan: async () => { calls.push("alwaysOnRerunPlan"); return { runId: "r" }; },
    recordAgentStatusMessage: async () => { calls.push("recordStatus"); return { recorded: true }; },
  });
  const described = await gateway.describeServer();
  assert.deepEqual(described.capabilities, ["project_files_list", "commands_list", "model_catalog_list", "session_model_get", "session_model_set", "session_model_clear"]);
  assert.equal((await gateway.recordAgentStatusMessage(input)).recorded, true);
  await gateway.commandsList(input);
  await gateway.modelCatalogList(input);
  await gateway.sessionModelGet(input);
  await gateway.sessionModelSet(input);
  await gateway.sessionModelClear(input);
  await gateway.readSessionMessages(input);
  await gateway.readSubagentMessages(input);
  await gateway.forkSession(input);
  await gateway.listProjects();
  await gateway.describeProject(input);
  await gateway.reloadConfig();
  await gateway.reloadExtensions(input);
  await gateway.prepareWeixinLogin();
  await gateway.alwaysOnApply(input);
  await gateway.alwaysOnRerunPlan(input);
  await gateway.cronCreate(input);
  await gateway.cronList(input);
  await gateway.cronUpdate(input);
  await gateway.cronDelete(input);
  await gateway.cronStop(input);
  await gateway.cronRunNow(input);
  await gateway.skillsList(input);
  await gateway.skillRead(input);
  await gateway.skillWrite(input);
  await gateway.skillCreate(input);
  await gateway.skillDelete(input);
  await gateway.skillImport(input);
  await gateway.skillValidate(input);
  await gateway.skillScan(input);
  assert.equal(calls.includes("skillScan"), true);
  await assert.rejects(gateway.projectFilesList({ projectKey: "/unknown" } as never), /Unknown projectKey/);
  gateway.setCronController(undefined);
  gateway.setAlwaysOnApply(undefined);
  gateway.setAlwaysOnRerunPlan(undefined);
  gateway.setPrepareWeixinLogin(undefined);
});

test("InProcessGateway handles session permission grants and active event identity", async () => {
  const gateway = new InProcessGateway(router(), { uuid: () => "run" });
  assert.deepEqual(await gateway.grantSessionPermission({ sessionKey: "s", entry: "" }), { granted: false });
  assert.deepEqual(await gateway.grantSessionPermission({ sessionKey: "s", entry: "bash" }), { granted: true, entry: "bash" });
  assert.deepEqual(await gateway.grantSessionPermission({ sessionKey: "s", entry: "bash" }), { granted: true, entry: "bash" });
  const replays = (gateway as unknown as { activeTurnReplays: Map<string, { sessionKey: string; runId: string; events: unknown[]; bytes: number; truncated: boolean }> }).activeTurnReplays;
  replays.set("s", { sessionKey: "s", runId: "run-1", events: [], bytes: 0, truncated: false });
  assert.equal(gateway.emitForSession("missing", { type: "assistant_text_delta", text: "x" }), false);
  const emitted: unknown[] = [];
  (gateway as unknown as { emitSinks: Map<string, (event: unknown) => void> }).emitSinks.set("s", (event) => emitted.push(event));
  assert.equal(gateway.emitForSession("s", { type: "assistant_text_delta", text: "x" }), true);
  assert.deepEqual(emitted, [{ type: "assistant_text_delta", text: "x", runId: "run-1" }]);
  gateway.broadcastRetryProgress({ sessionId: "s", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "retry", provider: "p", model: "m" });
  assert.equal(emitted.length, 2);
});

test("InProcessGateway delegates project files, status and session lifecycle APIs", async () => {
  const calls: string[] = [];
  const root = process.cwd();
  const gateway = new InProcessGateway(router(), {
    uuid: () => "new-id",
    listProjects: async () => ({ projects: [{ projectKey: root }] }),
    recordAgentStatusMessage: async () => { calls.push("status"); return { recorded: true }; },
    readSessionMessages: async (received) => { calls.push(`messages:${received.sessionKey}`); return { sessionKey: received.sessionKey, messages: [] }; },
    readSubagentMessages: async (received) => { calls.push(`subagent:${received.subagentId}`); return { sessionKey: received.sessionKey, subagentId: received.subagentId, messages: [] }; },
    forkSession: async () => { calls.push("fork"); return { sessionKey: "forked" }; },
  });

  const files = await gateway.projectFilesList({ projectKey: root, limit: 1 });
  assert.equal(files.projectKey, root);
  assert.equal(files.items.length <= 1, true);
  assert.deepEqual(await gateway.recordAgentStatusMessage(input), { recorded: true });
  assert.deepEqual(await gateway.readSessionMessages({ sessionKey: "s" } as never), { sessionKey: "s", messages: [] });
  assert.deepEqual(await gateway.readSubagentMessages({ sessionKey: "s", subagentId: "a" } as never), { sessionKey: "s", subagentId: "a", messages: [] });
  assert.deepEqual(await gateway.forkSession(input), { sessionKey: "forked" });
  assert.deepEqual(await gateway.resumeSession({ sessionKey: "s" }), { sessionKey: "s" });
  assert.deepEqual(await gateway.newSession({ channelKey: "web" } as never), { sessionKey: "web:s_new-id" });
  await gateway.closeSession({ sessionKey: "s", reason: "test" });
  assert.deepEqual(calls, ["status", "messages:s", "subagent:a", "fork"]);
});
