import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildChatDigest, extractAllUserPrompts } from "../../src/always-on/context/ChatDigestBuilder.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";

test("extractAllUserPrompts deduplicates, truncates and skips malformed entries", () => {
  const line = (text: string) => JSON.stringify({ type: "accepted_input", messages: [{ content: [{ type: "text", text }] }] });
  const source = [
    line("first"),
    line("first"),
    "not-json",
    line("second prompt"),
    line("third prompt"),
  ].join("\n");
  assert.deepEqual(extractAllUserPrompts(source, 2, 6), ["first", "second..."]);
  assert.deepEqual(extractAllUserPrompts(line("  \n"), 8, 20), []);
});

test("buildChatDigest creates aliases, excludes internal sessions and bounds prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-chat-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  await mkdir(projectRoot, { recursive: true });
  const now = () => new Date("2026-08-24T00:00:00.000Z");
  for (const sessionId of ["web:one", "always-on-execute:internal"]) {
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId, now });
    await storage.transcript.recordSessionMetadata(sessionId, "turn", { title: sessionId });
    await storage.transcript.recordAcceptedInput(sessionId, "turn", [{ role: "user", content: [{ type: "text", text: "A very long prompt" }] }]);
    await storage.transcript.recordTurnResult(sessionId, "turn", {
      type: "success", sessionId, turnId: "turn", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
      startedAt: now().toISOString(), completedAt: now().toISOString(),
    });
  }

  const digest = await buildChatDigest({ projectRoot, pilotHome, maxSessions: 8, maxPromptsPerSession: 2, maxPromptLength: 8, now });
  assert.equal(digest.generatedAt, now().toISOString());
  assert.equal(digest.sessions.length, 1);
  assert.equal(digest.sessions[0]?.alias, "chat_1");
  assert.deepEqual(digest.sessions[0]?.userPrompts, ["A very l..."]);
  assert.equal(digest.aliasMap.get("chat_1"), "web:one");
});
