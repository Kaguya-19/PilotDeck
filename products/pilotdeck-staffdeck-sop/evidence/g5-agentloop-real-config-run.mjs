import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import { createLocalGateway } from "../../../dist/src/cli/createLocalGateway.js";

const publishedPath = resolve(process.env.G5_PUBLISHED_SOP_JSON ?? "products/pilotdeck-staffdeck-sop/evidence/g5-pilotdeck-page-published-1.2.1.json");
const sourcePilotHome = process.env.REAL_MODEL_SOURCE_PILOT_HOME ?? process.env.PILOT_HOME;
const endpoint = process.env.STAFFDECK_SOP_ENDPOINT ?? "http://127.0.0.1:16205";
const selectedModel = process.env.REAL_MODEL_SMOKE_MODEL;
const outputPath = process.env.G5_REAL_CONFIG_OUTPUT ?? "/tmp/g5-agentloop-real-config-1.2.1.json";
if (!sourcePilotHome) throw new Error("REAL_MODEL_SOURCE_PILOT_HOME or PILOT_HOME is required.");

const sourceConfig = YAML.parse(await readFile(join(sourcePilotHome, "pilotdeck.yaml"), "utf8"));
const selected = selectedModel ?? sourceConfig?.agent?.model;
const [providerId] = typeof selected === "string" ? selected.split("/") : [];
const provider = providerId ? sourceConfig?.model?.providers?.[providerId] : undefined;
if (!selected || !providerId || !provider) throw new Error("The source config must select a configured model provider.");

const publishedResponse = JSON.parse(await readFile(publishedPath, "utf8"));
const published = publishedResponse?.result?.sop ?? publishedResponse?.sop ?? publishedResponse;
if (!published?.skill_id || !published?.version || !published?.content) throw new Error("Published SOP response is incomplete.");

const root = await mkdtemp(join(tmpdir(), "pilotdeck-real-published-sop-"));
const projectRoot = join(root, "project");
const sessionKey = "real-published-sop";
const collect = async (events) => {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
};
const summary = (events) => events.map((event) => {
  if (event.type === "tool_call_started") return { type: event.type, toolName: event.name };
  if (event.type === "tool_call_finished") return { type: event.type, toolName: event.toolName, ok: event.ok };
  return { type: event.type };
});

await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, "approval-context.txt"), "Published SOP real-model tool context.\n", "utf8");
await writeFile(join(projectRoot, "pilotdeck.yaml"), YAML.stringify({
  schemaVersion: 1,
  agent: { model: selected, maxContextTokens: 65536, maxOutputTokens: 8192 },
  model: { providers: { [providerId]: provider } },
  modules: {
    agentLoop: { enabled: true, provider: "pilotdeck" },
    modelProvider: { enabled: true, provider: "pilotdeck" },
    tools: { enabled: true, provider: "pilotdeck" },
    sop: {
      enabled: true,
      provider: "staffdeck",
      endpoint,
      definitionsPath: publishedPath,
      defaultSopId: published.skill_id,
      timeoutMs: 30000,
    },
  },
}), "utf8");

let local;
try {
  local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  const first = await collect(local.gateway.submitTurn({
    sessionKey,
    channelKey: "real",
    workspaceCwd: projectRoot,
    message: "按项目推进计划流程工作。请先调用 read_file 读取 approval-context.txt，然后提交 submit_step_result，status=handoff，说明等待负责人确认范围；同时填入 project_goal=交付真实SOP、current_stage=验证、known_blockers=无。不要跳过审批。",
    mode: "bypassPermissions",
  }));
  assert.equal(first.some((event) => event.type === "error"), false, JSON.stringify(summary(first)));
  assert.ok(first.some((event) => event.type === "tool_call_finished" && event.ok && event.toolName === "read_file"), JSON.stringify(summary(first)));
  let waiting = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  assert.equal(waiting?.state.status, "handoff", JSON.stringify(waiting));
  assert.equal(waiting?.state.selected_skill_id, published.skill_id);
  assert.equal(waiting?.wait?.kind, "handoff");

  const waitId = waiting.wait.id;
  await local.dispose();
  local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  const reloaded = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  assert.equal(reloaded?.wait?.id, waitId);
  const resumed = await local.gateway.resumeSop({
    sessionKey,
    projectKey: projectRoot,
    requestId: "real-published-resume-1",
    waitId,
    source: "human",
    message: "负责人已确认范围。继续当前节点，使用 submit_step_result 完成并按允许的下一节点推进。",
    expectedRevision: waiting.revision,
    slotUpdates: { scope_confirmed: true },
  });
  const duplicate = await local.gateway.resumeSop({ sessionKey, projectKey: projectRoot, requestId: "real-published-resume-1", waitId, source: "human", message: "重复继续" });
  assert.equal(resumed.duplicate, false);
  assert.equal(duplicate.duplicate, true);

  const continuationEvents = [];
  for (const message of [
    resumed.message,
    "继续执行当前项目推进计划节点，调用 submit_step_result 完成当前节点，并严格选择图谱允许的下一节点。",
    "输出最终行动清单，调用 submit_step_result 完成终态。",
  ]) {
    const events = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "real", workspaceCwd: projectRoot, message, mode: "bypassPermissions" }));
    assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(summary(events)));
    continuationEvents.push(...events);
    waiting = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
    if (waiting?.state.status === "completed") break;
  }
  assert.equal(waiting?.state.status, "completed", JSON.stringify(waiting));
  const statePath = join(projectRoot, "sop", "sessions", `${Buffer.from(sessionKey, "utf8").toString("base64url")}.json`);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(outputPath, JSON.stringify({
    status: "passed",
    provider: providerId,
    model: selected.slice(providerId.length + 1),
    configuredDefinitionsPath: publishedPath,
    published: { sopId: published.skill_id, version: published.version, nodes: published.content.nodes.length, edges: published.content.edges.length },
    firstTurn: summary(first),
    wait: { kind: "handoff", waitId, reloadedSameWaitId: reloaded?.wait?.id === waitId },
    resume: { accepted: resumed.accepted, duplicateReplay: duplicate.duplicate },
    continuation: summary(continuationEvents),
    terminal: { status: persisted.state.status, activeStep: persisted.state.active_step_id, slots: persisted.state.slots_json },
  }, null, 2), "utf8");
  console.log(JSON.stringify({ status: "passed", provider: providerId, model: selected.slice(providerId.length + 1), sop: `${published.skill_id}@${published.version}`, waitId, terminal: persisted.state.status }));
} finally {
  await local?.dispose();
  await rm(root, { recursive: true, force: true });
}
