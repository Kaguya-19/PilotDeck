import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createBackup,
  FileHistoryStore,
  getBackupFileName,
  parseBackupVersion,
  restoreBackup,
  type FileHistorySnapshotRecordedEntry,
} from "../../src/session/filesystem/index.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
}

test("backup helpers handle missing, directories, size limits, modes and restore outcomes", async (t) => {
  const root = await tempDir("pilotdeck-file-backup-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDir = join(root, "backups");
  const file = join(root, "nested", "file.txt");
  const now = () => new Date("2026-01-01T00:00:00.000Z");

  const missing = await createBackup({ filePath: file, version: 1, backupDir, now });
  assert.equal(missing.backup.backupFileName, null);
  const directory = await createBackup({ filePath: root, version: 1, backupDir, now });
  assert.equal(directory.backup.backupFileName, null);

  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, "12345", "utf8");
  const oversize = await createBackup({ filePath: file, version: 1, backupDir, maxFileBytes: 2, now });
  assert.equal(oversize.oversize, true);
  assert.equal(oversize.backup.backupFileName, null);

  await chmod(file, 0o640);
  const created = await createBackup({ filePath: file, version: 2, backupDir, now });
  assert.equal(created.backup.backupFileName, getBackupFileName(file, 2));
  assert.equal(parseBackupVersion(created.backup.backupFileName!), 2);
  assert.equal((await stat(join(backupDir, created.backup.backupFileName!))).isFile(), true);

  // Exercise the production default clock as well as the injected test clock.
  const defaultClockBackup = await createBackup({ filePath: file, version: 3, backupDir });
  assert.equal(defaultClockBackup.backup.version, 3);

  await writeFile(file, "changed", "utf8");
  assert.deepEqual(await restoreBackup({ filePath: file, backup: created.backup, backupDir }), { outcome: "restored" });
  assert.equal(await readFile(file, "utf8"), "12345");
  assert.deepEqual(await restoreBackup({ filePath: join(root, "gone.txt"), backup: { ...created.backup, backupFileName: null }, backupDir }), { outcome: "deleted" });
  await rm(join(backupDir, created.backup.backupFileName!), { force: true });
  assert.deepEqual(await restoreBackup({ filePath: file, backup: created.backup, backupDir }), { outcome: "missing" });
});

test("FileHistoryStore captures idempotent edits, mtime versions, rewind, diff and transcript replay", async (t) => {
  const root = await tempDir("pilotdeck-file-history-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "file.txt");
  const missingFile = join(root, "created-later.txt");
  const backupDir = join(root, "backups");
  const recorded: Array<{ entry: FileHistorySnapshotRecordedEntry; kind: "create" | "update" }> = [];
  await writeFile(file, "one\ntwo\n", "utf8");
  const times = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:01:00.000Z"),
    new Date("2026-01-01T00:02:00.000Z"),
  ];
  let clock = 0;
  const store = new FileHistoryStore({
    backupDir,
    now: () => times[Math.min(clock++, times.length - 1)]!,
    onSnapshotRecorded: (entry, kind) => recorded.push({ entry, kind }),
  });

  await store.trackEdit(file, "m1");
  await nextTick();
  const first = store.getState().snapshots[0]!.trackedFileBackups[file]!;
  await store.trackEdit(file, "m1");
  assert.equal(store.getState().snapshots.length, 1);
  assert.equal(store.getState().snapshots[0]!.trackedFileBackups[file]!.backupFileName, first.backupFileName);

  await writeFile(file, "one\ntwo\nthree\n", "utf8");
  await utimes(file, new Date("2026-01-01T00:03:00.000Z"), new Date("2026-01-01T00:03:00.000Z"));
  await store.makeSnapshot("m2");
  const second = store.getState().snapshots.find((snapshot) => snapshot.messageId === "m2")!.trackedFileBackups[file]!;
  assert.equal(second.version, 2);
  assert.deepEqual(await store.getDiffStats("m2"), { filesChanged: 0, insertions: 0, deletions: 0 });

  await writeFile(file, "rewritten\n", "utf8");
  const diff = await store.getDiffStats("m2");
  assert.equal(diff.filesChanged, 1);
  assert.ok(diff.insertions > 0 && diff.deletions > 0);
  assert.deepEqual(await store.rewind("m2"), { filesChanged: [resolve(file)], missing: [] });
  assert.equal(await readFile(file, "utf8"), "one\ntwo\nthree\n");
  await assert.rejects(store.rewind("unknown"), /No snapshot/);

  await store.trackEdit(missingFile, "missing");
  await nextTick();
  await writeFile(missingFile, "created", "utf8");
  const rewindMissing = await store.rewind("missing");
  assert.deepEqual(rewindMissing, { filesChanged: [resolve(missingFile)], missing: [] });
  assert.equal(await stat(missingFile).then(() => true, () => false), false);

  assert.ok(recorded.some((item) => item.kind === "create"));
  assert.ok(recorded.some((item) => item.kind === "update"));
  const replay = new FileHistoryStore({ backupDir });
  replay.replayFromTranscript([recorded[0]!.entry, recorded[0]!.entry]);
  assert.equal(replay.getState().snapshots.length, 1);
  assert.equal(replay.getState().trackedFiles.has(resolve(file)), true);
});

test("FileHistoryStore warns on oversize/missing backups and evicts unreferenced versions", async (t) => {
  const root = await tempDir("pilotdeck-file-history-evict-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "file.txt");
  const backupDir = join(root, "backups");
  const warnings: string[] = [];
  await writeFile(file, "a", "utf8");
  const store = new FileHistoryStore({ backupDir, maxSnapshots: 1, maxFileBytes: 0, warn: (message) => warnings.push(message) });
  await store.trackEdit(file, "oversize");
  assert.match(warnings[0]!, /skipping backup/);

  const normal = new FileHistoryStore({ backupDir, maxSnapshots: 1, warn: (message) => warnings.push(message) });
  await normal.trackEdit(file, "m1");
  await nextTick();
  const firstBackup = normal.getState().snapshots[0]!.trackedFileBackups[resolve(file)]!.backupFileName!;
  await writeFile(file, "b", "utf8");
  await utimes(file, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));
  await normal.makeSnapshot("m2");
  assert.equal(normal.getState().snapshots.length, 1);
  assert.equal((await readdir(backupDir)).includes(firstBackup), false);

  const missingBackup = normal.getState().snapshots[0]!.trackedFileBackups[resolve(file)]!;
  await rm(join(backupDir, missingBackup.backupFileName!), { force: true });
  const result = await normal.rewind("m2");
  assert.deepEqual(result, { filesChanged: [], missing: [resolve(file)] });
  assert.ok(warnings.some((message) => message.includes("is missing on disk")));
});

test("FileHistoryStore reports created, deleted, and unchanged files in diff stats", async (t) => {
  const root = await tempDir("pilotdeck-file-history-diff-boundaries-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDir = join(root, "backups");
  const createdAfterSnapshot = join(root, "created-after.txt");
  const deletedAfterSnapshot = join(root, "deleted-after.txt");
  const untouchedMissing = join(root, "untouched-missing.txt");
  await writeFile(deletedAfterSnapshot, "before\nsecond\n", "utf8");

  const store = new FileHistoryStore({ backupDir });
  await store.trackEdit(createdAfterSnapshot, "diff");
  await store.trackEdit(deletedAfterSnapshot, "diff");
  await store.trackEdit(untouchedMissing, "diff");

  await writeFile(createdAfterSnapshot, "new\nsecond\n", "utf8");
  await rm(deletedAfterSnapshot);

  assert.deepEqual(await store.getDiffStats("diff"), {
    filesChanged: 2,
    insertions: 3,
    deletions: 3,
  });
});

test("FileHistoryStore keeps an unchanged backup stable and does not evict shared references", async (t) => {
  const root = await tempDir("pilotdeck-file-history-shared-backup-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "file.txt");
  const backupDir = join(root, "backups");
  await writeFile(file, "stable\n", "utf8");

  const store = new FileHistoryStore({ backupDir, maxSnapshots: 1 });
  await store.trackEdit(file, "first");
  await store.makeSnapshot("first");
  const backup = store.getState().snapshots[0]!.trackedFileBackups[resolve(file)]!.backupFileName!;

  // Re-finalizing without an mtime change carries the previous backup forward.
  await store.makeSnapshot("second");
  assert.equal(store.getState().snapshots.at(-1)!.trackedFileBackups[resolve(file)]!.backupFileName, backup);
  assert.equal((await stat(join(backupDir, backup))).isFile(), true);
  assert.equal(store.getState().snapshots.length, 1);
});

test("FileHistoryStore warns on non-ENOENT eviction failures and continues mutations", async (t) => {
  const root = await tempDir("pilotdeck-file-history-eviction-error-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "file.txt");
  const backupDir = join(root, "backups");
  const warnings: string[] = [];
  await writeFile(file, "one\n", "utf8");

  const store = new FileHistoryStore({ backupDir, maxSnapshots: 1, warn: (message) => warnings.push(message) });
  await store.trackEdit(file, "first");
  const firstBackup = store.getState().snapshots[0]!.trackedFileBackups[resolve(file)]!.backupFileName!;
  await rm(join(backupDir, firstBackup));
  await mkdir(join(backupDir, firstBackup), { recursive: true });

  await writeFile(file, "two\n", "utf8");
  await utimes(file, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));
  await store.makeSnapshot("second");

  assert.equal(store.getState().snapshots.length, 1);
  assert.ok(warnings.some((message) => message.includes("failed to evict")));
  await rm(join(backupDir, firstBackup), { recursive: true, force: true });
  await store.trackEdit(file, "third");
  assert.equal(store.getState().snapshots.length, 2);
});
