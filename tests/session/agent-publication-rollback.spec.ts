import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSessionWithStorageAsync } from "../../src/agent/session/createAgentSession.js";
import { resumeAgentSession } from "../../src/session/resume/resumeAgentSession.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";

test("async agent construction waits for storage and projection rollback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-construction-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "construction-failure",
  });

  await assert.rejects(
    createAgentSessionWithStorageAsync({
      ...baseOptions(root, "construction-failure"),
      storage,
      __agentLoopFactory: () => { throw new Error("loop construction failed"); },
    }),
    /loop construction failed/,
  );

  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
  assert.throws(() => storage.projections.snapshot(), /projection driver is disposed/);
});

test("resume restore failure disposes unpublished storage exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-resume-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "restore-failure",
  });
  const originalDispose = storage.dispose;
  let disposeCalls = 0;
  storage.restore = async () => { throw new Error("restore failed"); };
  storage.dispose = () => {
    disposeCalls += 1;
    return originalDispose();
  };

  await assert.rejects(
    resumeAgentSession({
      ...baseOptions(root, "restore-failure"),
      projectStorage: { projectRoot: root, pilotHome: root },
      __storageFactory: () => storage,
    }),
    /restore failed/,
  );

  assert.equal(disposeCalls, 1);
  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
});

test("resume extension preserves elicitation ownership for handle disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-resume-elicitation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let disposeCalls = 0;
  const elicitation = {
    async askUser() {
      return { type: "cancelled" as const };
    },
    async dispose() {
      disposeCalls += 1;
    },
  };

  const resumed = await resumeAgentSession({
    ...baseOptions(root, "resume-elicitation-owner"),
    projectStorage: { projectRoot: root, pilotHome: root },
    extendDependencies: () => ({ elicitation, ownedElicitation: true }),
  });

  assert.equal(disposeCalls, 0);
  await resumed.handle.dispose("test_resume_elicitation_dispose");
  assert.equal(disposeCalls, 1);
  await resumed.handle.dispose("duplicate_dispose");
  assert.equal(disposeCalls, 1);
});

function baseOptions(root: string, sessionId: string) {
  return {
    sessionId,
    config: {
      provider: "test",
      model: "test",
      cwd: root,
      permissionMode: "default" as const,
      permissionContext: {
        mode: "default" as const,
        cwd: root,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
  };
}
