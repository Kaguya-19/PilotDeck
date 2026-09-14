import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";
import type {
  PilotDeckPermissionAuditFailureRecord,
  PilotDeckPermissionAuditRecord,
  PilotDeckPermissionAuditStartRecord,
  PilotDeckToolAuditRecord,
  PilotDeckToolAuditRecorder,
} from "../../../tool/audit/ToolAuditRecorder.js";

const DURABLE_PERMISSION_AUDIT_DELEGATE = Symbol("pilotdeck.durable-permission-audit-delegate");

/**
 * Permission audit recording belongs to one exact AgentSession. Descendant
 * session composition must recover the host audit sink before binding its own
 * recorder, rather than retaining a parent-session wrapper.
 */
export function unwrapDurablePermissionAuditRecorder(
  recorder: PilotDeckToolAuditRecorder | undefined,
): PilotDeckToolAuditRecorder | undefined {
  let current = recorder;
  const seen = new Set<PilotDeckToolAuditRecorder>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (!Object.prototype.hasOwnProperty.call(current, DURABLE_PERMISSION_AUDIT_DELEGATE)) {
      return current;
    }
    current = (current as DurablePermissionAuditRecorderLike)[DURABLE_PERMISSION_AUDIT_DELEGATE];
  }
  return current;
}

export type DurablePermissionAuditOptions = {
  /** Only events for this session may be appended to the session transcript. */
  sessionId: string;
};

/**
 * Bind permission audit to the session event owner while preserving the
 * existing host audit sink. Permission input is deliberately not persisted;
 * the durable record contains only decision metadata and the tool identity.
 */
export function createDurablePermissionAuditRecorder(
  delegate: PilotDeckToolAuditRecorder | undefined,
  recorder: AgentSessionEventRecorder,
  options: DurablePermissionAuditOptions,
): PilotDeckToolAuditRecorder {
  if (delegate && Object.prototype.hasOwnProperty.call(delegate, DURABLE_PERMISSION_AUDIT_DELEGATE)) {
    return delegate;
  }

  const belongsToSession = (sessionId: string): boolean => sessionId === options.sessionId;
  const durable: PilotDeckToolAuditRecorder = {
    async recordPermission(record: PilotDeckPermissionAuditRecord): Promise<void> {
      if (belongsToSession(record.sessionId)) {
        await recorder.recordPermissionCompleted(record.sessionId, record.turnId, {
          step: recorder.currentStep(record.turnId),
          operationId: record.operationId ?? record.toolCallId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          mode: record.mode,
          decision: record.decision,
          reason: record.reason,
        });
      }
      await delegate?.recordPermission(record);
    },
    async recordPermissionStarted(record: PilotDeckPermissionAuditStartRecord): Promise<void> {
      if (belongsToSession(record.sessionId)) {
        await recorder.recordPermissionStarted(record.sessionId, record.turnId, {
          step: recorder.currentStep(record.turnId),
          operationId: record.operationId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          mode: record.mode,
        });
      }
      await delegate?.recordPermissionStarted?.(record);
    },
    async recordPermissionFailed(record: PilotDeckPermissionAuditFailureRecord): Promise<void> {
      if (belongsToSession(record.sessionId)) {
        await recorder.recordPermissionFailed(record.sessionId, record.turnId, {
          step: recorder.currentStep(record.turnId),
          operationId: record.operationId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          mode: record.mode,
          error: record.error,
        });
      }
      await delegate?.recordPermissionFailed?.(record);
    },
    async recordTool(record: PilotDeckToolAuditRecord): Promise<void> {
      await delegate?.recordTool(record);
    },
  };
  Object.defineProperty(durable, DURABLE_PERMISSION_AUDIT_DELEGATE, { value: delegate });
  return durable;
}

type DurablePermissionAuditRecorderLike = PilotDeckToolAuditRecorder & {
  [DURABLE_PERMISSION_AUDIT_DELEGATE]?: PilotDeckToolAuditRecorder | undefined;
};
