import type { PilotDeckToolRuntimeContext } from "../../../tool/index.js";
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from "../../../tool/protocol/subagentTimeout.js";
import type { AgentExecutionContext } from "../protocol.js";

/**
 * Narrows the full-fork child budget to the remaining operation lifetime.
 *
 * The operation deadline belongs to the caller's execution contract, while
 * `subagentTimeoutMs` is the runtime value consumed by the agent tool. The
 * adapter derives a context without changing the scheduler or tool owners.
 */
export function withOperationDeadlineBudget(
  context: PilotDeckToolRuntimeContext,
  execution: AgentExecutionContext,
): PilotDeckToolRuntimeContext {
  if (!execution.operationDeadline) return context;
  const deadlineAt = Date.parse(execution.operationDeadline);
  if (!Number.isFinite(deadlineAt)) return context;

  const now = context.now?.().getTime() ?? Date.now();
  if (!Number.isFinite(now)) return context;

  const configuredTimeout = context.subagentTimeoutMs;
  if (configuredTimeout !== undefined && !Number.isFinite(configuredTimeout)) return context;

  const remainingMs = Math.max(0, deadlineAt - now);
  const effectiveTimeout = Math.min(
    configuredTimeout ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
    remainingMs,
  );
  if (effectiveTimeout === configuredTimeout) return context;
  if (configuredTimeout === undefined && effectiveTimeout === DEFAULT_SUBAGENT_TIMEOUT_MS) return context;
  return { ...context, subagentTimeoutMs: effectiveTimeout };
}
