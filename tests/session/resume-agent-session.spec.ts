import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { ToolRegistry } from "../../src/tool/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { resumeAgentSession } from "../../src/session/resume/resumeAgentSession.js";

function config(projectRoot: string): AgentRuntimeConfig {
  return {
    provider: "openai",
    model: "test-model",
    cwd: projectRoot,
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: projectRoot,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

function dependencies(now: () => Date): AgentRuntimeDependencies {
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  return {
    router,
    tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } },
    tokenAccounting: {
      evaluateRequestBudget: async () => ({
        used: 1,
        displayUsed: 1,
        budgetUsed: 1,
        total: 32_768,
        ratio: 0,
        state: "ok",
      }),
    } as never,
    now,
    uuid: () => "new-turn",
  };
}

test("resumeAgentSession restores transcript state, metadata and dependency extensions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-resume-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  await mkdir(projectRoot, { recursive: true });
  const now = () => new Date("2026-08-24T00:00:00.000Z");
  const sessionId = "web:resume";
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId, now });
  await storage.transcript.recordSessionMetadata(sessionId, "turn-1", { title: "Restored title", firstPrompt: "hello" });
  await storage.transcript.recordAcceptedInput(sessionId, "turn-1", [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  await storage.transcript.recordDurableMessage(sessionId, "turn-1", { role: "assistant", content: [{ type: "text", text: "answer" }] });
  await storage.transcript.recordTurnResult(sessionId, "turn-1", {
    type: "success",
    sessionId,
    turnId: "turn-1",
    stopReason: "completed",
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
  });

  const baseDependencies = dependencies(now);
  const context = { marker: "restored-context" };
  const result = await resumeAgentSession({
    sessionId,
    config: config(projectRoot),
    dependencies: baseDependencies,
    projectStorage: { projectRoot, pilotHome },
    collectFileArtifacts: false,
    extendDependencies: (createdStorage) => {
      assert.equal(createdStorage.transcriptPath, storage.transcriptPath);
      return { context: context as never };
    },
  });

  assert.equal(result.transcriptPath, storage.transcriptPath);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.metadata.title, "Restored title");
  assert.deepEqual(result.session.snapshot().messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ]);
  assert.deepEqual(result.session.snapshot().usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
  assert.equal(result.session.snapshotForRuntimeReload().metadata?.title, "Restored title");
});

test("resumeAgentSession reports malformed transcript diagnostics without discarding valid entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-resume-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  await mkdir(projectRoot, { recursive: true });
  const sessionId = "resume-diagnostics";
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "turn-1", [{ role: "user", content: [{ type: "text", text: "kept" }] }]);
  await storage.transcript.recordEntry({ type: "not-a-real-entry" } as never);

  const result = await resumeAgentSession({
    sessionId,
    config: config(projectRoot),
    dependencies: dependencies(() => new Date("2026-08-24T00:00:00.000Z")),
    projectStorage: { projectRoot, pilotHome },
    collectFileArtifacts: false,
  });
  assert.equal(result.session.snapshot().messages[0]?.content[0]?.type, "text");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "transcript_entry_invalid"));
});
