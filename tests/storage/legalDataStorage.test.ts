import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContentAddressedWorkspaceSnapshotRecorder,
  type InvocationLogRecord,
  JsonlInvocationLogSink,
  resolveLegalStorageConfig,
} from "../../src/storage/index.js";

test("legal storage configuration is opt-in and does not define workspace identity", () => {
  assert.equal(resolveLegalStorageConfig({}), undefined);
  const config = resolveLegalStorageConfig({
    PILOTDECK_LEGAL_STORAGE_ROOT: "/tmp/legal",
    PILOTDECK_LEGAL_DATABASE_URL: "postgres://private",
  });
  assert.equal(config?.snapshotRoot, "/tmp/legal");
  assert.equal(config?.database?.url, "postgres://private");
});

test("content-addressed snapshots reuse identical file objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-"));
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-"));
  await writeFile(join(workspace, "a.txt"), "same");
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: root, storageConfigVersion: "test" });

  const first = await recorder.capturePreUser({ workspaceId: "w1", sessionId: "s1", turnId: "t1", runId: "r1", workspaceDir: workspace });
  const second = await recorder.capturePostAgent({ workspaceId: "w1", sessionId: "s1", turnId: "t2", runId: "r2", workspaceDir: workspace, failureReason: "error" });
  assert.equal(first.state, "committed");
  assert.equal(second.state, "committed");

  const objects = await readdir(join(root, "objects", "md5", "51", "03"));
  assert.equal(objects.length, 1);
  const manifest = JSON.parse(await readFile(second.manifestPath!, "utf8")) as { entries: Array<{ md5?: string; objectKey?: string }> };
  assert.equal(manifest.entries[0].md5, "51037a4a37730f52c8732586d3aaa316");
  assert.equal(manifest.entries[0].objectKey, "objects/md5/51/03/51037a4a37730f52c8732586d3aaa316");
  assert.equal(await readFile(join(root, manifest.entries[0].objectKey!), "utf8"), "same");
});

test("post-agent snapshots are explicitly marked as abnormal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-"));
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-"));
  await writeFile(join(workspace, "result.txt"), "partial result");
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: root });

  const result = await recorder.capturePostAgent({
    workspaceId: "w1",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    failureKind: "timeout",
    failureReason: "turn timeout",
  });

  assert.equal(result.state, "committed");
  assert.equal(result.abnormal, true);
  assert.equal(result.roundStatus, "failed");
  assert.equal(result.failureKind, "timeout");
  const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8")) as {
    abnormal: boolean;
    roundStatus: string;
    failureKind: string;
    failureReason: string;
  };
  assert.equal(manifest.abnormal, true);
  assert.equal(manifest.roundStatus, "failed");
  assert.equal(manifest.failureKind, "timeout");
  assert.equal(manifest.failureReason, "turn timeout");
});

test("object storage failures create a failure marker and never commit a manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-"));
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-"));
  await writeFile(join(workspace, "a.txt"), "same");
  const digest = "51037a4a37730f52c8732586d3aaa316";
  await mkdir(join(root, "objects", "md5", digest.slice(0, 2), digest.slice(2, 4), digest), { recursive: true });
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: root });

  const result = await recorder.capturePostAgent({
    workspaceId: "w1",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    failureKind: "agent_error",
    failureReason: "agent failed",
  });

  assert.equal(result.state, "failed");
  assert.equal(result.abnormal, true);
  assert.ok(result.failureMarkerPath);
  const partition = join(root, "workspaces", "w1", "sessions", "s1", "snapshots", result.snapshotId);
  const files = await readdir(partition);
  assert.ok(files.includes("_FAILED.json"));
  assert.equal(files.includes("_COMMITTED"), false);
  assert.equal(files.includes("manifest.json"), false);
  const marker = JSON.parse(await readFile(result.failureMarkerPath!, "utf8")) as {
    state: string;
    abnormal: boolean;
    failureKind: string;
  };
  assert.equal(marker.state, "failed");
  assert.equal(marker.abnormal, true);
  assert.equal(marker.failureKind, "agent_error");

  const repeated = await recorder.capturePostAgent({
    workspaceId: "w1",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    failureKind: "agent_error",
    failureReason: "agent failed",
  });
  assert.equal(repeated.snapshotId, result.snapshotId);
});

test("a workspace that has not unwound is marked failed without scanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-"));
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-"));
  await writeFile(join(workspace, "still-changing.txt"), "partial");
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: root });

  const result = await recorder.capturePostAgent({
    workspaceId: "w1",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    workspaceStable: false,
    failureKind: "timeout",
    failureReason: "workspace_not_quiescent",
  });

  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /did not finish unwinding/);
  assert.ok(result.failureMarkerPath);
  const partition = join(root, "workspaces", "w1", "sessions", "s1", "snapshots", result.snapshotId);
  const files = await readdir(partition);
  assert.equal(files.includes("manifest.json"), false);
  assert.equal(files.includes("_COMMITTED"), false);
});

test("JSONL invocation sink preserves raw payload fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-llm-"));
  const sink = new JsonlInvocationLogSink({ root });
  const record: InvocationLogRecord = {
    workspaceId: "w1",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    logicalCallId: "l1",
    caller: "agent",
    requestLogId: "q1",
    requestId: "q2",
    attempt: 1,
    provider: "p",
    protocol: "openai",
    model: "m",
    stream: false,
    requestBody: '{"thinking":{"signature":"+/="}}',
    responseBody: '{"ok":true}',
    requestBytes: 34,
    responseBytes: 11,
    outcome: "success",
    responseComplete: true,
    startedAt: "2026-09-03T00:00:00.000Z",
    completedAt: "2026-09-03T00:00:01.000Z",
  };
  await sink.append(record);
  const path = join(root, "workspaces", "w1", "sessions", "s1", "llm", "invocations.jsonl");
  const parsed = JSON.parse((await readFile(path, "utf8")).trim()) as InvocationLogRecord;
  assert.equal(parsed.requestBody, record.requestBody);
  assert.equal(parsed.responseBody, record.responseBody);
});
