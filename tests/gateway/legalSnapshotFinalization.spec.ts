import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { WorkspaceSnapshotInput, WorkspaceSnapshotRecorder } from "../../src/storage/legalDataStorage.js";

test("gateway finalizes an agent error with one classified post-agent snapshot", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-snapshot-"));
  const postInputs: WorkspaceSnapshotInput[] = [];
  const recorder: WorkspaceSnapshotRecorder = {
    capturePreUser: async () => ({
      snapshotId: "pre",
      phase: "pre_user",
      state: "committed",
      abnormal: false,
      roundStatus: "captured",
    }),
    capturePostAgent: async (input) => {
      postInputs.push(input);
      return {
        snapshotId: "post",
        phase: "post_agent",
        state: "committed",
        abnormal: true,
        roundStatus: "failed",
        failureKind: input.failureKind,
        failureReason: input.failureReason,
      };
    },
  };
  const fakeSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn";
      yield {
        type: "turn_failed",
        sessionId: "web:session",
        turnId,
        error: { code: "agent_model_error", message: "provider failed" },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    workspaceId: "workspace",
    snapshotRecorder: recorder,
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:session",
    channelKey: "web",
    message: "run",
    runId: "turn",
  })) {
    // Drain the turn so finalization runs.
  }

  assert.equal(postInputs.length, 1);
  assert.equal(postInputs[0]?.failureKind, "agent_error");
  assert.match(postInputs[0]?.failureReason ?? "", /agent_model_error: provider failed/);
});

test("gateway does not scan a timed-out workspace before agent unwind completes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-snapshot-"));
  const postInputs: WorkspaceSnapshotInput[] = [];
  const recorder: WorkspaceSnapshotRecorder = {
    capturePreUser: async () => ({
      snapshotId: "pre",
      phase: "pre_user",
      state: "committed",
      abnormal: false,
      roundStatus: "captured",
    }),
    capturePostAgent: async (input) => {
      postInputs.push(input);
      return {
        snapshotId: "post",
        phase: "post_agent",
        state: "failed",
        abnormal: true,
        roundStatus: "failed",
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        error: "workspace not stable",
      };
    },
  };
  const fakeSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit() {
      await new Promise<void>(() => {});
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    workspaceId: "workspace",
    snapshotRecorder: recorder,
    abortTurnTimeoutMs: 5,
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:timeout",
    channelKey: "web",
    message: "run",
    runId: "turn-timeout",
    timeoutMs: 5,
  })) {
    // Drain the timeout event so finalization runs.
  }

  assert.equal(postInputs.length, 1);
  assert.equal(postInputs[0]?.failureKind, "timeout");
  assert.equal(postInputs[0]?.workspaceStable, false);
  assert.match(postInputs[0]?.failureReason ?? "", /workspace_not_quiescent/);
});

test("gateway marks a user-interrupted post-agent snapshot as aborted", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-snapshot-"));
  const postInputs: WorkspaceSnapshotInput[] = [];
  const recorder: WorkspaceSnapshotRecorder = {
    capturePreUser: async () => ({
      snapshotId: "pre",
      phase: "pre_user",
      state: "committed",
      abnormal: false,
      roundStatus: "captured",
    }),
    capturePostAgent: async (input) => {
      postInputs.push(input);
      return {
        snapshotId: "post",
        phase: "post_agent",
        state: "committed",
        abnormal: true,
        roundStatus: "aborted",
        failureKind: input.failureKind,
        failureReason: input.failureReason,
      };
    },
  };
  const fakeSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      yield {
        type: "session_aborted",
        sessionId: "web:interrupted",
        turnId: options.turnId ?? "turn-interrupted",
        reason: "user requested stop",
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    workspaceId: "workspace",
    snapshotRecorder: recorder,
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:interrupted",
    channelKey: "web",
    message: "run",
    runId: "turn-interrupted",
  })) {
    // Drain the turn so finalization runs.
  }

  assert.equal(postInputs.length, 1);
  assert.equal(postInputs[0]?.failureKind, "interrupted");
  assert.equal(postInputs[0]?.failureReason, "user requested stop");
});
