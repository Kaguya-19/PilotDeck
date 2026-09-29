import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLocalGateway } from "../../../dist/src/cli/createLocalGateway.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const publishedPath = process.env.G5_PUBLISHED_SOP_JSON ?? join(repoRoot, "products/pilotdeck-staffdeck-sop/evidence/g5-page-published-1.2.0.json");
const outputPath = process.env.G5_OUTPUT_PATH ?? "/tmp/g5-real-run.json";
const endpoint = process.env.STAFFDECK_SOP_ENDPOINT ?? "http://127.0.0.1:16213";
const expectedSopId = process.env.G5_SOP_ID ?? "project_delivery_plan";
const expectedVersion = process.env.G5_SOP_VERSION ?? "1.2.0";

const publishedResponse = JSON.parse(await readFile(resolve(publishedPath), "utf8"));
const published = publishedResponse?.result?.sop ?? publishedResponse?.sop ?? publishedResponse;
if (published?.skill_id !== expectedSopId || published?.version !== expectedVersion || !published?.content) {
  throw new Error(`Published SOP binding mismatch: expected ${expectedSopId}@${expectedVersion}.`);
}

const root = await mkdtemp(join(tmpdir(), "g5-real-run-"));
const projectRoot = join(root, "project");
await mkdir(projectRoot, { recursive: true });
const model = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"title":"G5 project delivery"}' }, finish_reason: "stop" }] }));
    return;
  }
  const messages = JSON.stringify(body.messages ?? []);
  const count = Number(model.requestCount = (model.requestCount ?? 0) + 1);
  let proposal;
  if (count === 1) proposal = { status: "completed", replyFragment: "项目状态已收集。", slotUpdates: { project_goal: "交付 G5 SOP", current_stage: "验证", known_blockers: "无" }, nextStepId: "build_plan" };
  else if (count === 2) proposal = { status: "completed", replyFragment: "推进计划已生成，待确认范围。", nextStepId: "confirm_scope" };
  else if (count === 3) proposal = { status: "handoff", replyFragment: "等待负责人确认范围。" };
  else if (count === 4 && messages.includes("G5 scope approved")) proposal = { status: "completed", replyFragment: "范围确认已收到。", nextStepId: "finalize_plan", slotUpdates: { scope_confirmed: true } };
  else proposal = { status: "completed", replyFragment: "项目推进计划已完成。" };
  model.proposals ??= [];
  model.proposals.push({ count, proposal });
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `g5-${count}`, type: "function", function: { name: "submit_step_result", arguments: JSON.stringify(proposal) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
});

await new Promise((resolveListen, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolveListen); });
const modelPort = model.address().port;
await writeFile(join(projectRoot, "pilotdeck.yaml"), `schemaVersion: 1\nagent:\n  model: test/test\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: http://127.0.0.1:${modelPort}\n      apiKey: test-only\n      models:\n        test: {}\nmodules:\n  agentLoop: { enabled: true, provider: pilotdeck }\n  modelProvider: { enabled: true, provider: pilotdeck }\n  tools: { enabled: true, provider: pilotdeck }\n  sop:\n    enabled: true\n    provider: staffdeck\n    endpoint: ${endpoint}\n    definitionsPath: ${resolve(publishedPath)}\n    defaultSopId: ${published.skill_id}\n`, "utf8");

let local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
const sessionKey = "g5:project:1";
const collect = async (events) => { const result = []; for await (const event of events) result.push(event); return result; };
try {
  const initialEvents = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "g5", workspaceCwd: projectRoot, message: "开始项目推进计划：目标是交付 G5 SOP，当前阶段验证，阻塞无。", mode: "bypassPermissions" }));
  const planEvents = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "g5", workspaceCwd: projectRoot, message: "继续生成推进计划，范围需要负责人确认。", mode: "bypassPermissions" }));
  const handoffEvents = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "g5", workspaceCwd: projectRoot, message: "请发起负责人范围确认。", mode: "bypassPermissions" }));
  const waiting = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  if (!waiting?.wait) throw new Error("initial turn did not enter a resumable wait");
  await local.dispose();
  local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  const reloaded = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  const resumed = await local.gateway.resumeSop({ sessionKey, projectKey: projectRoot, requestId: "g5-resume-1", waitId: waiting.wait.id, source: "human", message: "G5 scope approved", expectedRevision: waiting.revision, slotUpdates: { scope_confirmed: true } });
  const duplicate = await local.gateway.resumeSop({ sessionKey, projectKey: projectRoot, requestId: "g5-resume-1", waitId: waiting.wait.id, source: "human", message: "G5 scope approved" });
  const resumeEvents = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "g5", workspaceCwd: projectRoot, message: resumed.message, mode: "bypassPermissions" }));
  const completionEvents = await collect(local.gateway.submitTurn({ sessionKey, channelKey: "g5", workspaceCwd: projectRoot, message: "输出最终行动清单并完成项目推进计划。", mode: "bypassPermissions" }));
  const completed = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
  await writeFile(outputPath, JSON.stringify({
    published: { sopId: published.skill_id, version: published.version, nodes: published.content.nodes.length, edges: published.content.edges.length },
    modelRequests: model.requestCount,
    initial: { eventTypes: { initial: initialEvents.map((event) => event.type), plan: planEvents.map((event) => event.type), handoff: handoffEvents.map((event) => event.type) }, status: waiting.state.status, waitKind: waiting.wait.kind, revision: waiting.revision },
    reload: { status: reloaded.state.status, waitId: reloaded.wait?.id, sameWaitId: reloaded.wait?.id === waiting.wait.id },
    resume: { duplicate: resumed.duplicate, duplicateReplay: duplicate.duplicate, eventTypes: resumeEvents.map((event) => event.type) },
    completion: { eventTypes: completionEvents.map((event) => event.type), status: completed.state.status, activeStep: completed.state.active_step_id, slots: completed.state.slots_json },
  }, null, 2), "utf8");
} finally {
  await local.dispose();
  await new Promise((resolveClose) => model.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
