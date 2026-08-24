import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AlwaysOnRunHistoryService,
  type AlwaysOnRunHistoryServiceDeps,
} from "../../src/always-on/web/AlwaysOnRunHistoryService.js";

function createService(root: string, sessionMessages?: AlwaysOnRunHistoryServiceDeps["sessionMessages"]) {
  const historyRoot = join(root, "always-on");
  const baseDeps = {
    paths: { getAlwaysOnRoot: () => historyRoot },
    logs: {
      getAlwaysOnRunLog: async () => ({ content: "", truncated: false, size: 0 }),
    },
    sessionMessages,
  };
  return { service: new AlwaysOnRunHistoryService(baseDeps), historyRoot };
}

test("AlwaysOnRunHistoryService appends, merges, filters and limits JSONL records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service, historyRoot } = createService(root);

  assert.equal(await service.appendRunEvent("/project", { runId: "bad", kind: "plan", status: "done" }), null);
  const first = await service.appendRunEvent("/project", {
    runId: "run-1",
    kind: "plan",
    sourceId: "source-1",
    title: "  Initial title ",
    status: "running",
    timestamp: "2026-08-24T00:00:00Z",
    sessionId: "session-1",
    relativeTranscriptPath: "session-1.jsonl",
    metadata: { taskId: "task-1" },
    output: "started",
  });
  assert.equal(first?.title, "Initial title");

  await service.appendRunEvent("/project", {
    runId: "run-1",
    kind: "plan",
    sourceId: "source-1",
    title: "Finished title",
    status: "completed",
    timestamp: "2026-08-24T00:01:00Z",
    finishedAt: "2026-08-24T00:01:00Z",
    metadata: { result: "ok" },
    output: "finished",
    error: "minor warning",
  });
  await service.appendRunEvent("/project", {
    runId: "unknown-run",
    kind: "cron",
    sourceId: "cron-source",
    status: "unknown",
    timestamp: "2026-08-24T00:02:00Z",
  });
  await appendFile(join(historyRoot, "run-history.jsonl"), "not-json\n{}\n", "utf8");

  const history = await service.getRunHistory("/project", { limit: 1 });
  assert.equal(history.runs.length, 1);
  assert.deepEqual(history.runs[0], {
    runId: "run-1",
    title: "Finished title",
    kind: "plan",
    status: "completed",
    startedAt: "2026-08-24T00:00:00.000Z",
    sourceId: "source-1",
    session: {
      sessionId: "session-1",
      parentSessionId: undefined,
      relativeTranscriptPath: "session-1.jsonl",
    },
  });
  const persisted = await readFile(join(historyRoot, "run-history.jsonl"), "utf8");
  assert.match(persisted, /run-1/);
});

test("AlwaysOnRunHistoryService detail prefers log files and exposes merged metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-history-detail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historyRoot = join(root, "always-on");
  const service = new AlwaysOnRunHistoryService({
    paths: { getAlwaysOnRoot: () => historyRoot },
    logs: {
      getAlwaysOnRunLog: async (_projectRoot, runId) => ({
        content: runId === "run-log" ? "from log file" : "",
        truncated: runId === "run-log",
        updatedAt: "2026-08-24T00:03:00Z",
        size: 13,
      }),
    },
    sessionMessages: {
      getSessionMessages: async () => ({
        messages: [
          { timestamp: "2026-08-24T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
          { type: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
      }),
    },
  });

  await service.appendRunEvent("/project", {
    runId: "run-log",
    kind: "cron",
    sourceId: "cron-source",
    title: "Cron run",
    status: "failed",
    timestamp: "2026-08-24T00:00:00Z",
    sessionId: "session-log",
    relativeTranscriptPath: "session-log.jsonl",
    metadata: { taskId: "task-1" },
    error: "history error",
  });
  await service.appendRunEvent("/project", {
    runId: "run-session",
    kind: "plan",
    sourceId: "plan-source",
    title: "Session run",
    status: "completed",
    timestamp: "2026-08-24T00:00:00Z",
    sessionId: "session-session",
    relativeTranscriptPath: "session-session.jsonl",
  });

  const logDetail = await service.getRunHistoryDetail("/project", "run-log", { projectName: "project" });
  assert.equal(logDetail.outputLog, "from log file");
  assert.equal(logDetail.metadata.logSource, "log-file");
  assert.equal(logDetail.metadata.logTruncated, true);
  assert.equal(logDetail.metadata.taskId, "task-1");

  const sessionDetail = await service.getRunHistoryDetail("/project", "run-session", { projectName: "project" });
  assert.match(sessionDetail.outputLog, /hello/);
  assert.match(sessionDetail.outputLog, /answer/);
  assert.equal(sessionDetail.metadata.logSource, "session");

  await assert.rejects(
    () => service.getRunHistoryDetail("/project", "missing"),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
});

test("AlwaysOnRunHistoryService falls back to history output when session lookup fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-history-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { service } = createService(root, {
    getSessionMessages: async () => { throw new Error("session unavailable"); },
  });
  await service.appendRunEvent("/project", {
    runId: "run-fallback",
    kind: "plan",
    sourceId: "source",
    status: "completed",
    timestamp: "2026-08-24T00:00:00Z",
    sessionId: "session",
    relativeTranscriptPath: "session.jsonl",
    output: "history output",
  });

  const detail = await service.getRunHistoryDetail("/project", "run-fallback", { projectName: "project" });
  assert.equal(detail.outputLog, "history output");
  assert.equal(detail.metadata.logSource, "history");
});

test("AlwaysOnRunHistoryService recovers background sessions from task notifications and nearby transcripts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-history-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const projectDir = join(root, ".pilotdeck", "projects", "project-name");
  const parentDir = join(projectDir, "parent-session", "subagents");
  await mkdir(parentDir, { recursive: true });
  const taskOutput = join(parentDir, "agent-cron-task.output");
  const taskTranscript = join(parentDir, "agent-cron-task.jsonl");
  await writeFile(taskOutput, "task output\n", "utf8");
  await writeFile(taskTranscript, JSON.stringify({ timestamp: "2026-08-24T00:00:03Z" }) + "\n", "utf8");
  await writeFile(join(projectDir, "parent-session.jsonl"), JSON.stringify({
    sessionId: "parent-session",
    content: `<task-notification><task-id>task-1</task-id><output-file>${taskOutput}</output-file><status>completed</status><summary>source-1 done</summary></task-notification>`,
  }) + "\n", "utf8");

  const { service } = createService(root);
  await service.appendRunEvent("/project", {
    runId: "run-task",
    kind: "cron",
    sourceId: "source-1",
    status: "completed",
    timestamp: "2026-08-24T00:00:00Z",
    parentSessionId: "parent-session",
    metadata: { taskId: "task-1" },
  });
  const recovered = await service.getRunHistory("/project", { projectName: "project-name" });
  assert.equal(recovered.runs[0]?.session.parentSessionId, "parent-session");
  assert.equal(recovered.runs[0]?.session.sessionId, "background-parent-session-agent-cron-task");
  assert.equal(recovered.runs[0]?.session.relativeTranscriptPath, "parent-session/subagents/agent-cron-task.jsonl");

  await service.appendRunEvent("/project", {
    runId: "run-nearby",
    kind: "plan",
    sourceId: "source-nearby",
    status: "completed",
    timestamp: "2026-08-24T00:00:00Z",
    startedAt: "2026-08-24T00:00:00Z",
    parentSessionId: "nearby-parent",
    metadata: { originSessionId: "nearby-parent", transcriptKey: "cron-nearby" },
  });
  const nearbyDir = join(projectDir, "nearby-parent", "subagents");
  await mkdir(nearbyDir, { recursive: true });
  await writeFile(join(nearbyDir, "agent-cron-nearby.jsonl"), JSON.stringify({ timestamp: "2026-08-24T00:01:00Z" }) + "\n", "utf8");
  const nearby = await service.getRunHistory("/project", { projectName: "project-name" });
  const nearbyEntry = nearby.runs.find((entry) => entry.runId === "run-nearby");
  assert.equal(nearbyEntry?.session.sessionId, "background-nearby-parent-agent-cron-nearby");
  assert.equal(nearbyEntry?.session.relativeTranscriptPath, "nearby-parent/subagents/agent-cron-nearby.jsonl");
});
