import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProjectId } from "../../src/pilot/paths.js";
import type { SessionCatalogListInput, SessionCatalogPort, SessionInfo } from "../../src/session/catalog/SessionCatalogPort.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { listWebProjects } from "../../src/web/server/listProjects.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("web session history resolves metadata through its injected catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-web-catalog-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "web-session";
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "turn-1", [{
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  }]);

  const calls: SessionCatalogListInput[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session(sessionId, "Catalog session title")];
    },
  };

  const result = await readWebSessionMessages(
    { sessionKey: sessionId },
    { projectRoot, pilotHome, sessionCatalog: catalog },
  );

  assert.deepEqual(calls, [{ projectRoot, pilotHome }]);
  assert.equal(result.session.summary, "Catalog session title");
});

test("web project list uses its injected catalog for activity summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-web-catalog-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  const projectDir = join(pilotHome, "projects", createProjectId(projectRoot));
  await mkdir(projectRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, ".cwd"), `${projectRoot}\n`, "utf8");

  const calls: SessionCatalogListInput[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session("project-session", "Project session")];
    },
  };

  const result = await listWebProjects({ pilotHome, sessionCatalog: catalog });

  assert.deepEqual(calls, [{ projectRoot, pilotHome }]);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]?.projectKey, projectRoot);
  assert.equal(result.projects[0]?.sessionCount, 1);
  assert.equal(result.projects[0]?.lastActivity, 1);
});

function session(sessionId: string, summary: string): SessionInfo {
  return { sessionId, summary, lastModified: 1 };
}
