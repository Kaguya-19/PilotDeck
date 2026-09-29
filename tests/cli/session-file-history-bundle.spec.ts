import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionFileHistoryBundle } from "../../src/cli/SessionFileHistoryBundle.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

test("session file-history bundle hydrates from the durable projection and records new snapshots", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-file-history-"));
  const sessionKey = "file-history-bundle";
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    sessionId: sessionKey,
  });
  t.after(async () => {
    await storage.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  });
  const filePath = join(projectRoot, "tracked.txt");
  await writeFile(filePath, "before\n", "utf8");

  const first = new SessionFileHistoryBundle({
    sessionKey,
    storage,
    now: () => new Date("2026-09-09T00:00:00.000Z"),
  }).compose();
  await first.trackEdit(filePath, "turn-1");

  const restored = new SessionFileHistoryBundle({
    sessionKey,
    storage,
    now: () => new Date("2026-09-09T00:00:01.000Z"),
  }).compose();
  const snapshots = restored.getState().snapshots;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.messageId, "turn-1");
  assert.ok(snapshots[0]?.trackedFileBackups[filePath]);
});
