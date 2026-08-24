import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { AlwaysOnEventStore } from "../../src/always-on/storage/AlwaysOnEventStore.js";
import { DiscoveryPlanStore } from "../../src/always-on/storage/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../../src/always-on/storage/DiscoveryReportStore.js";
import { DiscoveryStateStore, defaultDiscoveryState, getDayKey } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/storage/WorkCycleStore.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import type { DiscoveryPlanRecord, WorkspaceHandle } from "../../src/always-on/protocol/types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-storage-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey: project });
  return { root, project, paths };
}

test("AlwaysOnEventStore appends, filters, orders and skips malformed events", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AlwaysOnEventStore(paths);
  await assert.deepEqual(await store.readEvents(), []);
  await store.appendEvent({ schemaVersion: 1, eventId: "old", runId: "r", projectKey: paths.projectKey, phase: "run_completed", timestamp: "2026-01-01T00:00:00.000Z" });
  await store.appendEvent({ schemaVersion: 1, eventId: "new", runId: "r", projectKey: paths.projectKey, phase: "run_failed", timestamp: "2026-01-02T00:00:00.000Z" });
  await writeFile(paths.eventsFile, `${await readFile(paths.eventsFile, "utf8")}not-json\n`, "utf8");
  assert.deepEqual((await store.readEvents({ since: "2026-01-01T12:00:00.000Z", limit: 1 })).map((event) => event.eventId), ["new"]);
  assert.deepEqual((await store.readEvents({ since: "invalid" })).map((event) => event.eventId), ["new", "old"]);
});

function plan(paths: ReturnType<typeof resolveAlwaysOnPaths>): DiscoveryPlanRecord {
  return {
    id: "plan-1",
    title: "Plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    summary: "summary",
    rationale: "rationale",
    dedupeKey: "plan",
    sourceRunId: "run-1",
    planFilePath: join(paths.projectDir, "plans", "plan-1.md"),
    reportFilePath: join(paths.projectDir, "reports", "run-1.md"),
    workspace: { strategy: "snapshot-copy", handle: "run-1", cwd: "/tmp/workspace" },
  };
}

test("DiscoveryPlanStore persists plans, relative paths, status transitions and corrupt indexes", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiscoveryPlanStore(paths);
  assert.deepEqual(await store.readIndex(), { schemaVersion: 1, plans: [] });
  const stored = await store.upsert(plan(paths));
  assert.equal(stored.planFilePath, join("plans", "plan-1.md"));
  await store.writePlanMarkdown("plan-1", "# plan");
  assert.equal(await store.readPlanMarkdown("plan-1"), "# plan");
  assert.equal(await store.readPlanMarkdown("missing"), undefined);
  assert.equal((await store.updateStatus("plan-1", { status: "completed", reportFilePath: join(paths.projectDir, "reports", "done.md") }))?.status, "completed");
  const withCycle = await store.updateStatus("plan-1", { workCycleId: "cycle-1" });
  assert.equal(withCycle?.workspace, undefined);
  assert.equal(await store.updateStatus("missing", { status: "failed" }), undefined);
  await writeFile(paths.planIndexFile, "broken", "utf8");
  assert.deepEqual(await store.readIndex(), { schemaVersion: 1, plans: [] });
});

test("DiscoveryReportStore writes reports, run events and history records", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiscoveryReportStore(paths);
  assert.equal(await store.writeReport("run/1", "report"), join(paths.reportsDir, "run-1.md"));
  await store.appendRunEvent("run/1", { type: "started" });
  await store.appendHistory({ schemaVersion: 1, runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", outcome: "no_plan" });
  assert.match(await readFile(join(paths.reportsDir, "run-1.md"), "utf8"), /report/);
  assert.match(await readFile(join(paths.runsDir, "run-1.events.jsonl"), "utf8"), /"started"/);
  assert.match(await readFile(paths.runHistoryFile, "utf8"), /"no_plan"/);
});

test("DiscoveryStateStore normalizes legacy state, resets daily budget and updates lifecycle fields", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiscoveryStateStore(paths);
  const dayOne = new Date("2026-01-01T12:00:00.000Z");
  assert.deepEqual(await store.read(dayOne), defaultDiscoveryState(dayOne));
  await mkdir(paths.projectDir, { recursive: true });
  await writeFile(paths.stateFile, JSON.stringify({ schemaVersion: 1, todayKey: "2025-12-31", todayRunCount: 4, consecutiveFailures: 2, currentWorkspace: { runId: "run", strategy: "snapshot-copy", cwd: "/tmp/ws", metadata: { ok: "yes", bad: 1 } }, dormant: { since: "x", lastBaselineAt: "y", lastChangeAt: "z" }, lastFireOutcome: "invalid" }), "utf8");
  const normalized = await store.read(dayOne);
  assert.equal(normalized.todayKey, getDayKey(dayOne));
  assert.equal(normalized.todayRunCount, 0);
  assert.equal(normalized.currentWorkspace?.metadata.ok, "yes");
  assert.equal(normalized.dormant?.lastChangeAt, "z");
  const started = await store.markFireStarted("run-1", dayOne);
  assert.equal(started.todayRunCount, 1);
  const failed = await store.markFireCompleted({ outcome: "failed", runId: "run-1", now: dayOne });
  assert.equal(failed.consecutiveFailures, 3);
  const cycle = await store.setActiveWorkCycleId("cycle-1", dayOne);
  assert.equal(cycle.currentWorkspace, undefined);
  assert.equal((await store.clearActiveWorkCycleId(dayOne)).activeWorkCycleId, undefined);
  assert.equal((await store.clearDormant(dayOne)).dormant, undefined);
  await writeFile(paths.stateFile, "not-json", "utf8");
  assert.deepEqual(await store.read(dayOne), defaultDiscoveryState(dayOne));
});

test("WorkCycleStore supports CRUD, status timestamps and legacy migration", async (t) => {
  const { root, paths } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WorkCycleStore(paths);
  const handle: WorkspaceHandle = { runId: "run-1", projectKey: paths.projectKey, strategy: "snapshot-copy", cwd: join(paths.snapshotsDir, "run-1"), metadata: { source: "test" } };
  assert.equal(await store.getActiveCycle(), undefined);
  const created = await store.create(handle, "run-1", "cycle-1", new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(created.status, "active");
  await store.addPlan("cycle-1", "plan-1");
  await store.addPlan("cycle-1", "plan-1");
  assert.deepEqual((await store.getRecord("cycle-1"))?.planIds, ["plan-1"]);
  assert.equal((await store.updateStatus("cycle-1", "applied", new Date("2026-01-02T00:00:00.000Z")))?.appliedAt, "2026-01-02T00:00:00.000Z");
  assert.equal((await store.updateStatus("cycle-1", "archived", new Date("2026-01-03T00:00:00.000Z")))?.archivedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(await store.updateStatus("missing", "active", new Date()), undefined);

  const legacyRoot = await fixture();
  t.after(() => rm(legacyRoot.root, { recursive: true, force: true }));
  await mkdir(legacyRoot.paths.projectDir, { recursive: true });
  await mkdir(legacyRoot.paths.plansDir, { recursive: true });
  await mkdir(join(legacyRoot.paths.snapshotsDir, "legacy"), { recursive: true });
  const legacyWorkspace = { runId: "legacy-run", strategy: "snapshot-copy", cwd: join(legacyRoot.paths.snapshotsDir, "legacy"), metadata: {} };
  await writeFile(legacyRoot.paths.stateFile, JSON.stringify({ schemaVersion: 1, todayKey: "2026-01-01", todayRunCount: 0, consecutiveFailures: 0, currentWorkspace: legacyWorkspace }), "utf8");
  await writeFile(legacyRoot.paths.planIndexFile, JSON.stringify({ schemaVersion: 1, plans: [{ id: "legacy-plan", workspace: { cwd: legacyWorkspace.cwd } }] }), "utf8");
  const migrated = await new WorkCycleStore(legacyRoot.paths).migrateFromLegacy();
  assert.equal(migrated?.createdByRunId, "legacy-run");
  assert.equal((await new WorkCycleStore(legacyRoot.paths).readIndex()).cycles.length, 1);
  assert.equal(JSON.parse(await readFile(legacyRoot.paths.stateFile, "utf8")).activeWorkCycleId, migrated?.id);
});
