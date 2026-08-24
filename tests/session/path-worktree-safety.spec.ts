import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  __clearWorktreeCachesForTesting,
  findCanonicalProjectRoot,
  findGitRoot,
  resolveCanonicalRoot,
} from "../../src/session/worktree/index.js";
import {
  isPathWithinRoot,
  resolvePilotDeckWorkspacePath,
  toWorkspaceRelativePath,
} from "../../src/tool/builtin/filesystem/pathSafety.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function context(cwd: string, overrides: Record<string, unknown> = {}): PilotDeckToolRuntimeContext {
  return {
    cwd,
    sessionId: "session",
    turnId: "turn",
    permissionMode: "default",
    permissionContext: { additionalWorkingDirectories: [] },
    ...overrides,
  } as PilotDeckToolRuntimeContext;
}

test("findGitRoot and findCanonicalProjectRoot resolve regular repos and no-git fallbacks", async (t) => {
  const root = await tempDir("pilotdeck-worktree-");
  t.after(async () => {
    __clearWorktreeCachesForTesting();
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const nested = join(repo, "src", "nested");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  assert.equal(await findGitRoot(nested), repo);
  assert.equal(await findCanonicalProjectRoot(nested), await realpath(repo));
  assert.equal(await findCanonicalProjectRoot(join(root, "outside")), join(root, "outside"));
  assert.equal(await findGitRoot(join(root, "outside")), null);
});

test("resolveCanonicalRoot accepts valid worktrees and safely falls back for malformed links", async (t) => {
  const root = await tempDir("pilotdeck-worktree-layout-");
  t.after(async () => {
    __clearWorktreeCachesForTesting();
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const commonGit = join(repo, ".git");
  const worktree = join(root, "worktree");
  const worktreeGitDir = join(commonGit, "worktrees", "worktree");
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(join(worktree, ".git"), { recursive: true }).catch(() => undefined);
  await rm(join(worktree, ".git"), { recursive: true, force: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  await writeFile(join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`, "utf8");
  await mkdir(join(repo, "src"), { recursive: true });
  assert.equal(await resolveCanonicalRoot(worktree), await realpath(repo));

  const submodule = join(root, "submodule");
  await mkdir(submodule, { recursive: true });
  await writeFile(join(submodule, ".git"), "gitdir: /not-a-worktree\n", "utf8");
  assert.equal(await resolveCanonicalRoot(submodule), await realpath(submodule));

  const malicious = join(root, "malicious");
  const maliciousGitDir = join(root, "attacker", "entry");
  await mkdir(maliciousGitDir, { recursive: true });
  await mkdir(malicious, { recursive: true });
  await writeFile(join(malicious, ".git"), `gitdir: ${maliciousGitDir}\n`, "utf8");
  await writeFile(join(maliciousGitDir, "commondir"), `${commonGit}\n`, "utf8");
  await writeFile(join(maliciousGitDir, "gitdir"), `${join(malicious, ".git")}\n`, "utf8");
  assert.equal(await resolveCanonicalRoot(malicious), await realpath(malicious));

  const badBacklink = join(root, "bad-backlink");
  const badGitDir = join(commonGit, "worktrees", "bad");
  await mkdir(badGitDir, { recursive: true });
  await mkdir(badBacklink, { recursive: true });
  await writeFile(join(badBacklink, ".git"), `gitdir: ${badGitDir}\n`, "utf8");
  await writeFile(join(badGitDir, "commondir"), "../..\n", "utf8");
  await writeFile(join(badGitDir, "gitdir"), `${join(root, "another", ".git")}\n`, "utf8");
  assert.equal(await resolveCanonicalRoot(badBacklink), await realpath(badBacklink));
});

test("workspace path safety rejects escapes, symlink escapes and denied writes", async (t) => {
  const root = await tempDir("pilotdeck-path-safety-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "file.txt"), "ok", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, join(workspace, "link"));
  const registered = join(outside, "registered.txt");
  await writeFile(registered, "registered", "utf8");
  const pilotHome = join(root, "pilot-home");
  const attachmentDir = join(pilotHome, "im-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const attachment = join(attachmentDir, "attachment.txt");
  await writeFile(attachment, "attachment", "utf8");

  assert.equal(isPathWithinRoot(join(workspace, "child"), workspace), true);
  assert.equal(isPathWithinRoot(join(root, "workspace-other"), workspace), false);
  assert.equal(toWorkspaceRelativePath(workspace, workspace), ".");
  assert.equal(toWorkspaceRelativePath(join(workspace, "file.txt"), workspace), "file.txt");
  assert.equal(resolvePilotDeckWorkspacePath("", context(workspace)).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath("bad\0path", context(workspace)).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath("file.txt", context(workspace)).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath("../outside/secret.txt", context(workspace)).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(join(root, "workspace-other", "file"), context(workspace)).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath("link/secret.txt", context(workspace), { mustExist: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath("missing.txt", context(workspace), { mustExist: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(".git/config", context(workspace), { forWrite: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath("../outside/secret.txt", context(workspace), { allowOutsideWorkspace: true }).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath(registered, context(workspace), { allowRegisteredReadFiles: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(registered, context(workspace, { allowedReadFiles: [registered] }), { allowRegisteredReadFiles: true }).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath(join(outside, "missing.txt"), context(workspace, { allowedReadFiles: [registered] }), { allowRegisteredReadFiles: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(attachment, context(workspace, { env: { PILOT_HOME: pilotHome } }), { allowRegisteredReadFiles: true }).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath(attachmentDir, context(workspace, { env: { PILOT_HOME: pilotHome } }), { allowRegisteredReadFiles: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(registered, context(workspace, { permissionContext: { additionalWorkingDirectories: [outside] } })).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath("../outside/secret.txt", context(workspace, { permissionMode: "bypassPermissions" }), { forWrite: true }).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath("../outside/secret.txt", context(workspace, { permissionMode: "bypassPermissions" }), { forWrite: false }).ok, true);
});
