import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAlwaysOnDiscoveryPlanTool } from "../../src/always-on/tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnChatHistoryTool } from "../../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import { createAlwaysOnReportTool } from "../../src/always-on/tool/AlwaysOnReportTool.js";
import { createAlwaysOnWorkspaceTool } from "../../src/always-on/tool/AlwaysOnWorkspaceTool.js";
import { AlwaysOnRunContextRegistry, type DiscoveryRunContext, type ReportRunContext, type WorkspaceRunContext } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../../src/always-on/storage/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../../src/always-on/storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/storage/WorkCycleStore.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";

const toolContext = (sessionId: string) => ({ sessionId, turnId: "turn", cwd: "/tmp", permissionMode: "bypassPermissions", permissionContext: {} } as never);

function planMarkdown(): string {
  return [
    "# Plan",
    "",
    "> Always-On Discovery Plan",
    "> id: generated-plan",
    "> sourceRunId: run-1",
    "> createdAt: 2026-08-20T12:00:00.000Z",
    "> projectRoot: /tmp/project",
    "> dedupeKey: generated",
    "",
    "## Summary",
    "Summary",
    "",
    "## Rationale",
    "Reason",
    "",
    "## Context Signals",
    "- signal",
    "",
    "## Proposed Change",
    "Change",
    "",
    "## Execution Steps",
    "1. Test",
    "",
    "## Verification",
    "- Run tests",
  ].join("\n");
}

function reportMarkdown(): string {
  return [
    "# Report",
    "",
    "## Plan Reference",
    "generated-plan",
    "",
    "## Steps Performed",
    "Ran tests",
    "",
    "## Files Changed",
    "tests/example.ts",
    "",
    "## Command Output",
    "pass",
    "",
    "## Verification Results",
    "verified",
    "",
    "## Follow-ups",
    "none",
    "",
    "## Notes",
    "complete",
  ].join("\n");
}

async function stores(root: string) {
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey: project });
  return { project, paths, planStore: new DiscoveryPlanStore(paths), reportStore: new DiscoveryReportStore(paths), stateStore: new DiscoveryStateStore(paths), cycleStore: new WorkCycleStore(paths) };
}

test("Always-On discovery plan tool persists one valid plan and rejects duplicates/invalid input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-plan-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await stores(root);
  const registry = new AlwaysOnRunContextRegistry();
  const context: DiscoveryRunContext = {
    kind: "discovery",
    sessionKey: "discovery",
    runId: "run-1",
    projectKey: data.project,
    paths: data.paths,
    startedAt: new Date("2026-08-20T12:00:00.000Z"),
    planStore: data.planStore,
    planCallCount: 0,
  };
  registry.register(context);
  const tool = createAlwaysOnDiscoveryPlanTool({ runContexts: registry, uuid: () => "uuid", now: () => new Date("2026-08-20T12:00:00.000Z") });
  assert.equal(tool.isReadOnly({} as never), false);
  assert.equal(tool.isConcurrencySafe({} as never), false);
  const result = await tool.execute({ title: "", summary: " summary ", rationale: " reason ", dedupeKey: "", content: planMarkdown() }, toolContext("discovery"));
  assert.equal(result.data?.planId, "generated-plan");
  assert.equal(context.planCallCount, 1);
  assert.equal((await data.planStore.readIndex()).plans.length, 1);
  await assert.rejects(() => tool.execute({ title: "again", summary: "", rationale: "", dedupeKey: "", content: planMarkdown() }, toolContext("discovery")), /plan_quota_exhausted/);

  const invalidRegistry = new AlwaysOnRunContextRegistry();
  invalidRegistry.register({ ...context, sessionKey: "invalid", plan: undefined, planCallCount: 0 });
  const invalidTool = createAlwaysOnDiscoveryPlanTool({ runContexts: invalidRegistry });
  await assert.rejects(() => invalidTool.execute({ title: "x", summary: "x", rationale: "x", dedupeKey: "x", content: "# invalid" }, toolContext("invalid")), /plan_invalid/);
  await assert.rejects(() => tool.execute({ title: "x", summary: "x", rationale: "x", dedupeKey: "x", content: planMarkdown() }, toolContext("missing")), /outside/);
});

test("Always-On workspace tool handles auto/provider selection and duplicate preparation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-workspace-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await stores(root);
  const registry = new WorkspaceProviderRegistry();
  registry.add({
    id: "snapshot-copy",
    priority: 1,
    isApplicable: async () => true,
    prepare: async (input) => ({ runId: input.runId, projectKey: input.projectRoot, strategy: "snapshot-copy", cwd: join(root, "workspace"), metadata: {} }),
    publish: async () => ({}),
    dispose: async () => undefined,
  });
  const contexts = new AlwaysOnRunContextRegistry();
  const context: WorkspaceRunContext = { kind: "workspace", sessionKey: "workspace", runId: "run", planTitle: "Plan", projectKey: data.project, paths: data.paths, workspaceRegistry: registry, stateStore: data.stateStore, cycleStore: data.cycleStore, now: () => new Date() };
  contexts.register(context);
  const tool = createAlwaysOnWorkspaceTool({ runContexts: contexts });
  assert.equal(tool.isReadOnly({} as never), false);
  assert.equal(tool.isConcurrencySafe({} as never), false);
  const result = await tool.execute({ strategy: "auto" }, toolContext("workspace"));
  assert.equal(result.data?.strategy, "snapshot-copy");
  assert.equal(context.handle?.cwd, join(root, "workspace"));
  await assert.rejects(() => tool.execute({ strategy: "snapshot-copy" }, toolContext("workspace")), /workspace_already_prepared/);
  const explicitContexts = new AlwaysOnRunContextRegistry();
  explicitContexts.register({ ...context, sessionKey: "explicit", handle: undefined });
  const explicit = createAlwaysOnWorkspaceTool({ runContexts: explicitContexts });
  assert.equal((await explicit.execute({ strategy: "snapshot-copy" }, toolContext("explicit"))).data?.reused, false);
  const fresh = new AlwaysOnRunContextRegistry();
  fresh.register({ ...context, sessionKey: "missing-provider", handle: undefined });
  const unavailable = createAlwaysOnWorkspaceTool({ runContexts: fresh });
  await assert.rejects(() => unavailable.execute({ strategy: "git-worktree" }, toolContext("missing-provider")), /not available/);
});

test("Always-On report tool persists report from report and execution contexts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-report-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await stores(root);
  const registry = new AlwaysOnRunContextRegistry();
  const workspace = { runId: "run", projectKey: data.project, strategy: "snapshot-copy" as const, cwd: join(root, "workspace"), metadata: {} };
  const plan = { id: "plan", title: "Plan", createdAt: "2026-08-20T12:00:00.000Z", status: "executing" as const, summary: "", rationale: "", dedupeKey: "plan", sourceRunId: "run", planFilePath: "plan.md" };
  const report: ReportRunContext = { kind: "report", sessionKey: "report", runId: "run", projectKey: data.project, paths: data.paths, workspace, plan, reportStore: data.reportStore, reportCallCount: 0 };
  registry.register(report);
  const tool = createAlwaysOnReportTool({ runContexts: registry, now: () => new Date("2026-08-20T12:00:01.000Z") });
  assert.equal(tool.isReadOnly({} as never), false);
  assert.equal(tool.isConcurrencySafe({} as never), false);
  const result = await tool.execute({ content: reportMarkdown() }, toolContext("report"));
  assert.equal(result.data?.ok, true);
  assert.equal(report.reportCallCount, 1);
  assert.match(await readFile(result.data!.reportFilePath, "utf8"), /Plan Reference/);
  await assert.rejects(() => tool.execute({ content: reportMarkdown() }, toolContext("missing")), /outside/);
  registry.register({
    kind: "execution",
    sessionKey: "execution",
    runId: "run",
    projectKey: data.project,
    paths: data.paths,
    workspace,
    plan,
  });
  await assert.rejects(() => tool.execute({ content: reportMarkdown() }, toolContext("execution")), /without a reportStore/);
  const defaultRegistry = new AlwaysOnRunContextRegistry();
  defaultRegistry.register({ ...report, sessionKey: "default-report", report: undefined, reportCallCount: 0 });
  const defaultTool = createAlwaysOnReportTool({ runContexts: defaultRegistry });
  assert.equal((await defaultTool.execute({ content: reportMarkdown() }, toolContext("default-report"))).data?.ok, true);
});

test("Always-On chat history tool resolves aliases and bounds assistant text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-chat-history-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await stores(root);
  const realSessionId = "web:history";
  const chatDir = getPilotProjectChatDir(data.project, data.paths.pilotHome);
  await mkdir(chatDir, { recursive: true });
  const record = (entry: Record<string, unknown>, sequence: number) => JSON.stringify({ sequence, createdAt: "2026-08-20T12:00:00.000Z", sessionId: realSessionId, turnId: "turn", ...entry });
  const assistantText = "assistant ".repeat(80);
  const lines = [
    record({ type: "session_metadata", metadata: { title: "History title" } }, 1),
    record({ type: "accepted_input", messages: [{ role: "user", content: [{ type: "text", text: "user question" }] }] }, 2),
    record({ type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }, 3),
    record({ type: "turn_result", result: { type: "success", sessionId: realSessionId, turnId: "turn", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "2026-08-20T12:00:00.000Z", completedAt: "2026-08-20T12:00:01.000Z" } }, 4),
  ];
  await writeFile(join(chatDir, `${realSessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");

  const registry = new AlwaysOnRunContextRegistry();
  const context: DiscoveryRunContext = {
    kind: "discovery",
    sessionKey: "discovery-history",
    runId: "run-history",
    projectKey: data.project,
    paths: data.paths,
    startedAt: new Date(),
    planStore: data.planStore,
    planCallCount: 0,
    chatSessionAliases: new Map([["alias", realSessionId]]),
  };
  registry.register(context);
  const tool = createAlwaysOnChatHistoryTool({ runContexts: registry });
  assert.equal(tool.isReadOnly({ sessionId: "alias" }), true);
  assert.equal(tool.isConcurrencySafe({ sessionId: "alias" }), true);
  const result = await tool.execute({ sessionId: "alias" }, toolContext("discovery-history"));
  assert.equal(result.data?.title, "History title");
  assert.equal(result.data?.sessionId, realSessionId);
  assert.equal(result.data?.messageCount, 2);
  assert.equal(result.data?.conversation[1]?.text.length, 303);
  await assert.rejects(() => tool.execute({ sessionId: "alias" }, toolContext("missing")), /only available/);
});
