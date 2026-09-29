/**
 * In-process pending-request store for elicitation round-trips. Per-session.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   - One bus per session — concurrent tool calls within a session share the
 *     same map.
 *   - Each entry tracks `(resolve, reject, signal-listener)` so an aborted
 *     turn rejects pending askUser() calls instead of leaking them.
 *   - The bus is intentionally untyped about transport: callers (gateway,
 *     channel) own their own event/payload shapes and just use the bus to
 *     bridge promise-resolution.
 */

import type { PilotDeckElicitationAnswer } from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import {
  createNativeInteractionReconnectPort,
  type InteractionConnectionBinding,
  type InteractionPendingRequest,
  type InteractionReconnectPort,
  type InteractionReconnectRegistration,
  type InteractionReconnectResult,
} from "../../interaction/index.js";

export type GatewayElicitationPending = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  resolve(answer: PilotDeckElicitationAnswer): void;
  reject(error: Error): void;
};

export type GatewayElicitationRegistration = {
  /** Whether this pending request is still owned by the bus. */
  readonly active: boolean;
  /** Remove this request without resolving it. */
  dispose(): void;
};

export type GatewayElicitationReconnectOptions = {
  payload?: unknown;
};

/**
 * Per-process registry: one map per `sessionKey`.
 * Singleton lifetime — owned by the `InProcessGateway`.
 */
export class GatewayElicitationBus {
  private readonly bySession = new Map<string, Map<string, GatewayElicitationPending>>();
  private readonly registrations = new WeakMap<object, () => void>();
  private readonly reconnectRegistrations = new WeakMap<object, InteractionReconnectRegistration>();

  constructor(private readonly reconnectPort: InteractionReconnectPort = createNativeInteractionReconnectPort()) {}

  register(
    sessionKey: string,
    entry: GatewayElicitationPending,
    options: GatewayElicitationReconnectOptions = {},
  ): GatewayElicitationRegistration {
    let bucket = this.bySession.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionKey, bucket);
    }
    if (bucket.has(entry.requestId)) {
      throw new Error(`Elicitation request ${entry.requestId} is already pending for session ${sessionKey}.`);
    }
    const reconnectRegistration = this.reconnectPort.register({
      ownerId: sessionKey,
      requestId: entry.requestId,
      kind: "question",
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
    });
    bucket.set(entry.requestId, entry);
    let active = true;
    const deactivate = (): void => {
      active = false;
    };
    this.registrations.set(entry, deactivate);
    this.reconnectRegistrations.set(entry, reconnectRegistration);
    return {
      get active() {
        return active;
      },
      dispose: () => {
        if (!active) return;
        deactivate();
        reconnectRegistration.dispose();
        const current = this.bySession.get(sessionKey);
        if (current?.get(entry.requestId) !== entry) return;
        current.delete(entry.requestId);
        if (current.size === 0) this.bySession.delete(sessionKey);
      },
    };
  }

  /** Returns the matching entry and removes it from the bucket. */
  consume(
    sessionKey: string,
    requestId: string,
    binding?: InteractionConnectionBinding,
  ): GatewayElicitationPending | undefined {
    if (binding && !this.reconnectPort.isCurrent(sessionKey, "question", requestId, binding)) return undefined;
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(requestId);
    if (!entry) return undefined;
    bucket.delete(requestId);
    this.registrations.get(entry)?.();
    this.reconnectRegistrations.get(entry)?.dispose();
    if (bucket.size === 0) this.bySession.delete(sessionKey);
    return entry;
  }

  /** True while a host response is still expected for this request. */
  hasPending(sessionKey: string, requestId: string): boolean {
    return this.bySession.get(sessionKey)?.has(requestId) ?? false;
  }

  /**
   * Reject and drop every pending entry for a session. Called when a turn
   * ends (success / error / abort) so leaked askUser promises are surfaced
   * with a clear reason rather than hanging indefinitely.
   */
  rejectSession(sessionKey: string, reason: string): void {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      this.registrations.get(entry)?.();
      this.reconnectRegistrations.get(entry)?.dispose();
      entry.reject(new Error(reason));
    }
    this.bySession.delete(sessionKey);
  }

  /** For tests / debugging. */
  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }

  hasPendingSession(sessionKey: string): boolean {
    return this.pendingCount(sessionKey) > 0;
  }

  /** Reject every pending host round-trip before the Gateway owner exits. */
  dispose(reason = "gateway_disposed"): void {
    for (const sessionKey of [...this.bySession.keys()]) {
      this.rejectSession(sessionKey, reason);
    }
  }

  reconnect(
    sessionKey: string,
    next: InteractionConnectionBinding,
    previous?: InteractionConnectionBinding,
  ): InteractionReconnectResult {
    return this.reconnectPort.reconnect(sessionKey, next, previous);
  }

  snapshot(sessionKey: string): readonly InteractionPendingRequest[] {
    return this.reconnectPort.snapshot(sessionKey).filter((request) => request.kind === "question");
  }

  disconnect(sessionKey: string, binding: InteractionConnectionBinding): boolean {
    return this.reconnectPort.disconnect(sessionKey, binding);
  }

  currentBinding(sessionKey: string): InteractionConnectionBinding | undefined {
    return this.reconnectPort.currentBinding(sessionKey);
  }
}
