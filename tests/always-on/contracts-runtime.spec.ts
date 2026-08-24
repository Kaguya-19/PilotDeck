import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultAlwaysOnConfig,
  parseAlwaysOnConfig,
} from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { parsePlanMarkdown } from "../../src/always-on/contracts/PlanContract.js";
import {
  buildFallbackReport,
  parseReportMarkdown,
  rebuildReport,
  type ReportMetadata,
} from "../../src/always-on/contracts/ReportContract.js";
import { evaluateAlwaysOnDiscoveryGates } from "../../src/always-on/runtime/DiscoveryGates.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { ChannelLeaseRegistry } from "../../src/always-on/runtime/ChannelLeaseRegistry.js";
import {
  planMarkdownPath,
  reportMarkdownPath,
  resolveAlwaysOnPaths,
  runEventsPath,
} from "../../src/always-on/storage/AlwaysOnPaths.js";
import type {
  AlwaysOnChannelLease,
  AlwaysOnDiscoveryState,
} from "../../src/always-on/protocol/types.js";
import type { PilotConfigDiagnostic } from "../../src/pilot/config/types.js";
import type { ExecutionRunContext } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";

const now = new Date("2026-01-02T12:00:00.000Z");

function validPlan(): string {
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

const reportMetadata: ReportMetadata = {
  runId: "run-1",
  planId: "plan-1",
  startedAt: "2026-01-02T11:00:00.000Z",
  finishedAt: "2026-01-02T12:00:00.000Z",
  outcome: "executed",
  workspaceStrategy: "snapshot-copy",
  workspaceHandle: "/tmp/workspace",
};

function baseState(overrides: Partial<AlwaysOnDiscoveryState> = {}): AlwaysOnDiscoveryState {
  return {
    schemaVersion: 1,
    todayKey: "2026-01-02",
    todayRunCount: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function lease(overrides: Partial<AlwaysOnChannelLease> = {}): AlwaysOnChannelLease {
  return {
    schemaVersion: 1,
    channelKey: "web",
    writerId: "writer",
    projectKey: "/tmp/project",
    sessionKey: "session",
    writtenAt: now.toISOString(),
    agentBusy: false,
    lastUserMsgAt: null,
    ...overrides,
  };
}

test("Always-On config uses defaults and rejects removed/invalid fields explicitly", () => {
  const defaults = defaultAlwaysOnConfig();
  assert.equal(defaults.enabled, false);
  const diagnostics: PilotConfigDiagnostic[] = [];
  const parsed = parseAlwaysOnConfig({
    enabled: true,
    language: "zh-CN",
    trigger: { enabled: true, tickIntervalMinutes: 2, cooldownMinutes: -1, dailyBudget: 2.5, preferChannel: "" },
    dormancy: { ignoreGlobs: ["ok", 1, ""] },
    workspace: { strategy: "removed", snapshotMaxBytes: 0 },
    execution: { permissionMode: "bypass", maxTurns: 3 },
    projects: { "/tmp/project": { enabled: true, unknown: true, sessionKey: "old" } },
    unknown: true,
  }, diagnostics);
  assert.equal(parsed?.enabled, true);
  assert.equal(parsed?.language, "zh-CN");
  assert.equal(parsed?.trigger.tickIntervalMinutes, 2);
  assert.equal(parsed?.trigger.cooldownMinutes, 60);
  assert.deepEqual(parsed?.dormancy.ignoreGlobs, ["ok"]);
  assert.equal(parsed?.projects["/tmp/project"]?.enabled, true);
  assert.ok(diagnostics.some((item) => item.code === "ALWAYS_ON_FIELD_REMOVED"));
  assert.ok(diagnostics.some((item) => item.code === "ALWAYS_ON_NUMBER_INVALID"));
  assert.ok(diagnostics.some((item) => item.code === "ALWAYS_ON_UNKNOWN_FIELD"));
  assert.ok(diagnostics.some((item) => item.code === "ALWAYS_ON_PROJECT_UNKNOWN_FIELD"));

  const invalid: PilotConfigDiagnostic[] = [];
  assert.equal(parseAlwaysOnConfig(null, invalid), undefined);
  assert.equal(invalid[0]?.code, "ALWAYS_ON_CONFIG_INVALID");
  const removed: PilotConfigDiagnostic[] = [];
  parseAlwaysOnConfig({ discovery: {} }, removed);
  assert.equal(removed[0]?.code, "ALWAYS_ON_FIELD_REMOVED");
});

test("PlanContract accepts canonical markdown and rejects malformed contracts", () => {
  const parsed = parsePlanMarkdown(validPlan().replace(/\n/g, "\r\n").replace("Summary", "Summary\u00a0"));
  assert.equal(parsed.title, "Improve tests");
  assert.equal(parsed.metadata.id, "plan-1");
  assert.match(parsed.rawContent, /## Verification/);

  const failures: string[] = [];
  const cases = [
    "",
    "plain",
    "# Title",
    "# Title\n> Always-On Discovery Plan\n> id: x\n> sourceRunId: y\n> createdAt: z\n> projectRoot: p\n> unknown: q",
    validPlan().replace("## Summary", "## Other"),
    validPlan().replace("Add a focused unit test.", "TODO later"),
    validPlan().replace("1. Write the test.", "- Write the test."),
    validPlan().replace("- A regression was observed.", "context"),
  ];
  for (const content of cases) {
    assert.throws(() => parsePlanMarkdown(content));
    failures.push(content.slice(0, 12));
  }
  assert.equal(failures.length, cases.length);
  assert.throws(() => parsePlanMarkdown(validPlan(), { maxResultSizeChars: 10 }));
});

test("ReportContract builds fallbacks and repairs missing or downgraded sections", () => {
  const fallback = buildFallbackReport({ metadata: reportMetadata, title: "Fallback", reason: "tool failed", partial: "partial output" });
  assert.match(fallback, /fallback: tool failed/);
  assert.match(fallback, /## Partial Tool Payload/);
  const parsedFallback = parseReportMarkdown(fallback, reportMetadata);
  assert.equal(parsedFallback.title, "Fallback - Work Report");
  assert.equal(parsedFallback.fallbacks.length, 0);

  const complete = rebuildReport("Complete", reportMetadata, {
    "Plan Reference": "plan",
    "Steps Performed": "steps",
    "Files Changed": "files",
    "Command Output": "output",
    "Verification Results": "verified",
    "Follow-ups": "follow",
    "Notes": "notes",
    Extra: "extra",
  });
  const parsed = parseReportMarkdown(complete, reportMetadata);
  assert.equal(parsed.title, "Complete");
  assert.equal(parsed.sections.Extra, "extra");
  assert.deepEqual(parsed.fallbacks, []);

  const repaired = parseReportMarkdown([
    "## Plan Reference",
    "plan",
    "# Steps Performed",
    "steps",
  ].join("\n"), reportMetadata);
  assert.equal(repaired.title, "Always-On Discovery Run");
  assert.ok(repaired.fallbacks.includes("title-missing"));
  assert.ok(repaired.fallbacks.includes("h1-downgraded(Steps Performed)"));
  assert.ok(repaired.fallbacks.some((item) => item.startsWith("section-missing(")));
  assert.match(repaired.sections.Notes, /fallback/);
});

test("discovery gates stop at the first blocking invariant and select preferred lease", () => {
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.projects["/tmp/project"] = { enabled: true };
  const baseInput = {
    projectKey: "/tmp/project",
    config,
    state: baseState(),
    leases: [] as AlwaysOnChannelLease[],
    now,
    projectExists: true,
    lockHeld: false,
  };
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, config: { ...config, enabled: false } }), { ok: false, reason: "disabled" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, config: { ...config, trigger: { ...config.trigger, enabled: false } } }), { ok: false, reason: "disabled" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, config: { ...config, projects: {} } }), { ok: false, reason: "project_disabled" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, projectExists: false }), { ok: false, reason: "project_missing" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, state: baseState({ dormant: { since: "x", lastBaselineAt: "x" } }) }), { ok: false, reason: "dormant_no_signal" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, sessionInFlight: true }), { ok: false, reason: "agent_busy" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, leases: [lease({ agentBusy: true })] }), { ok: false, reason: "agent_busy" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, leases: [lease({ lastUserMsgAt: now.toISOString() })] }), { ok: false, reason: "recent_user_msg" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, state: baseState({ lastFireCompletedAt: now.toISOString() }) }), { ok: false, reason: "cooldown" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, state: baseState({ todayRunCount: config.trigger.dailyBudget }) }), { ok: false, reason: "daily_budget" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates({ ...baseInput, lockHeld: true }), { ok: false, reason: "lock_busy" });
  assert.deepEqual(evaluateAlwaysOnDiscoveryGates(baseInput), { ok: true, lease: undefined });

  const selected = lease({ channelKey: "web" });
  const other = lease({ channelKey: "feishu", writerId: "other" });
  const allowed = evaluateAlwaysOnDiscoveryGates({ ...baseInput, leases: [other, selected] });
  assert.deepEqual(allowed, { ok: true, lease: selected });
});

test("ChannelLeaseRegistry updates, filters stale leases and removes by writer", () => {
  let clock = now;
  const registry = new ChannelLeaseRegistry(() => clock);
  registry.set({ projectKey: "/tmp/project", channelKey: "web", writerId: "one", sessionKey: "s", agentBusy: false });
  registry.set({ projectKey: "/tmp/project", channelKey: "feishu", writerId: "one", sessionKey: "s2", agentBusy: false, lastUserMsgAt: now.toISOString() });
  registry.set({ projectKey: "/tmp/other", channelKey: "web", writerId: "two", sessionKey: "s3", agentBusy: false });
  registry.markBusy({ projectKey: "/tmp/project", channelKey: "web", writerId: "one" });
  assert.equal(registry.list().find((item) => item.channelKey === "web")?.agentBusy, true);
  clock = new Date(now.getTime() + 10_000);
  registry.markIdle({ projectKey: "/tmp/project", channelKey: "web", writerId: "one" });
  assert.equal(registry.listFresh({ projectKey: "/tmp/project", staleSeconds: 5, now: clock }).length, 1);
  registry.remove({ projectKey: "/tmp/project", channelKey: "feishu", writerId: "one" });
  registry.removeByWriter("one");
  assert.equal(registry.list().some((item) => item.writerId === "one"), false);
  registry.remove({ projectKey: "/tmp/missing", channelKey: "x", writerId: "x" });
});

test("session overrides and run contexts enforce key isolation", () => {
  const overrides = new SessionConfigOverrides();
  overrides.set("always:s1", { cwd: "/tmp/a", excludeTools: ["ask_user_question"] });
  assert.deepEqual(overrides.get("always:s1"), { cwd: "/tmp/a", excludeTools: ["ask_user_question"] });
  const copy = overrides.get("always:s1");
  copy!.excludeTools!.push("enter_plan_mode");
  assert.deepEqual(overrides.get("always:s1")?.excludeTools, ["ask_user_question"]);
  overrides.set("rules", { canPrompt: false, permissionRules: { allow: [], deny: [], ask: [] } });
  const rulesCopy = overrides.get("rules");
  assert.ok(rulesCopy?.permissionRules);
  assert.notStrictEqual(rulesCopy?.permissionRules, overrides.get("rules")?.permissionRules);
  overrides.delete("rules");
  assert.equal(overrides.get("rules"), undefined);
  overrides.set("always:s2", { cwd: "/tmp/b" });
  overrides.deletePrefix("missing:");
  overrides.deletePrefix("always:");
  assert.equal(overrides.get("always:s1"), undefined);
  assert.equal(overrides.get("always:s2"), undefined);
  overrides.clear();

  const registry = new AlwaysOnRunContextRegistry();
  const context: ExecutionRunContext = {
    kind: "execution",
    sessionKey: "key",
    runId: "run",
    projectKey: "project",
    paths: {} as ExecutionRunContext["paths"],
    workspace: { runId: "run", projectKey: "project", strategy: "snapshot-copy", cwd: "/tmp", metadata: {} },
    plan: {
      id: "plan",
      title: "Plan",
      createdAt: "2026-01-02T00:00:00.000Z",
      status: "ready",
      summary: "summary",
      rationale: "rationale",
      dedupeKey: "dedupe",
      sourceRunId: "run",
      planFilePath: "/tmp/plan.md",
    },
  };
  registry.register(context);
  assert.equal(registry.get("key"), context);
  assert.equal(registry.getExecution("key"), context);
  assert.equal(registry.getDiscovery("key"), undefined);
  assert.throws(() => registry.register(context), /already exists/);
  assert.equal(registry.list().length, 1);
  registry.unregister("key");
  assert.equal(registry.get("key"), undefined);
});

test("Always-On paths sanitize ids and keep derived files under project storage", () => {
  const paths = resolveAlwaysOnPaths({ pilotHome: "/tmp/pilot-home", projectKey: "/tmp/project", worktreesBaseDir: "/tmp/worktrees", snapshotsBaseDir: "/tmp/snapshots" });
  assert.equal(paths.projectKey, "/tmp/project");
  assert.match(paths.projectDir, /always-on/);
  assert.match(planMarkdownPath(paths, "a/b?"), /a-b/);
  assert.match(reportMarkdownPath(paths, ""), /unnamed/);
  assert.match(runEventsPath(paths, "run:1"), /run-1/);
});
