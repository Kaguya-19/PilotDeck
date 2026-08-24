import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { UploadStore } from "../../src/gateway/dialog/UploadStore.js";

test("upload store persists, verifies, and resolves streamed attachments", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  const created = await store.create(project, [{ clientFileId: "one", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  const duplicate = await store.create(project, [{ clientFileId: "one", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  assert.equal(duplicate.uploadId, created.uploadId);
  await store.writePart(created.uploadId, "one", Readable.from([Buffer.from("hello")]));
  const completed = await store.complete(created.uploadId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.uploadedBytes, 5);
  const attachments = await store.verifyAttachment(created.uploadId, project);
  assert.equal(await readFile(attachments[0]!.path, "utf8"), "hello");
});

test("upload store rejects unsafe manifests and size mismatches", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-invalid-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  await assert.rejects(
    store.create(project, [{ clientFileId: "bad", name: "bad", relativePath: "../bad", size: 1 }]),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_MANIFEST_INVALID",
  );
  const created = await store.create(project, [{ clientFileId: "bad-size", name: "bad", relativePath: "bad", size: 3 }]);
  await assert.rejects(
    store.writePart(created.uploadId, "bad-size", Readable.from([Buffer.from("too long")])),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_INTEGRITY_MISMATCH",
  );
  assert.equal((await store.get(created.uploadId)).status, "failed");
});

test("upload creation enforces the per-project concurrency limit atomically", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-concurrency-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({
    resolveProject: async () => project,
    listProjects: async () => [project],
    maxConcurrentPerProject: 1,
  });
  const results = await Promise.allSettled([
    store.create(project, [{ clientFileId: "one", name: "one", relativePath: "one", size: 1 }]),
    store.create(project, [{ clientFileId: "two", name: "two", relativePath: "two", size: 1 }]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "UPLOAD_CONCURRENCY_LIMIT");
});

test("attachment verification returns stable project and expiry errors", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-owner-"));
  const otherProject = await mkdtemp(join(tmpdir(), "pilotdeck-upload-other-"));
  t.after(() => Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(otherProject, { recursive: true, force: true }),
  ]));
  let now = new Date("2026-08-11T00:00:00.000Z");
  const store = new UploadStore({
    resolveProject: async (projectKey) => projectKey,
    listProjects: async () => [project, otherProject],
    now: () => now,
    retentionMs: 1_000,
  });
  const created = await store.create(project, [
    { clientFileId: "one", name: "one.txt", relativePath: "one.txt", size: 5 },
  ]);
  await store.writePart(created.uploadId, "one", Readable.from([Buffer.from("hello")]));
  await store.complete(created.uploadId);

  await assert.rejects(
    store.verifyAttachment(created.uploadId, otherProject),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_PATH_FORBIDDEN",
  );

  now = new Date("2026-08-11T00:00:02.000Z");
  await assert.rejects(
    store.verifyAttachment(created.uploadId, project),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_EXPIRED",
  );
});

test("upload store handles incomplete completion, cancellation, subscriptions and expiry cleanup", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-lifecycle-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  let now = new Date("2026-08-11T00:00:00.000Z");
  const store = new UploadStore({
    resolveProject: async () => project,
    listProjects: async () => [project],
    now: () => now,
    retentionMs: 1_000,
  });
  const failedUpload = await store.create(project, [{ clientFileId: "one", name: "one", relativePath: "one", size: 1 }]);
  const events: string[] = [];
  const unsubscribeFailed = store.subscribe(failedUpload.uploadId, (record) => events.push(record.status));
  await assert.rejects(
    store.complete(failedUpload.uploadId),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_MANIFEST_MISMATCH",
  );
  unsubscribeFailed();
  assert.equal((await store.get(failedUpload.uploadId)).status, "failed");

  const cancellable = await store.create(project, [{ clientFileId: "cancel", name: "cancel", relativePath: "cancel", size: 1 }]);
  const unsubscribe = store.subscribe(cancellable.uploadId, (record) => events.push(record.status));
  assert.equal((await store.cancel(cancellable.uploadId)).status, "cancelled");
  unsubscribe();
  assert.deepEqual(events, ["failed", "cancelled"]);
  assert.equal((await store.cancel(cancellable.uploadId)).status, "cancelled");

  const expiring = await store.create(project, [{ clientFileId: "two", name: "two", relativePath: "two", size: 0 }]);
  now = new Date("2026-08-11T00:00:02.000Z");
  assert.equal(await store.cleanupExpired(), 3);
  await assert.rejects(store.get(expiring.uploadId), (error: unknown) => (error as { code?: string }).code === "UPLOAD_NOT_FOUND");
});

test("upload store rejects tampered files and unknown attachment selections", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-tamper-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  const created = await store.create(project, [{ clientFileId: "one", name: "one", relativePath: "one", size: 5 }]);
  await store.writePart(created.uploadId, "one", Readable.from([Buffer.from("hello")]));
  await store.complete(created.uploadId);
  await assert.rejects(
    store.verifyAttachment(created.uploadId, project, ["missing"]),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
  const attachment = (await store.verifyAttachment(created.uploadId, project))[0]!;
  await writeFile(attachment.path, "changed");
  await assert.rejects(
    store.verifyAttachment(created.uploadId, project),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_TAMPERED",
  );
});

test("upload store validates SHA manifests and filesystem-safe limits", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-validation-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({
    resolveProject: async () => project,
    listProjects: async () => [project],
    maxFileBytes: 3,
    maxTaskBytes: 3,
    maxFiles: 1,
  });
  const invalidManifests: Array<{ clientFileId: string; name: string; relativePath: string; size: number; sha256?: string }> = [
    { clientFileId: "same", name: "a", relativePath: "a", size: 0, sha256: "bad" },
    { clientFileId: "bad", name: "a", relativePath: "../a", size: 0 },
  ];
  await assert.rejects(store.create(project, invalidManifests), /files must contain 1/);
  await assert.rejects(
    store.create(project, [{ clientFileId: "same", name: "a", relativePath: "a", size: 0 }, { clientFileId: "same", name: "b", relativePath: "b", size: 0 }]),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_MANIFEST_INVALID",
  );
  await assert.rejects(
    store.create(project, [{ clientFileId: "large", name: "a", relativePath: "a", size: 4 }]),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_FILE_TOO_LARGE",
  );
  const created = await store.create(project, [{ clientFileId: "sha", name: "a", relativePath: "a", size: 3, sha256: "0".repeat(64) }]);
  await assert.rejects(
    store.writePart(created.uploadId, "sha", Readable.from([Buffer.from("abc")])),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_INTEGRITY_MISMATCH",
  );
  assert.equal((await store.get(created.uploadId)).status, "failed");
  await assert.rejects(store.get("../unsafe"), (error: unknown) => (error as { code?: string }).code === "UPLOAD_NOT_FOUND");
});
