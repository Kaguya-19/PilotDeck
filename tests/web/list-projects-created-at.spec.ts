import { mkdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { createCollisionResistantProjectId, createProjectId } from "../../src/pilot/paths.js";
import { createNodeSessionCatalog } from "../../src/session/catalog/NodeSessionCatalog.js";
import { describeWebProject, listWebProjects } from "../../src/web/server/listProjects.js";

const sessionCatalog = createNodeSessionCatalog();

test("project summaries expose registration creation time for list and describe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-created-at-"));
  const pilotHome = join(root, ".pilotdeck");
  const projectRoot = join(root, "workspace");
  const projectId = createProjectId(projectRoot);
  const storageDir = join(pilotHome, "projects", projectId);
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await writeFile(join(storageDir, ".cwd"), `${projectRoot}\n`, "utf8");
  const expectedCreatedAt = (await stat(storageDir)).birthtimeMs;

  const listed = await listWebProjects({ pilotHome, sessionCatalog });
  const described = await describeWebProject(projectRoot, { pilotHome, sessionCatalog });

  assert.equal(listed.projects[0]?.createdAt, expectedCreatedAt);
  assert.equal(described.createdAt, expectedCreatedAt);
});

test("describe resolves the marked project when legacy ids collide", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-created-at-collision-"));
  const pilotHome = join(root, ".pilotdeck");
  const firstProjectRoot = join(root, "a-b");
  const secondProjectRoot = join(root, "a b");
  const legacyId = createProjectId(firstProjectRoot);
  const collisionResistantId = createCollisionResistantProjectId(secondProjectRoot);
  const firstStorageDir = join(pilotHome, "projects", legacyId);
  const secondStorageDir = join(pilotHome, "projects", collisionResistantId);

  await mkdir(firstProjectRoot, { recursive: true });
  await mkdir(secondProjectRoot, { recursive: true });
  await mkdir(firstStorageDir, { recursive: true });
  await mkdir(secondStorageDir, { recursive: true });
  await writeFile(join(firstStorageDir, ".cwd"), `${firstProjectRoot}\n`, "utf8");
  await writeFile(join(secondStorageDir, ".cwd"), `${secondProjectRoot}\n`, "utf8");

  const expectedCreatedAt = (await stat(secondStorageDir)).birthtimeMs;
  const described = await describeWebProject(secondProjectRoot, { pilotHome, sessionCatalog });

  assert.equal(described.createdAt, expectedCreatedAt);
});
