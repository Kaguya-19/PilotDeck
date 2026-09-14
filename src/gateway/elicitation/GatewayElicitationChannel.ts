/**
 * `GatewayElicitationChannel` — bridge between a tool's `askUser()` call and
 * the Gateway's downstream event stream.
 *
 * Flow:
 *   1. `ask_user_question.execute(...)` calls `context.elicitation.askUser`.
 *   2. This channel:
 *        - generates a `requestId`
 *        - registers `(resolve, reject)` in the per-session
 *          `GatewayElicitationBus`
 *        - emits an `elicitation_request` event into the active gateway
 *          stream via `emit(...)`
 *        - awaits the host's `respondElicitation({ requestId, answer })`
 *          which the bus resolves
 *   3. AbortSignal from the request is honored — on abort the entry is
 *      consumed-and-rejected and an `elicitation_cancelled` event is
 *      emitted to clean up the host UI.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   - Single round-trip per `askUser` invocation (E1).
 *   - User can decline → returns `{ type: "cancelled", reason }` (E2).
 *   - Free-form per-question annotations carried verbatim (E3).
 *   - Multi-select answers preserved as `Array<string>` (E4).
 */

import { randomUUID } from "node:crypto";
import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationChannel,
  PilotDeckElicitationRequest,
} from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type { GatewayElicitationBus, GatewayElicitationRegistration } from "./GatewayElicitationBus.js";
import type { GatewayEvent } from "../protocol/types.js";
import { normalizeInteractionTimeout, interactionTimeoutOutcome, toInteractionReplayValue } from "../../interaction/index.js";
import type {
  InteractionDeadlinePolicy,
  InteractionPolicy,
  InteractionPolicyMode,
} from "../../interaction/index.js";

export type GatewayElicitationChannelOptions = {
  sessionKey: string;
  bus: GatewayElicitationBus;
  /**
   * Push a `GatewayEvent` into the active turn's downstream stream. The
   * gateway implementation owns the wiring (queue / fan-in) and just hands
   * us this thin sink.
   */
  emit(event: GatewayEvent): void;
  /** Optional UUID generator (test override). Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  dispatchHook?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
  emitAgentEvent?: (type: "elicitation_requested", payload: { requestId: string; toolName: string }) => void;
  /** Maximum time to wait for a host answer before returning a cancellation. */
  timeoutMs?: number;
  /** Profile-selected deadline provider. Takes precedence over `timeoutMs`. */
  deadlinePolicy?: InteractionDeadlinePolicy;
  policy?: InteractionPolicy;
  policyMode?: InteractionPolicyMode;
  canPrompt?: boolean;
};

export class GatewayElicitationChannel implements PilotDeckElicitationChannel {
  private readonly uuid: () => string;
  private state: "active" | "draining" | "disposed" = "active";
  private readonly pending = new Set<Promise<PilotDeckElicitationAnswer>>();
  private disposePromise?: Promise<void>;

  constructor(private readonly options: GatewayElicitationChannelOptions) {
    this.uuid = options.uuid ?? randomUUID;
  }

  askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer> {
    if (this.state !== "active") {
      return Promise.reject(new Error(`Elicitation channel is ${this.state}.`));
    }
    const requestId = this.uuid();
    const policyDecision = this.options.policy?.decide({
      kind: "question",
      mode: this.options.policyMode ?? "interactive",
      hasAnswerer: true,
      canPrompt: this.options.canPrompt,
    });
    if (policyDecision && policyDecision.outcome !== "ask") {
      return Promise.resolve({ type: "cancelled", reason: policyDecision.reason });
    }
    const { bus, emit, sessionKey } = this.options;

    const result = new Promise<PilotDeckElicitationAnswer>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let registration: GatewayElicitationRegistration | undefined;
      const clearDeadline = (): void => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      const pending = {
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        resolve: (answer: PilotDeckElicitationAnswer) => {
          clearDeadline();
          if (abortHandler && request.signal) {
            request.signal.removeEventListener("abort", abortHandler);
          }
          resolve(answer);
        },
        reject: (error: Error) => {
          clearDeadline();
          if (abortHandler && request.signal) {
            request.signal.removeEventListener("abort", abortHandler);
          }
          reject(error);
        },
      };

      // Reconnect snapshots cross transport boundaries. Keep only the
      // serializable request DTO; in particular, never retain AbortSignal.
      const replayPayload = {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        ...(request.previewFormat !== undefined ? { previewFormat: request.previewFormat } : {}),
        questions: toInteractionReplayValue(request.questions),
        ...(request.metadata !== undefined
          ? { metadata: toInteractionReplayValue(request.metadata) }
          : {}),
      };
      registration = bus.register(sessionKey, pending, { payload: replayPayload });

      // Surface the request downstream so the host (TUI / CLI / Feishu)
      // can render the dialog. The `payload` mirrors the legacy elicitation
      // schema so existing UIs already understand it.
      try {
        emit({
          type: "elicitation_request",
          requestId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          previewFormat: request.previewFormat,
          questions: request.questions,
          metadata: request.metadata,
        });
      } catch (error) {
        const consumed = bus.consume(sessionKey, requestId);
        consumed?.reject(error instanceof Error ? error : new Error(String(error)));
        registration.dispose();
        return;
      }
      // Hooks and live-agent notifications are observers. They must not leave
      // the user question pending if an observer rejects or throws.
      try {
        void Promise.resolve(this.options.dispatchHook?.("Elicitation", {
          requestId,
          toolName: request.toolName,
          toolCallId: request.toolCallId,
        })).catch(() => {});
      } catch {
        // Observer failure is isolated from the host round-trip.
      }
      try {
        this.options.emitAgentEvent?.("elicitation_requested", { requestId, toolName: request.toolName });
      } catch {
        // Observer failure is isolated from the host round-trip.
      }

      const emitCancellation = (reason: string): void => {
        try {
          emit({ type: "elicitation_cancelled", requestId, reason });
        } catch {
          // The request is already terminal; cancellation delivery is best effort.
        }
      };

      if (request.signal) {
        if (request.signal.aborted) {
          // Already-aborted: synthesize a cancelled answer immediately.
          const consumed = bus.consume(sessionKey, requestId);
          consumed?.resolve({ type: "cancelled", reason: "aborted" });
          emitCancellation("aborted");
          return;
        }
        abortHandler = () => {
          const consumed = bus.consume(sessionKey, requestId);
          consumed?.resolve({ type: "cancelled", reason: "aborted" });
          emitCancellation("aborted");
        };
        request.signal.addEventListener("abort", abortHandler, { once: true });
      }
      const timeoutMs = this.options.deadlinePolicy
        ? normalizeInteractionTimeout(this.options.deadlinePolicy.resolve({ kind: "question" }))
        : normalizeInteractionTimeout(this.options.timeoutMs);
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          const consumed = bus.consume(sessionKey, requestId);
          consumed?.resolve({ type: "cancelled", reason: interactionTimeoutOutcome() });
          emitCancellation(interactionTimeoutOutcome());
        }, timeoutMs);
      }
    });
    this.pending.add(result);
    const cleanup = () => {
      this.pending.delete(result);
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async dispose(reason = "elicitation_channel_disposed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state = "draining";
    this.disposePromise = (async () => {
      this.options.bus.rejectSession(this.options.sessionKey, reason);
      await Promise.allSettled([...this.pending]);
      this.state = "disposed";
    })();
    return this.disposePromise;
  }
}
