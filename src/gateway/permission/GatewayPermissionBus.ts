/**
 * In-process pending-request store for Web permission round-trips.
 *
 * Mirrors {@link import("../elicitation/GatewayElicitationBus.js").GatewayElicitationBus}
 * but for `permission_request` events: a tool that needs UI confirmation
 * registers a pending entry; the Web UI eventually calls
 * `Gateway.permissionDecide({ requestId, decision })` and the bus resolves.
 *
 * One bus per process, keyed by `sessionKey`. Pending entries are dropped
 * (rejected) when the turn ends so leaked promises do not hang.
 */

import {
  createNativeInteractionReconnectPort,
  type InteractionConnectionBinding,
  type InteractionPendingRequest,
  type InteractionReconnectPort,
  type InteractionReconnectRegistration,
  type InteractionReconnectResult,
} from "../../interaction/index.js";

export type GatewayPermissionDecision = {
  requestId: string;
  decision: "allow" | "deny";
  remember?: boolean;
  reason?: string;
  /** Host-independent terminal classification; wire consumers may ignore it. */
  outcome?: "allow" | "deny" | "cancel" | "timeout" | "reconnect" | "failed" | "result_unknown";
};

export type GatewayPermissionPending = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  resolve(decision: GatewayPermissionDecision): void;
  reject(error: Error): void;
};

export type GatewayPermissionRegistration = {
  /** Whether this pending request is still owned by the bus. */
  readonly active: boolean;
  /** Remove the request without resolving it (used by an aborted hook). */
  dispose(): void;
};

export class GatewayPermissionBus {
  private readonly bySession = new Map<string, Map<string, GatewayPermissionPending>>();
  private readonly registrations = new WeakMap<object, () => void>();
  private readonly reconnectRegistrations = new WeakMap<object, InteractionReconnectRegistration>();

  constructor(private readonly reconnectPort: InteractionReconnectPort = createNativeInteractionReconnectPort()) {}

  register(
    sessionKey: string,
    entry: GatewayPermissionPending,
    options: { payload?: unknown } = {},
  ): GatewayPermissionRegistration {
    let bucket = this.bySession.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionKey, bucket);
    }
    if (bucket.has(entry.requestId)) {
      throw new Error(`Permission request ${entry.requestId} is already pending for session ${sessionKey}.`);
    }
    const reconnectRegistration = this.reconnectPort.register({
      ownerId: sessionKey,
      requestId: entry.requestId,
      kind: "permission",
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

  consume(
    sessionKey: string,
    requestId: string,
    binding?: InteractionConnectionBinding,
  ): GatewayPermissionPending | undefined {
    if (binding && !this.reconnectPort.isCurrent(sessionKey, "permission", requestId, binding)) return undefined;
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

  hasPending(sessionKey: string, requestId: string): boolean {
    return this.bySession.get(sessionKey)?.has(requestId) ?? false;
  }

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

  /**
   * Close every pending permission as a deterministic deny. Permission
   * requests guard side effects, so session/turn teardown must not surface as
   * an unresolved ask or leave the callback waiting for a host that is gone.
   */
  denySession(sessionKey: string, reason: string): void {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return;
    this.bySession.delete(sessionKey);
    for (const entry of bucket.values()) {
      this.registrations.get(entry)?.();
      this.reconnectRegistrations.get(entry)?.dispose();
      entry.resolve({ requestId: entry.requestId, decision: "deny", reason });
    }
  }

  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }

  hasPendingSession(sessionKey: string): boolean {
    return this.pendingCount(sessionKey) > 0;
  }

  /** Resolve every pending approval as a deny before the Gateway owner exits. */
  dispose(reason = "gateway_disposed"): void {
    for (const sessionKey of [...this.bySession.keys()]) {
      this.denySession(sessionKey, reason);
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
    return this.reconnectPort.snapshot(sessionKey).filter((request) => request.kind === "permission");
  }

  disconnect(sessionKey: string, binding: InteractionConnectionBinding): boolean {
    return this.reconnectPort.disconnect(sessionKey, binding);
  }

  currentBinding(sessionKey: string): InteractionConnectionBinding | undefined {
    return this.reconnectPort.currentBinding(sessionKey);
  }
}
