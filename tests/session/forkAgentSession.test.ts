import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { ToolRegistry } from "../../src/tool/index.js";
import {
  ForkAgentSessionError,
  createAgentProjectSessionStorage,
  forkAgentSession,
  readTranscript,
  replayTranscriptEntries,
  resumeAgentSession,
  type AgentTranscriptEntry,
} from "../../src/session/index.js";

test("forkAgentSession copies history through the latest complete turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-"));
  try {
    const now = () => new Date("2026-06-22T00:00:00.000Z");
    const projectRoot = join(root, "project");
    const pilotHome = join(root, "pilot-home");
    const sourceStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_source",
      now,
    });
    await sourceStorage.transcript.recordAcceptedInput("web:s_source", "turn-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    await sourceStorage.transcript.recordDurableMessage("web:s_source", "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
    await sourceStorage.transcript.recordTurnResult("web:s_source", "turn-1", {
      type: "success",
      sessionId: "web:s_source",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: now().toISOString(),
      completedAt: now().toISOString(),
    });
    await sourceStorage.transcript.recordSessionMetadata("web:s_source", "metadata", {
      title: "Source title",
      updatedAt: now().toISOString(),
    });
    await sourceStorage.transcript.recordAcceptedInput("web:s_source", "turn-2", [
      { role: "user", content: [{ type: "text", text: "unfinished" }] },
    ]);

    const result = await forkAgentSession({
      projectRoot,
      pilotHome,
      sourceSessionKey: "web:s_source",
      targetSessionKey: "web:s_target",
      now,
    });

    const target = await readTranscript(result.transcriptPath);
    assert.deepEqual(target.diagnostics, []);
    assert.equal(target.entries.some((entry) => entry.turnId === "turn-2"), false);
    assert.equal(target.entries.filter((entry) => entry.type === "turn_result").length, 1);
    assert.equal(target.entries.every((entry) => entry.sessionId === "web:s_target"), true);
    assert.equal(
      target.entries.every((entry) => entry.type !== "turn_result" || entry.result.sessionId === "web:s_target"),
      true,
    );

    const replay = replayTranscriptEntries(target.entries);
    assert.equal(replay.messages.length, 2);
    assert.equal(replay.metadata.title, "Fork: Source title");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forkAgentSession rejects transcripts without a complete turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-empty-"));
  try {
    const projectRoot = join(root, "project");
    const pilotHome = join(root, "pilot-home");
    const sourceStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_source",
    });
    await sourceStorage.transcript.recordAcceptedInput("web:s_source", "turn-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    await assert.rejects(
      () =>
        forkAgentSession({
          projectRoot,
          pilotHome,
          sourceSessionKey: "web:s_source",
          targetSessionKey: "web:s_target",
        }),
      (error) =>
        error instanceof ForkAgentSessionError &&
        error.code === "source_session_not_forkable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forkAgentSession writes a jsonl transcript with fork boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-boundary-"));
  try {
    const projectRoot = join(root, "project");
    const pilotHome = join(root, "pilot-home");
    const sourceStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:s_source",
    });
    await sourceStorage.transcript.recordAcceptedInput("web:s_source", "turn-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    await sourceStorage.transcript.recordTurnResult("web:s_source", "turn-1", {
      type: "success",
      sessionId: "web:s_source",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-06-22T00:00:00.000Z",
      completedAt: "2026-06-22T00:00:00.000Z",
    });

    const result = await forkAgentSession({
      projectRoot,
      pilotHome,
      sourceSessionKey: "web:s_source",
      targetSessionKey: "web:s_target",
      title: "Custom fork",
    });
    const raw = await readFile(result.transcriptPath, "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentTranscriptEntry);
    const boundary = entries.find((entry) => entry.type === "control_boundary");
    const metadata = entries.find((entry) => entry.type === "session_metadata");

    assert.equal(boundary?.type, "control_boundary");
    assert.equal(boundary?.boundary.kind, "manual");
    assert.equal(boundary?.boundary.metadata?.action, "session_fork");
    assert.equal(boundary?.boundary.metadata?.sourceSessionKey, "web:s_source");
    assert.equal(metadata?.type, "session_metadata");
    assert.equal(metadata?.metadata.title, "Custom fork");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forkAgentSession creates a transcript that can be resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-resume-"));
  try {
    const now = () => new Date("2026-06-22T00:00:00.000Z");
    const projectRoot = join(root, "project");
    const pilotHome = join(root, "pilot-home");
    const sourceStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "web:project=/tmp/project:s_source",
      now,
    });
    await sourceStorage.transcript.recordAcceptedInput("web:project=/tmp/project:s_source", "turn-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    await sourceStorage.transcript.recordDurableMessage("web:project=/tmp/project:s_source", "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
    await sourceStorage.transcript.recordTurnResult("web:project=/tmp/project:s_source", "turn-1", {
      type: "success",
      sessionId: "web:project=/tmp/project:s_source",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: now().toISOString(),
      completedAt: now().toISOString(),
    });

    await forkAgentSession({
      projectRoot,
      pilotHome,
      sourceSessionKey: "web:project=/tmp/project:s_source",
      targetSessionKey: "web:project=/tmp/project:s_target",
      now,
    });

    const resumed = await resumeAgentSession({
      sessionId: "web:project=/tmp/project:s_target",
      projectStorage: {
        projectRoot,
        pilotHome,
      },
      config: {
        provider: "test",
        model: "test",
        cwd: projectRoot,
        permissionMode: "default",
        permissionContext: createDefaultPermissionContext({
          cwd: projectRoot,
          mode: "default",
        }),
      },
      dependencies: {
        router: {
          stream: async function* () {},
          decide: async () => ({
            provider: "test",
            model: "test",
            scenarioType: "default",
            isSubagent: false,
            orchestrating: false,
            resolvedFrom: "explicit",
            mutations: {},
          }),
          execute: async function* () {},
        },
        tools: {
          registry: new ToolRegistry(),
        },
        now,
      },
    });

    assert.deepEqual(resumed.diagnostics, []);
    assert.equal(resumed.session.snapshot().messages.length, 2);
    assert.equal(resumed.metadata.title, "Forked session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
