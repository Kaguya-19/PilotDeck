import { randomUUID } from "node:crypto";
import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookSyncOutput } from "../../extension/hooks/protocol/output.js";
import type { PermissionRule } from "../../permission/protocol/types.js";
import type { GatewayEvent } from "../protocol/types.js";
import type {
  GatewayPermissionBus,
  GatewayPermissionDecision,
  GatewayPermissionRegistration,
} from "./GatewayPermissionBus.js";
import { normalizeInteractionTimeout, interactionTimeoutOutcome, toInteractionReplayValue } from "../../interaction/index.js";
import type {
  InteractionDeadlinePolicy,
  InteractionPolicy,
  InteractionPolicyMode,
} from "../../interaction/index.js";

export const GATEWAY_PERMISSION_CALLBACK_NAME = "pilotdeck.gateway.permission";

export type CreateGatewayPermissionHookOptions = {
  /** PilotDeck session this hook owns. Used to scope bus pending entries. */
  sessionKey: string;
  /** Shared permission bus where decisions arrive from the Web UI. */
  bus: GatewayPermissionBus;
  /**
   * Pump a {@link GatewayEvent} into the active `submitTurn` stream so the
   * Web UI sees a `permission_request` event and can show a banner.
   * Returns true when the event was delivered, false when no active turn
   * sink exists (in which case the hook auto-denies — there's nowhere to
   * surface the prompt).
   */
  emit: (event: GatewayEvent) => boolean;
  /**
   * Live `permissionRules.allow` array shared with the session's
   * `PermissionContext`. When the user grants with `remember=true` the
   * hook pushes a session-scoped allow rule here so subsequent calls to
   * the same tool inside this session short-circuit the ask path.
   */
  permissionRules: PermissionRule[];
  /** Inject a deterministic UUID for tests. */
  uuid?: () => string;
  /**
   * Maximum time to wait for a host decision. A timeout is converted to a
   * deterministic deny so a missing UI can never leave the tool hanging or
   * accidentally execute a side effect.
  */
  timeoutMs?: number;
  /** Profile-selected deadline provider. Takes precedence over `timeoutMs`. */
  deadlinePolicy?: InteractionDeadlinePolicy;
  /** Optional profile policy; omitted keeps the legacy interactive behavior. */
  policy?: InteractionPolicy;
  policyMode?: InteractionPolicyMode;
  canPrompt?: boolean;
};

/**
 * Build a callback hook handler that bridges the agent's PermissionRequest
 * lifecycle event to the Web UI's permission banner. The full round-trip:
 *
 *   1. `ToolRuntime.runTool()` decides `ask` for an un-whitelisted tool.
 *   2. `dispatchLifecycle("PermissionRequest", ...)` runs the registered
 *      callback hook (this handler).
 *   3. Handler emits a `permission_request` GatewayEvent into the
 *      active `submitTurn` queue, mints a `requestId`, and parks itself
 *      on a Promise registered with the GatewayPermissionBus.
 *   4. The Web UI's banner fires `permissionDecide(requestId, allow/deny,
 *      remember)`, which the gateway routes to `bus.consume(...)`, which
 *      resolves the Promise.
 *   5. If `decision.remember && allow`, push a session-scoped allow rule
 *      into the shared `permissionRules` array so the live
 *      PermissionContext picks it up on the very next decide() call —
 *      no need to wait for the next turn to re-sync from the frontend.
 *   6. Return a hook output containing `specific.decision`, which the
 *      HookRuntime turns into a `permission_request_result` effect that
 *      ToolRuntime maps back into an allow/deny final decision.
 *
 * If there's no active submit-turn sink for the session (which would
 * mean nobody can see the banner), the hook denies immediately — better
 * a clean denial than a silent hang.
 */
export function createGatewayPermissionHook(
  options: CreateGatewayPermissionHookOptions,
): CallbackHookHandler {
  return async ({ hookInput, signal }) => {
    const toolName = typeof hookInput.toolName === "string" ? hookInput.toolName : "UnknownTool";
    const toolCallId = typeof hookInput.toolCallId === "string"
      ? hookInput.toolCallId
      : typeof hookInput.toolUseId === "string"
        ? hookInput.toolUseId
        : "";
    const payload = "toolInput" in hookInput
      ? hookInput.toolInput
      : "input" in hookInput
        ? hookInput.input
        : {};
    const requestId = options.uuid ? options.uuid() : randomUUID();
    const deny = (message: string): PilotDeckHookSyncOutput => ({
      type: "sync",
      specific: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message },
      },
    });

    const policyDecision = options.policy?.decide({
      kind: "permission",
      mode: options.policyMode ?? "interactive",
      hasAnswerer: true,
      canPrompt: options.canPrompt,
    });
    if (policyDecision && policyDecision.outcome !== "ask") {
      return deny(policyDecision.reason);
    }

    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let registration: GatewayPermissionRegistration | undefined;
    const decision = await new Promise<GatewayPermissionDecision>((resolve, reject) => {
      registration = options.bus.register(options.sessionKey, {
        requestId,
        toolCallId,
        toolName,
        resolve,
        reject,
      }, {
        payload: toInteractionReplayValue({ toolName, toolCallId, payload }),
      });
      const settle = (value: GatewayPermissionDecision): void => {
        const pending = options.bus.consume(options.sessionKey, requestId);
        if (pending) pending.resolve(value);
      };
      if (signal) {
        if (signal.aborted) {
          settle({ requestId, decision: "deny", reason: "Permission prompt cancelled." });
          return;
        }
        onAbort = () => settle({ requestId, decision: "deny", reason: "Permission prompt cancelled." });
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timeoutMs = options.deadlinePolicy
        ? normalizeInteractionTimeout(options.deadlinePolicy.resolve({ kind: "permission" }))
        : normalizeInteractionTimeout(options.timeoutMs);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle({ requestId, decision: "deny", reason: "Permission prompt timed out.", outcome: interactionTimeoutOutcome() });
        }, timeoutMs);
      }
      try {
        const delivered = options.emit({
          type: "permission_request",
          requestId,
          toolName,
          payload,
        });
        if (!delivered) {
          settle({ requestId, decision: "deny", reason: "Permission prompt could not be delivered to the Web UI." });
        }
      } catch (error) {
        settle({
          requestId,
          decision: "deny",
          reason: `Permission prompt delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }).finally(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      registration?.dispose();
    });

    if (decision.decision === "allow" && decision.remember) {
      // Mutate the live array shared with PermissionContext.rules.allow
      // so the next tool.checkPermissions() / decide() in this same turn
      // walks the allow branch instead of asking again.
      const rules = extractSessionAllowRules(hookInput.permissionSuggestions, toolName);
      const rulesToRemember = rules.length > 0
        ? rules
        : [{ source: "session" as const, behavior: "allow" as const, toolName }];

      for (const rule of rulesToRemember) {
        const alreadyAllowed = options.permissionRules.some(
          (existing) =>
            existing.behavior === "allow"
            && existing.toolName === rule.toolName
            && existing.pattern === rule.pattern,
        );
        if (!alreadyAllowed) {
          options.permissionRules.push(rule);
        }
      }
    }

    return decision.decision === "allow"
      ? {
          type: "sync",
          specific: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        } satisfies PilotDeckHookSyncOutput
      : deny(decision.reason ?? "Permission prompt denied.");
  };
}

function extractSessionAllowRules(value: unknown, fallbackToolName: string): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const allowSession = value.find((option) =>
    isRecord(option) && option.id === "allow_session" && Array.isArray(option.rules)
  );
  if (!isRecord(allowSession) || !Array.isArray(allowSession.rules)) return [];

  return allowSession.rules.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const toolName = typeof candidate.toolName === "string" && candidate.toolName
      ? candidate.toolName
      : fallbackToolName;
    if (!toolName) return [];
    return [{
      source: "session" as const,
      behavior: "allow" as const,
      toolName,
      ...(typeof candidate.pattern === "string" && candidate.pattern ? { pattern: candidate.pattern } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
