import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DiscoveryPlanService,
  normalizeDiscoveryPlanRecord,
  type DiscoveryPlanServiceDeps,
} from "../../src/always-on/web/DiscoveryPlanService.js";

function deps(root: string) {
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const projectDir = join(pilotHome, "always-on", "projects", "project-id");
  const calls: string[] = [];
  const dependencyState: DiscoveryPlanServiceDeps = {
    pilotHome,
    resolveProjectId: () => "project-id",
    paths: { extractProjectDirectory: async () => projectRoot },
    sessions: {
      getSessions: async () => ({ sessions: [{ id: "execution", createdAt: "2026-08-24T00:00:00Z", lastActivity: "2026-08-24T01:00:00Z", lastAssistantMessage: "done" }] }),
    },
    activity: { isSessionActive: (id) => id === "active" },
    events: {
      appendRunEvent: async (_root, event) => { calls.push(`event:${String(event.status)}`); return event; },
      appendRunLog: async () => undefined,
      appendRunLogEvent: async () => undefined,
      formatLogLine: (entry) => JSON.stringify(entry),
    },
    workspace: {
      applyWorktreeChanges: async () => ({ applied: true, diff: "diff" }),
      disposeWorkspace: async (_strategy, cwd) => { calls.push(`dispose:${cwd}`); },
    },
    state: { clearActiveWorkCycleId: async () => { calls.push("state:clear"); } },
  };
  return { service: new DiscoveryPlanService(dependencyState), projectRoot, projectDir, calls };
}

async function writeStore(projectDir: string, plans: unknown[], cycles: unknown[] = []): Promise<void> {
  await mkdir(join(projectDir, "plans"), { recursive: true });
  await mkdir(join(projectDir, "cycles"), { recursive: true });
  await writeFile(join(projectDir, "plans", "index.json"), JSON.stringify({ schemaVersion: 1, plans }) + "\n", "utf8");
  await writeFile(join(projectDir, "cycles", "index.json"), JSON.stringify({ schemaVersion: 1, cycles }) + "\n", "utf8");
}

function planRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    title: "Plan one",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    status: "completed",
    summary: "summary",
    rationale: "rationale",
    dedupeKey: "plan-1",
    sourceDiscoverySessionId: "discovery",
    executionSessionId: "execution",
    executionStatus: "completed",
    planFilePath: "plans/plan-1.md",
    contextRefs: { workingDirectory: ["cwd"], memory: [], existingPlans: [], cronJobs: [], recentChats: [] },
    ...overrides,
  };
}

test("normalizeDiscoveryPlanRecord maps legacy statuses and unsafe fields to stable defaults", () => {
  const normalized = normalizeDiscoveryPlanRecord({
    sourceRunId: "run-1",
    status: "executing",
    title: "  title ",
    contextRefs: { workingDirectory: [" a ", 3], memory: "bad" },
    workspace: { strategy: "snapshot-copy", cwd: "/tmp/work" },
  });
  assert.equal(normalized.status, "running");
  assert.equal(normalized.title, "title");
  assert.equal(normalized.sourceDiscoverySessionId, "run-1");
  assert.deepEqual(normalized.contextRefs.workingDirectory, ["a"]);
  assert.deepEqual(normalized.contextRefs.memory, []);
  assert.deepEqual(normalized.workspace, { strategy: "snapshot-copy", cwd: "/tmp/work" });
  assert.equal(normalizeDiscoveryPlanRecord({ status: "applied" }).status, "archived");
});

test("DiscoveryPlanService builds sorted plan and cycle overviews with session projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plan-service-overview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = deps(root);
  await writeStore(data.projectDir, [planRecord({ workCycleId: "cycle-1" }), planRecord({ id: "queued", status: "queued", updatedAt: "2026-08-22T00:00:00Z", executionSessionId: "" })], [{
    id: "cycle-1", projectKey: data.projectRoot, status: "active", workspace: { strategy: "snapshot-copy", cwd: "/tmp/cycle" }, planIds: ["plan-1"], createdAt: "2026-08-23T00:00:00Z",
  }]);
  await writeFile(join(data.projectDir, "plans", "plan-1.md"), "# Plan body\n", "utf8");
  const overview = await data.service.getPlansOverview("project");
  assert.equal(overview.plans.length, 2);
  assert.equal(overview.plans[0]?.id, "plan-1");
  assert.equal(overview.plans[0]?.latestSummary, "done");
  assert.equal(overview.plans[0]?.content, "# Plan body");
  assert.deepEqual(overview.plans[0]?.workspace, { strategy: "snapshot-copy", cwd: "/tmp/cycle" });
  assert.equal((await data.service.getCyclesOverview("project")).cycles.length, 1);
});

test("DiscoveryPlanService queues and finalizes cycle apply while archiving plans and cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plan-service-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = deps(root);
  const cycle = { id: "cycle-1", projectKey: data.projectRoot, status: "active", workspace: { strategy: "snapshot-copy", cwd: "/tmp/cycle" }, planIds: ["plan-1"], createdAt: "2026-08-23T00:00:00Z" };
  await writeStore(data.projectDir, [planRecord()], [cycle]);
  const queued = await data.service.queueCycleApply("project", "cycle-1");
  assert.equal(queued.cycle.status, "applying");
  assert.ok(queued.executionToken);
  assert.deepEqual(data.calls, ["event:queued"]);
  const finalized = await data.service.updateCycleExecution("project", "cycle-1", { status: "completed", executionToken: queued.executionToken });
  assert.equal(finalized.cycle.status, "applied");
  assert.ok(data.calls.includes("dispose:/tmp/cycle"));
  assert.ok(data.calls.includes("state:clear"));
  const stored = JSON.parse(await readFile(join(data.projectDir, "plans", "index.json"), "utf8")) as { plans: Array<{ status: string }> };
  assert.equal(stored.plans[0]?.status, "archived");
  await assert.rejects(() => data.service.queueCycleApply("project", "cycle-1"), (error: unknown) => (error as { code?: string }).code === "INVALID_STATE");
});

test("DiscoveryPlanService archives cycles, reads reports and returns explicit missing errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plan-service-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = deps(root);
  await writeStore(data.projectDir, [planRecord({ reportFilePath: "reports/explicit.md" }), planRecord({ id: "inferred", sourceDiscoverySessionId: "run-inferred", reportFilePath: undefined })], [{ id: "cycle-1", projectKey: data.projectRoot, status: "active", workspace: { strategy: "snapshot-copy", cwd: "/tmp/cycle" }, planIds: ["plan-1"], createdAt: "2026-08-23T00:00:00Z" }]);
  await mkdir(join(data.projectDir, "reports"), { recursive: true });
  await writeFile(join(data.projectDir, "reports", "explicit.md"), "explicit report", "utf8");
  await writeFile(join(data.projectDir, "reports", "run-inferred.md"), "inferred report", "utf8");
  assert.equal((await data.service.readReport("project", "plan-1")).content, "explicit report");
  assert.equal((await data.service.readReport("project", "inferred")).content, "inferred report");
  assert.deepEqual(await data.service.readStore("project"), { version: 1, plans: [
    normalizeDiscoveryPlanRecord(planRecord({ reportFilePath: "reports/explicit.md" })),
    normalizeDiscoveryPlanRecord(planRecord({ id: "inferred", sourceDiscoverySessionId: "run-inferred", reportFilePath: undefined })),
  ] });
  assert.deepEqual(await data.service.archiveCycle("project", "cycle-1"), { archived: true });
  await assert.rejects(() => data.service.archiveCycle("project", "missing"), (error: unknown) => (error as { code?: string }).code === "NOT_FOUND");
  await assert.rejects(() => data.service.readReport("project", "missing"), (error: unknown) => (error as { code?: string }).code === "NOT_FOUND");
});
