import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import { defaultAlwaysOnConfig } from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { AlwaysOnError } from "../../src/always-on/protocol/errors.js";
import type { DiscoveryPlanRecord } from "../../src/always-on/protocol/types.js";
import { AlwaysOnEventStore } from "../../src/always-on/storage/AlwaysOnEventStore.js";
import { DiscoveryPlanStore } from "../../src/always-on/storage/DiscoveryPlanStore.js";
import { resolveAlwaysOnPaths, runEventsPath } from "../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryReportStore } from "../../src/always-on/storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/storage/WorkCycleStore.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { DiscoveryFire, ensureActiveWorkCycle } from "../../src/always-on/runtime/DiscoveryFire.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";
import type { WorkspaceProvider } from "../../src/always-on/workspace/WorkspaceProvider.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function planMarkdown(): string {
  return [
    "# Improve tests",
    "",
    "> Always-On Discovery Plan",
    "> id: plan-1",
    "> sourceRunId: run-1",
    "> createdAt: 2026-01-02T11:00:00.000Z",
    "> projectRoot: /tmp/project",
    "> dedupeKey: improve-tests",
    "",
    "## Summary",
    "Add deterministic coverage.",
    "",
    "## Rationale",
    "The current boundary needs proof.",
    "",
    "## Context Signals",
    "- A regression was observed.",
    "",
    "## Proposed Change",
    "Add a focused unit test.",
    "",
    "## Execution Steps",
    "1. Write the test.",
    "",
    "## Verification",
    "- Run the focused test.",
  ].join("\n");
}

function reportMarkdown(): string {
  return [
    "# Work Report",
    "",
    "## Plan Reference",
    "plan-1",
    "",
    "## Steps Performed",
    "Executed deterministic test.",
    "",
    "## Files Changed",
    "tests/example.spec.ts",
    "",
    "## Command Output",
    "pass",
    "",
    "## Verification Results",
    "all green",
    "",
    "## Follow-ups",
    "none",
    "",
    "## Notes",
    "complete",
  ].join("\n");
}

function configFor(projectKey: string) {
  const config = defaultAlwaysOnConfig();
  config.language = "en";
  config.projects[projectKey] = { enabled: true };
  return config;
}

function planRecord(projectRoot: string, planFilePath: string): DiscoveryPlanRecord {
  return {
    id: "plan-1",
    title: "Improve tests",
    createdAt: "2026-01-02T11:00:00.000Z",
    status: "ready",
    summary: "Add deterministic coverage.",
    rationale: "The current boundary needs proof.",
    dedupeKey: "improve-tests",
    sourceRunId: "run-1",
    planFilePath,
  };
}

function providerFor(paths: ReturnType<typeof resolveAlwaysOnPaths>): WorkspaceProviderRegistry {
  const registry = new WorkspaceProviderRegistry();
  registry.add({
    id: "snapshot-copy",
    priority: 1,
    isApplicable: async () => true,
    prepare: async (input) => {
      const cwd = join(paths.snapshotsDir, input.runId);
      await mkdir(cwd, { recursive: true });
      return { runId: input.runId, projectKey: input.projectRoot, strategy: "snapshot-copy", cwd, metadata: {} };
    },
    publish: async (handle) => ({ diff: `snapshot at ${handle.cwd}` }),
    dispose: async () => undefined,
  });
  return registry;
}

class FakeGateway implements Gateway {
  workspaceCwd?: string;
  readonly calls: string[] = [];
  readonly emittedErrors: string[] = [];

  constructor(
    private readonly contexts: AlwaysOnRunContextRegistry,
    private readonly reportStore: DiscoveryReportStore,
    private readonly mode:
      | "no-plan"
      | "discovery-error"
      | "success"
      | "execution-error"
      | "report-error"
      | "report-text"
      | "report-no-tool"
      | "workspace-no-handle"
      | "apply-error",
  ) {}

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    this.calls.push(String(input.channelKey));
    const context = this.contexts.get(input.sessionKey);
    if (input.channelKey === "always-on/discovery") {
      if (this.mode === "discovery-error") {
        yield { type: "error", code: "discovery_failed", message: "discovery failed", recoverable: false };
        return;
      }
      if (this.mode !== "no-plan") {
        const discovery = this.contexts.getDiscovery(input.sessionKey)!;
        const path = await discovery.planStore.writePlanMarkdown("plan-1", planMarkdown());
        const record = planRecord(discovery.projectKey, path);
        await discovery.planStore.upsert(record);
        discovery.plan = { record, markdown: planMarkdown() };
      }
      yield { type: "assistant_text_delta", text: "discovery" };
      return;
    }
    if (input.channelKey === "always-on/workspace") {
      if (this.mode === "workspace-no-handle") return;
      const workspace = this.contexts.getWorkspace(input.sessionKey)!;
      const cwd = this.workspaceCwd ?? join(workspace.paths.snapshotsDir, input.runId);
      await mkdir(cwd, { recursive: true });
      workspace.handle = { runId: input.runId, projectKey: workspace.projectKey, strategy: "snapshot-copy", cwd, metadata: {} };
      yield { type: "tool_call_finished", toolCallId: "workspace", name: "always_on_prepare_workspace", ok: true };
      return;
    }
    if (input.channelKey === "always-on/execute" && this.mode === "execution-error") {
      this.emittedErrors.push("execution");
      yield { type: "error", code: "execution_failed", message: "execution failed", recoverable: false };
      return;
    }
    if (input.channelKey === "always-on/report") {
      if (this.mode === "report-error") {
        this.emittedErrors.push("report");
        yield { type: "error", code: "report_failed", message: "report failed", recoverable: false };
        return;
      }
      if (this.mode === "report-no-tool") return;
      if (this.mode === "report-text") {
        yield { type: "assistant_text_delta", text: reportMarkdown() };
        return;
      }
      const report = this.contexts.getReport(input.sessionKey)!;
      const filePath = await this.reportStore.writeReport(report.runId, reportMarkdown());
      report.report = { markdown: reportMarkdown(), filePath, finishedAt: new Date("2026-01-02T12:00:00.000Z") };
      yield { type: "assistant_text_delta", text: "report" };
    } else if (input.channelKey === "always-on/apply") {
      if (this.mode === "apply-error") {
        yield { type: "error", code: "apply_failed", message: "apply failed", recoverable: false };
      } else {
        yield { type: "assistant_text_delta", text: "apply" };
      }
    } else if (context?.kind === "execution") {
      yield { type: "assistant_text_delta", text: "execution" };
    }
  }

  async abortTurn(): Promise<void> {}
  async listSessions() { return { sessions: [] }; }
  async resumeSession(input: { sessionKey: string }) { return { sessionKey: input.sessionKey }; }
  async newSession(input: { sessionKey?: string }) { return { sessionKey: input.sessionKey ?? "new" }; }
  async closeSession(): Promise<void> {}
  async describeServer() { return { mode: "in_process" as const }; }
  async cronCreate() { return {} as never; }
  async cronList() { return {} as never; }
  async cronUpdate() { return {} as never; }
  async cronDelete() { return {} as never; }
  async cronStop() { return {} as never; }
  async cronRunNow() { return {} as never; }
  async respondElicitation() { return { delivered: false }; }
  async permissionDecide() { return { delivered: false }; }
  async grantSessionPermission() { return { granted: false }; }
  async readSessionMessages() { return {} as never; }
  async forkSession() { return {} as never; }
  async readSubagentMessages() { return {} as never; }
  async listProjects() { return {} as never; }
  async describeProject() { return {} as never; }
}

async function makeDeps(root: string, mode: ConstructorParameters<typeof FakeGateway>[2]) {
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey: project, snapshotsBaseDir: join(root, "snapshots") });
  const contexts = new AlwaysOnRunContextRegistry();
  const reportStore = new DiscoveryReportStore(paths);
  const now = () => new Date("2026-01-02T12:00:00.000Z");
  return {
    project,
    projectKey: project,
    paths,
    contexts,
    planStore: new DiscoveryPlanStore(paths),
    stateStore: new DiscoveryStateStore(paths),
    cycleStore: new WorkCycleStore(paths),
    reportStore,
    eventStore: new AlwaysOnEventStore(paths),
    sessionOverrides: new SessionConfigOverrides(),
    workspaceRegistry: providerFor(paths),
    gateway: new FakeGateway(contexts, reportStore, mode),
    config: configFor(project),
    now,
  };
}

test("DiscoveryFire derives isolated session keys and ensures/reuses a work cycle", async (t) => {
  const root = await tempDir("pilotdeck-discovery-cycle-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = await makeDeps(root, "no-plan");
  assert.equal(DiscoveryFire.deriveDiscoverySessionKey("p", "r"), "always-on/discovery:project=p:run=r");
  assert.equal(DiscoveryFire.deriveWorkspaceSessionKey("p", "r"), "always-on/workspace:project=p:run=r");
  assert.equal(DiscoveryFire.deriveExecutionSessionKey("p", "r"), "always-on/execute:project=p:run=r");
  assert.equal(DiscoveryFire.deriveReportSessionKey("p", "r"), "always-on/report:project=p:run=r");
  assert.equal(DiscoveryFire.deriveApplySessionKey("p", "r"), "always-on/apply:project=p:run=r");

  const now = deps.now();
  const first = await ensureActiveWorkCycle({
    state: await deps.stateStore.read(now), projectKey: deps.project, runId: "run-1", planTitle: "Plan", cycleId: "cycle-1",
    workspaceRegistry: deps.workspaceRegistry, stateStore: deps.stateStore, cycleStore: deps.cycleStore, now: deps.now,
  });
  assert.equal(first.reused, false);
  const second = await ensureActiveWorkCycle({
    state: { ...(await deps.stateStore.read(now)), activeWorkCycleId: first.cycle.id }, projectKey: deps.project, runId: "run-2", planTitle: "Plan", cycleId: "cycle-2",
    workspaceRegistry: deps.workspaceRegistry, stateStore: deps.stateStore, cycleStore: deps.cycleStore, now: deps.now,
    fileExists: () => true,
  });
  assert.equal(second.reused, true);
  assert.equal(second.cycle.id, "cycle-1");
});

test("ensureActiveWorkCycle migrates legacy state and replaces stale cycles", async (t) => {
  const root = await tempDir("pilotdeck-discovery-cycle-branches-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = await makeDeps(root, "no-plan");
  const now = deps.now();
  const legacyCwd = join(deps.paths.snapshotsDir, "legacy");
  await mkdir(legacyCwd, { recursive: true });

  const legacy = await ensureActiveWorkCycle({
    state: {
      ...(await deps.stateStore.read(now)),
      currentWorkspace: {
        runId: "legacy-run",
        cwd: legacyCwd,
        strategy: "snapshot-copy",
        metadata: { source: "legacy" },
      },
    },
    projectKey: deps.project,
    runId: "new-run",
    planTitle: "Plan",
    cycleId: "legacy-cycle",
    workspaceRegistry: deps.workspaceRegistry,
    stateStore: deps.stateStore,
    cycleStore: deps.cycleStore,
    now: deps.now,
    fileExists: () => true,
  });
  assert.equal(legacy.reused, true);
  assert.equal(legacy.handle.runId, "legacy-run");
  assert.equal((await deps.stateStore.read(now)).activeWorkCycleId, legacy.cycle.id);

  const stale = await deps.cycleStore.create(
    { runId: "stale-run", projectKey: deps.project, strategy: "snapshot-copy", cwd: join(root, "gone"), metadata: {} },
    "stale-run",
    "stale-cycle",
    now,
  );
  const replaced = await ensureActiveWorkCycle({
    state: { ...(await deps.stateStore.read(now)), activeWorkCycleId: stale.id },
    projectKey: deps.project,
    runId: "replacement-run",
    planTitle: "Replacement",
    cycleId: "replacement-cycle",
    workspaceRegistry: deps.workspaceRegistry,
    stateStore: deps.stateStore,
    cycleStore: deps.cycleStore,
    now: deps.now,
    fileExists: (path) => path !== stale.workspace.cwd,
  });
  assert.equal(replaced.reused, false);
  assert.match(replaced.handle.cwd, /replacement-run/);
});

test("DiscoveryFire records no-plan and discovery failure outcomes", async (t) => {
  const root = await tempDir("pilotdeck-discovery-outcomes-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");
  for (const mode of ["no-plan", "discovery-error"] as const) {
    const deps = await makeDeps(join(root, mode), mode);
    const fire = new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => `${mode}-event`, now: deps.now });
    const result = await fire.run({ runId: `${mode}-run`, startedAt });
    assert.equal(result.outcome, mode === "no-plan" ? "no_plan" : "failed");
    if (mode === "discovery-error") assert.equal(result.error?.code, "discovery_failed");
    assert.ok((await deps.eventStore.readEvents()).length > 0);
  }
});

test("DiscoveryFire completes all phases and preserves execution/report failures", async (t) => {
  const root = await tempDir("pilotdeck-discovery-full-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");
  const success = await makeDeps(join(root, "success"), "success");
  const telemetryEvents: unknown[] = [];
  const fire = new DiscoveryFire({
    ...success,
    runContexts: success.contexts,
    uuid: () => "event",
    now: success.now,
    telemetry: {
      trackFeatureLoopStage: (event: unknown) => telemetryEvents.push(event),
      trackError: (message: string, event: unknown) => telemetryEvents.push({ message, event }),
    } as never,
  });
  const result = await fire.run({ runId: "success-run", startedAt });
  assert.equal(result.outcome, "executed");
  assert.equal(result.planId, "plan-1");
  assert.ok(result.reportFilePath);
  assert.match(await readFile(result.reportFilePath!, "utf8"), /Work Report/);
  assert.ok((await success.eventStore.readEvents()).some((event) => event.phase === "run_completed"));
  assert.ok(telemetryEvents.length > 0);

  for (const mode of ["execution-error", "report-error"] as const) {
    const deps = await makeDeps(join(root, mode), mode);
    const failed = await new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => `${mode}-event`, now: deps.now }).run({ runId: `${mode}-run`, startedAt });
    assert.ok((deps.gateway as FakeGateway).calls.includes("always-on/execute"), (deps.gateway as FakeGateway).calls.join(","));
    assert.ok((deps.gateway as FakeGateway).emittedErrors.length > 0, `${mode}:${(deps.gateway as FakeGateway).calls.join(",")}`);
    assert.equal(failed.outcome, mode === "execution-error" ? "failed" : "executed");
    assert.ok(failed.error);
    assert.ok(failed.reportFilePath);
  }
});

test("DiscoveryFire handles report text fallback and an uninvoked report tool", async (t) => {
  const root = await tempDir("pilotdeck-discovery-report-fallback-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");

  for (const mode of ["report-text", "report-no-tool"] as const) {
    const deps = await makeDeps(join(root, mode), mode);
    const result = await new DiscoveryFire({
      ...deps,
      runContexts: deps.contexts,
      uuid: () => `${mode}-event`,
      now: deps.now,
    }).run({ runId: `${mode}-run`, startedAt });
    assert.equal(result.outcome, "executed");
    assert.ok(result.reportFilePath);
    const report = await readFile(result.reportFilePath!, "utf8");
    if (mode === "report-text") assert.match(report, /Work Report/);
    else assert.match(report, /report tool was not invoked/);
  }
});

test("DiscoveryFire records a workspace preparation failure and cleans run state", async (t) => {
  const root = await tempDir("pilotdeck-discovery-workspace-failure-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = await makeDeps(root, "workspace-no-handle");
  deps.workspaceRegistry = new WorkspaceProviderRegistry();
  const fire = new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => "workspace-failure-event", now: deps.now });
  const result = await fire.run({ runId: "workspace-failure-run", startedAt: deps.now() });
  assert.equal(result.outcome, "failed");
  assert.equal(result.error?.code, "workspace_unavailable");
  assert.equal(deps.contexts.list().length, 0);
  assert.equal(deps.sessionOverrides.get(DiscoveryFire.deriveWorkspaceSessionKey(deps.project, "workspace-failure-run")), undefined);
});

test("DiscoveryFire reruns persisted plans and reports missing plan/body errors", async (t) => {
  const root = await tempDir("pilotdeck-discovery-rerun-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");

  const missing = await makeDeps(join(root, "missing"), "success");
  const missingFire = new DiscoveryFire({ ...missing, runContexts: missing.contexts, uuid: () => "missing-event", now: missing.now });
  assert.equal((await missingFire.rerunPlan({ planId: "missing", runId: "missing-run", startedAt })).error?.code, "plan_not_found");

  const bodyMissing = await makeDeps(join(root, "body-missing"), "success");
  await bodyMissing.planStore.upsert({ ...planRecord(bodyMissing.project, join(bodyMissing.paths.plansDir, "body-only.md")), id: "body-only" });
  const bodyFire = new DiscoveryFire({ ...bodyMissing, runContexts: bodyMissing.contexts, uuid: () => "body-event", now: bodyMissing.now });
  assert.equal((await bodyFire.rerunPlan({ planId: "body-only", runId: "body-run", startedAt })).error?.code, "plan_body_missing");

  const deps = await makeDeps(join(root, "success"), "success");
  const path = await deps.planStore.writePlanMarkdown("plan-1", planMarkdown());
  await deps.planStore.upsert(planRecord(deps.project, path));
  const success = await new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => "rerun-event", now: deps.now }).rerunPlan({ planId: "plan-1", runId: "rerun-run", startedAt });
  assert.equal(success.outcome, "executed");
  assert.equal(success.planId, "plan-1");
});

test("DiscoveryFire apply phase always cleans overrides and returns tool failures", async (t) => {
  const root = await tempDir("pilotdeck-discovery-apply-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");
  for (const mode of ["success", "apply-error"] as const) {
    const deps = await makeDeps(join(root, mode), mode);
    const workspace = join(deps.paths.snapshotsDir, "cycle");
    await mkdir(workspace, { recursive: true });
    const cycle = {
      id: "cycle", projectKey: deps.project, status: "active" as const,
      workspace: { strategy: "snapshot-copy" as const, cwd: workspace, metadata: {} },
      planIds: ["plan-1"], createdAt: startedAt.toISOString(), createdByRunId: "run",
    };
    const fire = new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => `${mode}-event`, now: deps.now });
    const result = await fire.runApplyPhase({ runId: `${mode}-run`, cycle, plans: [{ id: "plan-1", title: "Plan" }], projectName: "Project", projectRoot: deps.project });
    assert.equal(result.sessionKey, `always-on/apply:project=${deps.project}:run=${mode}-run`);
    assert.equal(mode === "apply-error", result.error !== undefined);
    assert.equal(deps.sessionOverrides.get(result.sessionKey), undefined);
  }

  const observed: GatewayEvent[] = [];
  const persisted = await makeDeps(join(root, "persisted"), "success");
  const workspace = join(persisted.paths.snapshotsDir, "cycle");
  await mkdir(workspace, { recursive: true });
  const fire = new DiscoveryFire({
    ...persisted,
    runContexts: persisted.contexts,
    uuid: () => "persisted-event",
    now: persisted.now,
    onTurnEvent: (_sessionKey, _channelKey, event) => observed.push(event),
  });
  const result = await fire.runApplyPhase({
    runId: "persisted-run",
    cycle: {
      id: "cycle", projectKey: persisted.project, status: "active",
      workspace: { strategy: "snapshot-copy", cwd: workspace, metadata: {} },
      planIds: ["plan-1"], createdAt: persisted.now().toISOString(), createdByRunId: "run",
    },
    plans: [{ id: "plan-1", title: "Plan" }],
    projectName: "Project",
    projectRoot: persisted.project,
  });
  assert.equal(observed.length, 1);
  assert.match(await readFile(runEventsPath(persisted.paths, "persisted-run.apply"), "utf8"), /assistant_text_delta/);
  assert.equal(result.error, undefined);
});

test("DiscoveryFire reuses an active workspace and reports workspace preparation failures", async (t) => {
  const root = await tempDir("pilotdeck-discovery-workspace-branches-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-01-02T12:00:00.000Z");

  const reused = await makeDeps(join(root, "reused"), "success");
  const existing = join(reused.paths.snapshotsDir, "existing");
  await mkdir(existing, { recursive: true });
  const cycle = await reused.cycleStore.create({ runId: "old", projectKey: reused.project, strategy: "snapshot-copy", cwd: existing, metadata: {} }, "old", "cycle-old", startedAt);
  await reused.stateStore.setActiveWorkCycleId(cycle.id, startedAt);
  const reusedResult = await new DiscoveryFire({ ...reused, runContexts: reused.contexts, uuid: () => "reuse-event", now: reused.now }).run({ runId: "reuse-run", startedAt });
  assert.equal(reusedResult.outcome, "executed");
  assert.equal((reused.gateway as FakeGateway).calls.includes("always-on/workspace"), false);

  const unsafe = await makeDeps(join(root, "unsafe"), "success");
  (unsafe.gateway as FakeGateway).workspaceCwd = join(root, "outside");
  await assert.rejects(
    new DiscoveryFire({ ...unsafe, runContexts: unsafe.contexts, uuid: () => "unsafe-event", now: unsafe.now }).run({ runId: "unsafe-run", startedAt }),
    (error: unknown) => error instanceof AlwaysOnError && error.code === "workspace_unavailable",
  );
});

test("DiscoveryFire rejects project-root and outside workspace handles", async (t) => {
  const root = await tempDir("pilotdeck-discovery-safety-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = await makeDeps(root, "success");
  const fire = new DiscoveryFire({ ...deps, runContexts: deps.contexts, uuid: () => "event", now: deps.now });
  (deps.gateway as FakeGateway).workspaceCwd = deps.project;
  await assert.rejects(
    fire.run({ runId: "unsafe-run", startedAt: new Date("2026-01-02T12:00:00.000Z") }),
    (error: unknown) => error instanceof AlwaysOnError && error.code === "workspace_unavailable",
  );
});
