import type { PermissionDecision, PermissionDecisionReason, PermissionMode } from "../../permission/index.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";

export type PilotDeckPermissionAuditRecord = {
  type: "permission";
  /** One permission evaluation per model tool call. */
  operationId?: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
  createdAt: string;
};

export type PilotDeckPermissionAuditStartRecord = {
  type: "permission_started";
  operationId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  createdAt: string;
};

export type PilotDeckPermissionAuditFailureRecord = {
  type: "permission_failed";
  operationId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  error: string;
  createdAt: string;
};

export type PilotDeckToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: PilotDeckToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type PilotDeckToolAuditRecorder = {
  recordPermission(record: PilotDeckPermissionAuditRecord): void | Promise<void>;
  recordPermissionStarted?(record: PilotDeckPermissionAuditStartRecord): void | Promise<void>;
  recordPermissionFailed?(record: PilotDeckPermissionAuditFailureRecord): void | Promise<void>;
  recordTool(record: PilotDeckToolAuditRecord): void | Promise<void>;
};
