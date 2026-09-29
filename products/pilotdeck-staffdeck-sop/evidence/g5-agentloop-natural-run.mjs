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
const outputPath = process.env.G5_NATURAL_OUTPUT ?? "/tmp/g5-agentloop-natural-1.2.1.json";
if (!sourcePilotHome) throw new Error("REAL_MODEL_SOURCE_PILOT_HOME or PILOT_HOME is required.");

const sourceConfig = YAML.parse(await readFile(join(sourcePilotHome, "pilotdeck.yaml"), "utf8"));
const selected = selectedModel ?? sourceConfig?.agent?.model;
const [providerId] = typeof selected === "string" ? selected.split("/") : [];
const provider = providerId ? sourceConfig?.model?.providers?.[providerId] : undefined;
if (!selected || !providerId || !provider) throw new Error("The source config must select a configured model provider.");

const publishedResponse = JSON.parse(await readFile(publishedPath, "utf8"));
const published = publishedResponse?.result?.sop ?? publishedResponse?.sop ?? publishedResponse;
if (!published?.skill_id || !published?.version || !published?.content) throw new Error("Published SOP response is incomplete.");

const root = await mkdtemp(join(tmpdir(), "pilotdeck-natural-sop-"));
const projectRoot = join(root, "project");
const sessionKey = "natural-published-sop";
const messages = [
  "请处理这项项目推进工作。目标是交付真实SOP运行验证，当前阶段是验证，已知阻塞为无。项目材料在 approval-context.txt，请先阅读材料。范围、资源和日期已经发生变化，在负责人审批影响前不能继续推进，也不要先输出最终行动清单。",
  "继续完成这份项目推进计划，把范围变化的影响、负责人、里程碑和风险依赖整理清楚，并按流程推进。",
  "请基于当前收集的信息生成推进计划，标出范围变化的影响。生成计划前，必须先把范围、资源和日期变化的影响交给负责人确认，确认前不要输出最终行动清单。",
  "请把确认请求正式发给负责人，说明影响和需要确认的内容；不要假设负责人已经确认。",
  "请等待负责人回复，不要自行把计划标为已确认或输出最终行动清单。",
];
assert.equal(messages.some((message) => /submit_step_result|status\s*=|status:/iu.test(message)), false);

const collect = async (events) => {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
};
const summary = (events) => events.flatMap((event) => {
  if (event.type === "tool_call_started") return [{ type: event.type, toolName: event.name }];
  if (event.type === "tool_call_finished") return [{ type: event.type, toolName: event.toolName, ok: event.ok }];
  if (event.type === "error") return [{ type: event.type, code: event.code, message: event.message }];
  return [];
});
const snapshot = (status) => status && ({
  revision: status.revision,
  state: status.state,
  wait: status.wait,
});

await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, "approval-context.txt"), "The release scope changed: confirm owner impact before finalizing.\n", "utf8");
await writeFile(join(projectRoot, "pilotdeck.yaml"), YAML.stringify({
  schemaVersion: 1,
  agent: { model: selected, maxContextTokens: 65536, maxOutputTokens: 8192 },
  model: { providers: { [providerId]: provider } },
  modules: {
    agentLoop: { enabled: true, provider: "pilotdeck" },
    modelProvider: { enabled: true, provider: "pilotdeck" },
    tools: { enabled: true, provider: "pilotdeck" },
    sop: { enabled: true, provider: "staffdeck", endpoint, definitionsPath: publishedPath, defaultSopId: published.skill_id, timeoutMs: 30000 },
  },
}), "utf8");

let local;
try {
  local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot });
  const turns = [];
  let current;
  for (const message of messages) {
    const events = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "natural", workspaceCwd: projectRoot, message, mode: "default", canPrompt: false, allowedTools: ["read_file", "submit_step_result"] }));
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 0, JSON.stringify(summary(events)));
    current = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
    turns.push({ message, tools: summary(events), status: snapshot(current) });
    if (current?.state.status === "handoff" || current?.state.status === "completed") break;
  }

  const wait = current?.wait;
  let resume;
  let duplicate;
  let afterResume;
  if (wait) {
    const before = current;
    await local.dispose();
    local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot });
    const reloaded = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
    resume = await local.gateway.resumeSop({
      sessionKey,
      projectKey: projectRoot,
      requestId: "natural-resume-1",
      waitId: wait.id,
      source: "human",
      message: "负责人已确认范围变化的影响，可以继续完成项目计划。",
      expectedRevision: before.revision,
      slotUpdates: { scope_confirmed: true },
    });
    duplicate = await local.gateway.resumeSop({ sessionKey, projectKey: projectRoot, requestId: "natural-resume-1", waitId: wait.id, source: "human", message: "重复确认" });
    const postResume = [];
    for (const message of [
      resume.message,
      "请继续完成当前项目计划并按流程输出下一步。",
      "请输出最终行动清单，包含里程碑、负责人、风险和依赖。",
    ]) {
      const events = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "natural", workspaceCwd: projectRoot, message, mode: "default", canPrompt: false, allowedTools: ["read_file", "submit_step_result"] }));
      assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(summary(events)));
      postResume.push(...events);
      const status = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
      if (status?.state.status === "completed") break;
    }
    afterResume = { reloadedWaitId: reloaded?.wait?.id, tools: summary(postResume), status: snapshot(await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot })) };
  }

  const finalStatus = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  const result = {
    status: finalStatus?.state.status === "completed" ? "passed" : "partial",
    permissionMode: "default",
    provider: providerId,
    model: selected.slice(providerId.length + 1),
    configuredDefinitionsPath: "products/pilotdeck-staffdeck-sop/evidence/g5-pilotdeck-page-published-1.2.1.json",
    published: { sopId: published.skill_id, version: published.version, nodes: published.content.nodes.length, edges: published.content.edges.length },
    trigger: "ordinary project-delivery request; no SOP tool or status named in user input",
    turns,
    resume: wait ? { waitId: wait.id, accepted: resume.accepted, duplicateReplay: duplicate.duplicate, ...afterResume } : null,
    terminal: snapshot(finalStatus),
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ status: result.status, permissionMode: "default", sop: `${published.skill_id}@${published.version}`, wait: wait?.id ?? null, terminal: finalStatus?.state.status ?? null }));
} finally {
  await local?.dispose();
  await rm(root, { recursive: true, force: true });
}
