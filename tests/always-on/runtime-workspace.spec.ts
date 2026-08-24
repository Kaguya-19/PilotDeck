import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { defaultAlwaysOnConfig } from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryStateStore } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../../src/always-on/storage/WorkCycleStore.js";
import { ChannelLeaseRegistry } from "../../src/always-on/runtime/ChannelLeaseRegistry.js";
import { DiscoveryScheduler } from "../../src/always-on/runtime/DiscoveryScheduler.js";
import {
  acquireDiscoveryLock,
  releaseDiscoveryLock,
} from "../../src/always-on/runtime/DiscoveryFire.js";
import { AlwaysOnError } from "../../src/always-on/protocol/errors.js";
import {
  applyWorktreeToProject,
  disposeWorkspace,
  generateWorkspaceDiff,
} from "../../src/always-on/workspace/WorkspaceApply.js";
import { GitWorktreeProvider } from "../../src/always-on/workspace/GitWorktreeProvider.js";
import { SnapshotCopyProvider } from "../../src/always-on/workspace/SnapshotCopyProvider.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";
import type { WorkspaceProvider } from "../../src/always-on/workspace/WorkspaceProvider.js";

const execFile = promisify(execFileCallback);

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function initRepo(root: string): Promise<void> {
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "pilotdeck-tests@example.invalid");
  await git(root, "config", "user.name", "PilotDeck Tests");
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "initial");
}

function alwaysOnConfig(projectKey: string) {
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.dormancy.enabled = false;
  config.projects[projectKey] = { enabled: true };
  return config;
}

test("WorkspaceProviderRegistry orders providers, skips failures and reports unavailable", async () => {
  const calls: string[] = [];
  const provider = (id: "git-worktree" | "snapshot-copy", priority: number, applicable: boolean): WorkspaceProvider => ({
    id,
    priority,
    isApplicable: async () => {
      calls.push(id);
      if (id === "git-worktree") throw new Error("probe failed");
      return applicable;
    },
    prepare: async (input) => ({ runId: input.runId, projectKey: input.projectRoot, strategy: id, cwd: input.projectRoot, metadata: {} }),
    publish: async () => ({}),
    dispose: async () => undefined,
  });
  const registry = new WorkspaceProviderRegistry();
  registry.add(provider("snapshot-copy", 4, true));
  registry.add(provider("git-worktree", 1, false));
  assert.deepEqual(registry.list().map((item) => item.id), ["git-worktree", "snapshot-copy"]);
  assert.equal((await registry.resolve("/tmp/project")).id, "snapshot-copy");
  assert.deepEqual(calls, ["git-worktree", "snapshot-copy"]);
  assert.equal(registry.findById("snapshot-copy")?.id, "snapshot-copy");
  const prepared = await registry.prepare({ projectRoot: "/tmp/project", runId: "run", planTitle: "plan" });
  assert.equal(prepared.provider.id, "snapshot-copy");
  assert.equal(prepared.handle.cwd, "/tmp/project");
  const empty = new WorkspaceProviderRegistry();
  await assert.rejects(empty.resolve("/tmp/project"), (error: unknown) => error instanceof AlwaysOnError && error.code === "workspace_unavailable");
});

test("SnapshotCopyProvider copies files, excludes managed directories, enforces size and disposes", async (t) => {
  const root = await tempDir("pilotdeck-snapshot-provider-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const baseDir = join(root, "snapshots");
  await mkdir(join(source, ".git"), { recursive: true });
  await mkdir(join(source, "node_modules"), { recursive: true });
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "main.txt"), "hello", "utf8");
  await writeFile(join(source, ".git", "secret"), "ignored", "utf8");
  await writeFile(join(source, "node_modules", "ignored"), "ignored", "utf8");
  const provider = new SnapshotCopyProvider({ baseDir, maxBytes: 1024 * 1024 });
  assert.equal(await provider.isApplicable(source), true);
  assert.equal(await provider.isApplicable(join(root, "missing")), false);
  const handle = await provider.prepare({ projectRoot: source, runId: "run-1", planTitle: "Plan" });
  assert.equal(handle.strategy, "snapshot-copy");
  assert.equal(await readFile(join(handle.cwd, "src", "main.txt"), "utf8"), "hello");
  assert.equal(await stat(join(handle.cwd, ".git")).then(() => true, () => false), false);
  assert.equal(await stat(join(handle.cwd, "node_modules")).then(() => true, () => false), false);
  assert.deepEqual(await provider.publish(handle), { diff: `snapshot at ${handle.cwd}` });
  await provider.dispose(handle, { keep: true });
  assert.equal(await stat(handle.cwd).then(() => true, () => false), true);
  await provider.dispose(handle, { keep: false });
  assert.equal(await stat(handle.cwd).then(() => true, () => false), false);
  await assert.rejects(new SnapshotCopyProvider({ baseDir, maxBytes: 1 }).prepare({ projectRoot: source, runId: "too-big", planTitle: "Plan" }), /exceeds maxBytes/);
});

test("SnapshotCopyProvider uses the platform copy fast path and prunes configured entries", async (t) => {
  const root = await tempDir("pilotdeck-snapshot-fast-path-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const baseDir = join(root, "snapshots");
  const binDir = join(root, "bin");
  await mkdir(join(source, "managed"), { recursive: true });
  await writeFile(join(source, "kept.txt"), "kept\n", "utf8");
  await writeFile(join(source, "managed", "removed.txt"), "removed\n", "utf8");
  await mkdir(binDir, { recursive: true });

  // The provider invokes cp with either macOS clonefile or Linux reflink flags.
  // This controlled executable makes that branch deterministic on both hosts.
  const fakeCp = join(binDir, "cp");
  await writeFile(fakeCp, "#!/bin/sh\nset -eu\nsrc=\"\"\ntarget=\"\"\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    -c|--reflink=auto|-R) ;;\n    *) if [ -z \"$src\" ]; then src=\"$arg\"; else target=\"$arg\"; fi ;;\n  esac\ndone\n/bin/cp -R \"$src\" \"$target\"\n", "utf8");
  await chmod(fakeCp, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const provider = new SnapshotCopyProvider({ baseDir, maxBytes: 1024 * 1024, ignorePaths: ["managed"] });
  const handle = await provider.prepare({ projectRoot: source, runId: "fast", planTitle: "Plan" });
  assert.ok(handle.metadata.copyStrategy === "clonefile" || handle.metadata.copyStrategy === "reflink");
  assert.equal(await readFile(join(handle.cwd, "kept.txt"), "utf8"), "kept\n");
  assert.equal(await stat(join(handle.cwd, "managed")).then(() => true, () => false), false);
  await provider.dispose(handle, { keep: false });
});

test("SnapshotCopyProvider falls back when the size command returns malformed output", async (t) => {
  const root = await tempDir("pilotdeck-snapshot-invalid-size-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const baseDir = join(root, "snapshots");
  const binDir = join(root, "bin");
  await mkdir(source, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(source, "file.txt"), "content\n", "utf8");
  const fakeDu = join(binDir, "du");
  await writeFile(fakeDu, "#!/bin/sh\nprintf 'not-a-size\\n'\n", "utf8");
  await chmod(fakeDu, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const provider = new SnapshotCopyProvider({ baseDir, maxBytes: 1 });
  const handle = await provider.prepare({ projectRoot: source, runId: "invalid-size", planTitle: "Plan" });
  assert.equal(await readFile(join(handle.cwd, "file.txt"), "utf8"), "content\n");
  await provider.dispose(handle, { keep: false });
});

test("SnapshotCopyProvider falls back to fs.cp when the platform fast path fails", async (t) => {
  const root = await tempDir("pilotdeck-snapshot-copy-fallback-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const baseDir = join(root, "snapshots");
  const binDir = join(root, "bin");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, ".pilotdeck"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(source, "src", "main.txt"), "fallback\n", "utf8");
  await writeFile(join(source, ".pilotdeck", "ignored.txt"), "ignored\n", "utf8");
  const failingCp = join(binDir, "cp");
  await writeFile(failingCp, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(failingCp, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const provider = new SnapshotCopyProvider({ baseDir, maxBytes: 1024 * 1024 });
  const handle = await provider.prepare({ projectRoot: source, runId: "fallback", planTitle: "Fallback" });
  assert.equal(handle.metadata.copyStrategy, "fs.cp");
  assert.equal(await readFile(join(handle.cwd, "src", "main.txt"), "utf8"), "fallback\n");
  assert.equal(await stat(join(handle.cwd, ".pilotdeck")).then(() => true, () => false), false);
  await provider.dispose(handle, { keep: false });
  assert.equal(await stat(handle.cwd).then(() => true, () => false), false);
});

test("SnapshotCopyProvider uses the Windows size estimator with a controlled PowerShell", async (t) => {
  const root = await tempDir("pilotdeck-snapshot-windows-size-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const baseDir = join(root, "snapshots");
  const binDir = join(root, "bin");
  await mkdir(source, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(source, "file.txt"), "windows\n", "utf8");
  const powershell = join(binDir, "powershell");
  await writeFile(powershell, "#!/bin/sh\nprintf '7\\n'\n", "utf8");
  await chmod(powershell, 0o755);

  const previousPath = process.env.PATH;
  const previousPlatform = process.platform;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", { value: previousPlatform, configurable: true });
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const provider = new SnapshotCopyProvider({ baseDir, maxBytes: 1024 });
  const handle = await provider.prepare({ projectRoot: source, runId: "windows-size", planTitle: "Plan" });
  assert.equal(handle.metadata.baseSize, "7");
  assert.equal(await readFile(join(handle.cwd, "file.txt"), "utf8"), "windows\n");
  await provider.dispose(handle, { keep: false });
});

test("GitWorktreeProvider creates, checkpoints, publishes and cleans local worktrees", async (t) => {
  const root = await tempDir("pilotdeck-git-provider-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const baseDir = join(root, "worktrees");
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const created: string[] = [];
  const removed: string[] = [];
  const provider = new GitWorktreeProvider({ baseDir, onWorktreeCreated: (runId, cwd) => created.push(`${runId}:${cwd}`), onWorktreeRemoved: (cwd) => removed.push(cwd) });
  assert.equal(await provider.isApplicable(repo), true);
  assert.equal(await provider.isApplicable(join(root, "not-a-repo")), false);
  const handle = await provider.prepare({ projectRoot: repo, runId: "run-1", planTitle: "Plan" });
  assert.equal(handle.strategy, "git-worktree");
  await writeFile(join(handle.cwd, "README.md"), "changed\n", "utf8");
  const published = await provider.publish(handle);
  assert.match(published.diff ?? "", /changed/);
  assert.ok(created[0]?.startsWith("run-1:"));
  await provider.dispose(handle, { keep: true });
  assert.equal(await stat(handle.cwd).then(() => true, () => false), true);
  await provider.dispose(handle, { keep: false });
  assert.equal(await stat(handle.cwd).then(() => true, () => false), false);
  assert.deepEqual(removed.length, 1);

  await writeFile(join(repo, "README.md"), "dirty\n", "utf8");
  const dirtyHandle = await provider.prepare({ projectRoot: repo, runId: "run-2", planTitle: "  Dirty   checkpoint  " });
  assert.match(await git(repo, "log", "-1", "--pretty=%s"), /checkpoint before executing Dirty checkpoint/);
  await provider.dispose(dirtyHandle, { keep: false });
  const failedProvider = new GitWorktreeProvider({ baseDir, gitBin: "missing-git" });
  await assert.rejects(failedProvider.prepare({ projectRoot: repo, runId: "failed", planTitle: "plan" }), /git rev-parse/);
  assert.equal((await failedProvider.publish({ runId: "x", projectKey: repo, strategy: "git-worktree", cwd: join(root, "missing"), metadata: {} })).diff, undefined);
});

test("GitWorktreeProvider reports worktree-add failures and falls back to filesystem cleanup", async (t) => {
  const root = await tempDir("pilotdeck-git-provider-failures-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const binDir = join(root, "bin");
  await mkdir(repo, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await initRepo(repo);

  const failingAdd = join(binDir, "git-add-fails");
  await writeFile(failingAdd, `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' '${repo}' ;;
  *"status --porcelain"*) ;;
  *"rev-parse --abbrev-ref HEAD"*) printf 'main\\n' ;;
  *"rev-parse HEAD"*) printf 'abc123\\n' ;;
  *"worktree add"*) printf 'worktree denied\\n' >&2; exit 2 ;;
  *) ;;
esac
`, "utf8");
  await chmod(failingAdd, 0o755);
  const provider = new GitWorktreeProvider({ baseDir: join(root, "worktrees"), gitBin: failingAdd });
  await assert.rejects(
    provider.prepare({ projectRoot: repo, runId: "add-failure", planTitle: "Plan" }),
    (error: unknown) => error instanceof AlwaysOnError
      && error.code === "workspace_prepare_failed"
      && error.message.includes("git worktree add failed: worktree denied"),
  );

  const cleanupCwd = join(root, "cleanup-worktree");
  await mkdir(cleanupCwd, { recursive: true });
  const alwaysFail = join(binDir, "git-cleanup-fails");
  await writeFile(alwaysFail, "#!/bin/sh\nprintf 'cleanup failed\\n' >&2\nexit 1\n", "utf8");
  await chmod(alwaysFail, 0o755);
  const cleanupProvider = new GitWorktreeProvider({ baseDir: join(root, "worktrees"), gitBin: alwaysFail });
  await cleanupProvider.dispose({
    runId: "cleanup",
    projectKey: repo,
    strategy: "git-worktree",
    cwd: cleanupCwd,
    metadata: { repoRoot: repo, branchName: "always-on/cleanup" },
  }, { keep: false });
  assert.equal(await stat(cleanupCwd).then(() => true, () => false), false);
});

test("workspace diff/apply helpers cover snapshot, git, empty and cleanup paths", async (t) => {
  const root = await tempDir("pilotdeck-workspace-apply-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const copy = join(root, "copy");
  await mkdir(source, { recursive: true });
  await mkdir(copy, { recursive: true });
  await writeFile(join(source, "same.txt"), "same\n", "utf8");
  await writeFile(join(copy, "same.txt"), "same\n", "utf8");
  await writeFile(join(copy, "new.txt"), "new\n", "utf8");
  const snapshotDiff = await generateWorkspaceDiff("snapshot-copy", copy, source);
  assert.equal(snapshotDiff.fileCount, 1);
  assert.match(snapshotDiff.diff, /new\.txt/);
  assert.deepEqual(await generateWorkspaceDiff("snapshot-copy", source, source), { diff: "", fileCount: 0, truncated: false });
  await disposeWorkspace("snapshot-copy", copy, source);
  assert.equal(await stat(copy).then(() => true, () => false), false);

  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const provider = new GitWorktreeProvider({ baseDir: join(root, "git-worktrees") });
  const handle = await provider.prepare({ projectRoot: repo, runId: "apply-run", planTitle: "Apply" });
  await writeFile(join(handle.cwd, "README.md"), "applied\n", "utf8");
  const gitDiff = await generateWorkspaceDiff("git-worktree", handle.cwd, repo);
  assert.match(gitDiff.diff, /applied/);
  const applied = await applyWorktreeToProject(handle.cwd, repo);
  assert.equal(applied.applied, true);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "applied\n");
  await disposeWorkspace("git-worktree", handle.cwd, repo);
  assert.equal(await stat(handle.cwd).then(() => true, () => false), false);

  const fallback = join(root, "fallback");
  await mkdir(fallback, { recursive: true });
  await writeFile(join(fallback, "file"), "x", "utf8");
  await disposeWorkspace("git-worktree", fallback, join(root, "not-a-repo"), "missing-git");
  assert.equal(await stat(fallback).then(() => true, () => false), false);
  assert.deepEqual(await generateWorkspaceDiff("git-worktree", join(root, "missing"), repo, "missing-git"), { diff: "", fileCount: 0, truncated: false });
  assert.deepEqual(await applyWorktreeToProject(join(root, "missing"), repo, "missing-git"), { applied: false, error: "git add -A failed: spawn missing-git ENOENT" });
});

test("workspace diff reports command errors and truncates oversized snapshot output", async (t) => {
  const root = await tempDir("pilotdeck-workspace-diff-boundaries-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const copy = join(root, "copy");
  await mkdir(source, { recursive: true });
  await mkdir(copy, { recursive: true });

  const missing = await generateWorkspaceDiff("snapshot-copy", copy, join(root, "missing"));
  assert.deepEqual(missing, { diff: "", fileCount: 0, truncated: false });

  await writeFile(join(source, "large.txt"), `${"before\n".repeat(12_000)}`, "utf8");
  await writeFile(join(copy, "large.txt"), `${"after\n".repeat(12_000)}`, "utf8");
  const truncated = await generateWorkspaceDiff("snapshot-copy", copy, source);
  assert.equal(truncated.fileCount, 1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.diff.length, 80_000);

  const failingGit = join(root, "failing-git");
  await writeFile(
    failingGit,
    "#!/bin/sh\ncase \"$*\" in *\" add -A\"*) exit 0 ;; *) printf 'git failure\\n' >&2; exit 2 ;; esac\n",
    "utf8",
  );
  await chmod(failingGit, 0o755);
  assert.deepEqual(
    await generateWorkspaceDiff("git-worktree", root, source, failingGit),
    { diff: "", fileCount: 0, truncated: false },
  );
  assert.deepEqual(
    await applyWorktreeToProject(root, source, failingGit),
    { applied: false, error: "git diff failed: git failure\n" },
  );
});

test("applyWorktreeToProject reports a rejected three-way patch", async (t) => {
  const root = await tempDir("pilotdeck-workspace-apply-failure-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const provider = new GitWorktreeProvider({ baseDir: join(root, "worktrees") });
  const handle = await provider.prepare({ projectRoot: repo, runId: "conflict", planTitle: "Conflict" });
  await writeFile(join(handle.cwd, "README.md"), "from-worktree\n", "utf8");
  await writeFile(join(repo, "README.md"), "from-project\n", "utf8");

  const rejectingGit = join(root, "rejecting-git");
  await writeFile(
    rejectingGit,
    "#!/bin/sh\ncase \"$*\" in *\" apply --3way\"*) printf 'rejected patch\\n' >&2; exit 1 ;; *) exec \"$(command -v git)\" \"$@\" ;; esac\n",
    "utf8",
  );
  await chmod(rejectingGit, 0o755);
  const result = await applyWorktreeToProject(handle.cwd, repo, rejectingGit);
  assert.equal(result.applied, false);
  assert.match(result.error ?? "", /git apply failed: rejected patch/);
  await provider.dispose(handle, { keep: false });
});

test("DiscoveryScheduler runs gates, lock lifecycle, cycle capacity and stop behavior", async (t) => {
  const root = await tempDir("pilotdeck-discovery-scheduler-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date("2026-01-01T00:00:00.000Z");
  const config = alwaysOnConfig(root);
  const paths = resolveAlwaysOnPaths({ pilotHome: root, projectKey: root, worktreesBaseDir: join(root, "worktrees"), snapshotsBaseDir: join(root, "snapshots") });
  const stateStore = new DiscoveryStateStore(paths);
  const cycleStore = new WorkCycleStore(paths);
  const leases = new ChannelLeaseRegistry(() => now);
  const fired: string[] = [];
  const fire = { run: async ({ runId }: { runId: string }) => { fired.push(runId); return { outcome: "no_plan", runId, startedAt: now.toISOString(), finishedAt: now.toISOString() }; } } as never;
  const logger = { info: () => undefined, warn: () => undefined };
  const scheduler = new DiscoveryScheduler({ config, projectKey: root, paths, stateStore, cycleStore, leases, fire, uuid: () => "run-1", now: () => now, logger, isSessionInFlight: () => false });
  assert.deepEqual(await scheduler.runTickOnce(), { outcome: "fired" });
  assert.deepEqual(fired, ["run-1"]);
  assert.equal(await stat(paths.discoveryLockFile).then(() => true, () => false), false);
  await scheduler.start();
  await scheduler.start();
  await scheduler.stop();
  assert.deepEqual(await scheduler.runTickOnce(), { outcome: "blocked", reason: "disabled" });

  const blocked = new DiscoveryScheduler({ config, projectKey: root, paths, stateStore, cycleStore, leases, fire, uuid: () => "run-2", now: () => now, logger, isSessionInFlight: () => true });
  assert.deepEqual(await blocked.runTickOnce(), { outcome: "blocked", reason: "agent_busy" });

  const gateCases: Array<{ name: string; config?: typeof config; projectKey?: string; state?: Parameters<typeof stateStore.write>[0]; lease?: boolean; expected: string }> = [
    { name: "disabled", config: { ...config, enabled: false }, expected: "disabled" },
    { name: "trigger-disabled", config: { ...config, trigger: { ...config.trigger, enabled: false } }, expected: "disabled" },
    { name: "project-disabled", config: { ...config, projects: {} }, expected: "project_disabled" },
    { name: "project-missing", projectKey: join(root, "missing-project"), config: { ...config, projects: { [join(root, "missing-project")]: { enabled: true } } }, expected: "project_missing" },
    { name: "dormant", config: { ...config, dormancy: { ...config.dormancy, enabled: true } }, state: { ...(await stateStore.read(now)), dormant: { since: now.toISOString(), lastBaselineAt: now.toISOString() } }, expected: "dormant_no_signal" },
    { name: "recent-message", lease: true, expected: "recent_user_msg" },
    { name: "cooldown", state: { ...(await stateStore.read(now)), lastFireCompletedAt: now.toISOString() }, expected: "cooldown" },
    { name: "daily-budget", state: { ...(await stateStore.read(now)), todayRunCount: config.trigger.dailyBudget }, expected: "daily_budget" },
  ];
  for (const item of gateCases) {
    const cleanState = await stateStore.read(now);
    await stateStore.write({ ...cleanState, dormant: undefined, lastFireCompletedAt: undefined, todayRunCount: 0, activeWorkCycleId: undefined });
    if (item.state) await stateStore.write(item.state);
    const localLeases = new ChannelLeaseRegistry(() => now);
    if (item.lease) localLeases.set({ schemaVersion: 1, channelKey: "web", writerId: item.name, projectKey: root, sessionKey: "s", writtenAt: now.toISOString(), agentBusy: false, lastUserMsgAt: now.toISOString() });
    const localProject = item.projectKey ?? root;
    const localConfig = item.config ?? config;
    const localScheduler = new DiscoveryScheduler({ config: localConfig, projectKey: localProject, paths, stateStore, cycleStore, leases: localLeases, fire, uuid: () => `${item.name}-run`, now: () => now, logger, isSessionInFlight: () => false });
    assert.deepEqual((await localScheduler.runTickOnce()).reason, item.expected, item.name);
    await localScheduler.stop();
  }

  const cycleHandle = { runId: "cycle-run", projectKey: root, strategy: "snapshot-copy" as const, cwd: join(root, "cycle-workspace"), metadata: {} };
  const resetForCycle = await stateStore.read(now);
  await stateStore.write({ ...resetForCycle, dormant: undefined, lastFireCompletedAt: undefined, todayRunCount: 0, activeWorkCycleId: undefined });
  const cycle = await cycleStore.create(cycleHandle, "cycle-run", "cycle-1", now);
  for (let index = 0; index < config.workspace.maxPlansPerCycle; index += 1) await cycleStore.addPlan(cycle.id, `plan-${index}`);
  await stateStore.setActiveWorkCycleId(cycle.id, now);
  const cycleFull = new DiscoveryScheduler({ config, projectKey: root, paths, stateStore, cycleStore, leases: new ChannelLeaseRegistry(() => now), fire, uuid: () => "cycle-run-2", now: () => now, logger, isSessionInFlight: () => false });
  assert.deepEqual(await cycleFull.runTickOnce(), { outcome: "blocked", reason: "cycle_full" });

  await stateStore.clearActiveWorkCycleId(now);
  const throwing = { run: async () => { throw new Error("fire failed"); } } as never;
  const crash = new DiscoveryScheduler({ config, projectKey: root, paths, stateStore, cycleStore, leases: new ChannelLeaseRegistry(() => now), fire: throwing, uuid: () => "crash-run", now: () => now, logger, isSessionInFlight: () => false });
  await assert.rejects(crash.runTickOnce(), /fire failed/);
  assert.equal(await stat(paths.discoveryLockFile).then(() => true, () => false), false);
  const lock = await acquireDiscoveryLock(paths, { pid: process.pid, runId: "held", startedAt: now.toISOString() });
  assert.equal(lock, true);
  const lockBlocked = new DiscoveryScheduler({ config, projectKey: root, paths, stateStore, cycleStore, leases, fire, uuid: () => "run-3", now: () => now, logger, isSessionInFlight: () => false });
  assert.deepEqual(await lockBlocked.runTickOnce(), { outcome: "blocked", reason: "lock_busy" });
  await releaseDiscoveryLock(paths);
});
