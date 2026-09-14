import assert from "node:assert/strict";
import test from "node:test";

import { createDurablePermissionAuditRecorder } from "../../src/agent/modules/permission/index.js";
import { AgentSessionEventRecorder } from "../../src/agent/session/AgentSessionEventRecorder.js";
import type { PermissionDecisionPort } from "../../src/permission/index.js";
import {
  SessionDomainValidationError,
  validateSessionDomainLog,
} from "../../src/session/events/index.js";
import type { SessionEventDraft } from "../../src/session/events/SessionEventStore.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import {
  ToolRuntime,
  ToolRegistry,
  type PilotDeckToolAuditRecorder,
  type PilotDeckToolDefinition,
} from "../../src/tool/index.js";

const createdAt = "2026-09-07T00:00:00.000Z";
const sessionId = "permission-session";
const turnId = "turn-1";

const tool: PilotDeckToolDefinition = {
  name: "write_file",
  description: "write",
  kind: "custom",
  inputSchema: { type: "object" },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
};

function context(auditRecorder?: PilotDeckToolAuditRecorder) {
  return {
    sessionId,
    turnId,
    cwd: "/workspace",
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/workspace",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
    },
    ...(auditRecorder ? { auditRecorder } : {}),
  };
}

function createToolRuntime(permission: PermissionDecisionPort): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new ToolRuntime(registry, permission);
}

async function openModelStep(
  transcript: InMemoryTranscriptWriter,
  recorder: AgentSessionEventRecorder,
): Promise<void> {
  await recorder.startTurn(sessionId, turnId);
  await recorder.recordModelRequest(sessionId, turnId, {
    provider: "provider-a",
    model: "model-a",
    request: { provider: "provider-a", model: "model-a", messages: [] },
  });
}

test("permission audit records final allow without persisting tool input", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  const audit = createDurablePermissionAuditRecorder(undefined, recorder, { sessionId });
  await openModelStep(transcript, recorder);

  let executed = false;
  const permission: PermissionDecisionPort = {
    async decide() {
      return { type: "allow", reason: { type: "runtime", message: "approved" } };
    },
  };
  const runtime = createToolRuntime(permission);
  tool.execute = async () => {
    executed = true;
    return { content: [{ type: "text", text: "executed" }] };
  };

  const result = await runtime.execute(
    { id: "call-allow", name: tool.name, input: { secret: "do-not-persist" } },
    context(audit),
  );

  assert.equal(result.type, "success");
  assert.equal(executed, true);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "model_request",
    "permission_started",
    "permission_completed",
  ]);
  const completed = transcript.entries.find((entry) => entry.type === "permission_completed");
  assert.equal(completed?.decision, "allow");
  assert.equal(JSON.stringify(transcript.entries).includes("do-not-persist"), false);
});

test("permission audit records unresolved ask as completed policy outcome", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  const audit = createDurablePermissionAuditRecorder(undefined, recorder, { sessionId });
  await openModelStep(transcript, recorder);
  const permission: PermissionDecisionPort = {
    async decide(_tool, _input, _context, toolCallId) {
      return {
        type: "ask",
        reason: { type: "runtime", message: "approval required" },
        request: {
          toolCallId,
          toolName: tool.name,
          inputSummary: "redacted",
          reason: { type: "runtime", message: "approval required" },
          options: [{ id: "allow_once", label: "Allow once" }],
        },
      };
    },
  };

  const result = await createToolRuntime(permission).execute(
    { id: "call-ask", name: tool.name, input: { secret: "hidden" } },
    context(audit),
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_required");
  const completed = transcript.entries.find((entry) => entry.type === "permission_completed");
  assert.equal(completed?.decision, "ask");
});

test("permission provider failure records failed audit and never executes the tool", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  const audit = createDurablePermissionAuditRecorder(undefined, recorder, { sessionId });
  await openModelStep(transcript, recorder);
  let executed = false;
  tool.execute = async () => {
    executed = true;
    return { content: [{ type: "text", text: "executed" }] };
  };
  const permission: PermissionDecisionPort = {
    async decide() {
      throw new Error("permission provider unavailable");
    },
  };

  await assert.rejects(
    () => createToolRuntime(permission).execute(
      { id: "call-failed", name: tool.name, input: {} },
      context(audit),
    ),
    /permission provider unavailable/,
  );
  assert.equal(executed, false);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "model_request",
    "permission_started",
    "permission_failed",
  ]);
});

test("permission completion audit append failure is fail-closed", async () => {
  const transcript = new FailingTranscriptWriter("permission_completed");
  const recorder = new AgentSessionEventRecorder(transcript);
  const audit = createDurablePermissionAuditRecorder(undefined, recorder, { sessionId });
  await openModelStep(transcript, recorder);
  let executed = false;
  tool.execute = async () => {
    executed = true;
    return { content: [{ type: "text", text: "executed" }] };
  };
  const permission: PermissionDecisionPort = {
    async decide() {
      return { type: "allow", reason: { type: "runtime", message: "approved" } };
    },
  };

  await assert.rejects(
    () => createToolRuntime(permission).execute(
      { id: "call-audit-failure", name: tool.name, input: {} },
      context(audit),
    ),
    /permission_completed persistence failed/,
  );
  assert.equal(executed, false);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "model_request",
    "permission_started",
  ]);
});

test("domain validation rejects closing a turn with pending permission", () => {
  assert.throws(
    () => validateSessionDomainLog([
      entry(1, { type: "turn_started" }),
      entry(2, { type: "step_started", step: 1 }),
      entry(3, { type: "model_request", step: 1, request: { provider: "p", model: "m", messages: [] } }),
      entry(4, {
        type: "permission_started",
        step: 1,
        operationId: "call-pending",
        toolCallId: "call-pending",
        toolName: tool.name,
        mode: "default",
      }),
      entry(5, { type: "step_completed", step: 1, outcome: "failed" }),
      entry(6, { type: "turn_result", result: {
        type: "success",
        sessionId,
        turnId,
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      } }),
    ]),
    (error: unknown) => error instanceof SessionDomainValidationError
      && error.code === "turn_has_pending_permission",
  );
});

function entry(sequence: number, event: SessionEventDraft): AgentTranscriptEntry {
  return {
    ...event,
    sessionId,
    turnId,
    sequence,
    createdAt,
  } as AgentTranscriptEntry;
}

class FailingTranscriptWriter extends InMemoryTranscriptWriter {
  constructor(private readonly failureType: string) {
    super();
  }

  override recordSessionEvent(
    sessionId: string,
    turnId: string,
    event: SessionEventDraft,
  ): Promise<void> {
    if (event.type === this.failureType) {
      return Promise.reject(new Error(`${this.failureType} persistence failed`));
    }
    return super.recordSessionEvent(sessionId, turnId, event);
  }
}
