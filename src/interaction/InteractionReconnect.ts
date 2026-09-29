import type { InteractionRequestKind } from "./InteractionContract.js";
import { toInteractionReplayValue } from "./InteractionReplay.js";

/**
 * Transport-independent identity for one host connection.  A generation is
 * monotonic within one owner and prevents a late response from an old
 * connection from being mistaken for a response on the new connection.
 */
export type InteractionConnectionBinding = Readonly<{
  connectionId: string;
  generation: number;
}>;

export type InteractionPendingRequest = Readonly<{
  ownerId: string;
  requestId: string;
  kind: InteractionRequestKind;
  toolCallId?: string;
  toolName?: string;
  /** Adapter-owned, JSON-shaped replay payload; the port never interprets it. */
  payload?: unknown;
  binding?: InteractionConnectionBinding;
}>;

export type InteractionReconnectRegistration = {
  readonly active: boolean;
  /** Bind a pending request to the current connection, if it is still live. */
  bind(binding: InteractionConnectionBinding): boolean;
  dispose(): void;
};

export type InteractionReconnectResult = {
  outcome: "initial" | "reconnected" | "stale_binding" | "no_pending";
  binding?: InteractionConnectionBinding;
  requests: readonly InteractionPendingRequest[];
};

export type InteractionReconnectPort = {
  /**
   * Attach an owner to a new connection.  Once an owner has a binding,
   * reconnect must present the exact previous binding; otherwise the call is
   * rejected as stale and pending requests are not replayed.
   */
  reconnect(
    ownerId: string,
    next: InteractionConnectionBinding,
    previous?: InteractionConnectionBinding,
  ): InteractionReconnectResult;
  register(request: Omit<InteractionPendingRequest, "binding">): InteractionReconnectRegistration;
  snapshot(ownerId: string): readonly InteractionPendingRequest[];
  isCurrent(
    ownerId: string,
    kind: InteractionRequestKind,
    requestId: string,
    binding?: InteractionConnectionBinding,
  ): boolean;
  /** Mark a connection gone without settling its pending requests. */
  disconnect(ownerId: string, binding: InteractionConnectionBinding): boolean;
  currentBinding(ownerId: string): InteractionConnectionBinding | undefined;
  /** Drop all pending state for one session/agent owner. */
  disposeOwner(ownerId: string): void;
  /** Drop all state owned by the provider itself. */
  dispose(): void;
};

/** Native in-memory provider used by Gateway and direct adapters. */
export function createNativeInteractionReconnectPort(): InteractionReconnectPort {
  const pending = new Map<string, Map<string, StoredPendingRequest>>();
  const bindings = new Map<string, InteractionConnectionBinding>();
  const lastBindings = new Map<string, InteractionConnectionBinding>();

  function normalizeBinding(binding: InteractionConnectionBinding): InteractionConnectionBinding {
    if (!binding || typeof binding.connectionId !== "string" || binding.connectionId.length === 0) {
      throw new Error("Interaction connectionId must be a non-empty string.");
    }
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 0) {
      throw new Error("Interaction connection generation must be a non-negative safe integer.");
    }
    return Object.freeze({
      connectionId: binding.connectionId,
      generation: binding.generation,
    });
  }

  function sameBinding(left: InteractionConnectionBinding | undefined, right: InteractionConnectionBinding | undefined): boolean {
    return left?.connectionId === right?.connectionId && left?.generation === right?.generation;
  }

  function requestKey(kind: InteractionRequestKind, requestId: string): string {
    return `${kind}\u0000${requestId}`;
  }

  function remove(ownerId: string, key: string, request: StoredPendingRequest): void {
    const bucket = pending.get(ownerId);
    if (bucket?.get(key) !== request) return;
    bucket.delete(key);
    if (bucket.size === 0) {
      pending.delete(ownerId);
      // A disconnected owner with no replayable request no longer needs to
      // prove its previous binding before starting a later, unrelated turn.
      if (!bindings.has(ownerId)) lastBindings.delete(ownerId);
    }
  }

  return {
    reconnect(ownerId, nextInput, previousInput) {
      const next = normalizeBinding(nextInput);
      const current = bindings.get(ownerId);
      const last = current ?? lastBindings.get(ownerId);
      if (current && sameBinding(current, next) && (!previousInput || sameBinding(current, previousInput))) {
        return {
          outcome: "reconnected",
          binding: current,
          requests: [...(pending.get(ownerId)?.values() ?? [])].map(freezeSnapshot),
        };
      }
      if (last && (!previousInput || !sameBinding(last, previousInput))) {
        return { outcome: "stale_binding", binding: current ?? last, requests: [] };
      }
      if (!last && previousInput) {
        return { outcome: "stale_binding", requests: [] };
      }
      if (last && next.generation <= last.generation) {
        return { outcome: "stale_binding", binding: current ?? last, requests: [] };
      }
      bindings.set(ownerId, next);
      lastBindings.set(ownerId, next);
      const requests = [...(pending.get(ownerId)?.values() ?? [])].map((request) => {
        request.binding = next;
        return freezeSnapshot(request);
      });
      return {
        outcome: last ? "reconnected" : requests.length > 0 ? "initial" : "no_pending",
        binding: next,
        requests,
      };
    },

    register(input) {
      if (!input.ownerId || !input.requestId) {
        throw new Error("Interaction pending request requires ownerId and requestId.");
      }
      const key = requestKey(input.kind, input.requestId);
      let bucket = pending.get(input.ownerId);
      if (!bucket) {
        bucket = new Map();
        pending.set(input.ownerId, bucket);
      }
      if (bucket.has(key)) {
        throw new Error(`Interaction request ${input.requestId} is already pending for ${input.ownerId}.`);
      }
      const { payload: inputPayload, ...request } = input;
      const payload = inputPayload === undefined ? undefined : toInteractionReplayValue(inputPayload);
      const stored: StoredPendingRequest = {
        ...request,
        ...(payload !== undefined ? { payload } : {}),
        ...(bindings.get(input.ownerId) ? { binding: bindings.get(input.ownerId) } : {}),
      };
      bucket.set(key, stored);
      let active = true;
      return {
        get active() { return active; },
        bind(bindingInput) {
          if (!active) return false;
          const binding = normalizeBinding(bindingInput);
          if (!sameBinding(bindings.get(input.ownerId), binding)) return false;
          stored.binding = binding;
          return true;
        },
        dispose() {
          if (!active) return;
          active = false;
          remove(input.ownerId, key, stored);
        },
      };
    },

    snapshot(ownerId) {
      return [...(pending.get(ownerId)?.values() ?? [])].map(freezeSnapshot);
    },

    isCurrent(ownerId, kind, requestId, binding) {
      const request = pending.get(ownerId)?.get(requestKey(kind, requestId));
      if (!request) return false;
      if (!binding) return true;
      return sameBinding(bindings.get(ownerId), binding) && sameBinding(request.binding, binding);
    },

    disconnect(ownerId, bindingInput) {
      const binding = normalizeBinding(bindingInput);
      const current = bindings.get(ownerId);
      if (!sameBinding(current, binding)) return false;
      bindings.delete(ownerId);
      for (const request of pending.get(ownerId)?.values() ?? []) request.binding = undefined;
      if (!pending.has(ownerId)) lastBindings.delete(ownerId);
      return true;
    },

    currentBinding(ownerId) {
      return bindings.get(ownerId);
    },

    disposeOwner(ownerId) {
      pending.delete(ownerId);
      bindings.delete(ownerId);
      lastBindings.delete(ownerId);
    },

    dispose() {
      pending.clear();
      bindings.clear();
      lastBindings.clear();
    },
  };
}

type StoredPendingRequest = {
  ownerId: string;
  requestId: string;
  kind: InteractionRequestKind;
  toolCallId?: string;
  toolName?: string;
  payload?: unknown;
  binding?: InteractionConnectionBinding;
};

function freezeSnapshot(request: StoredPendingRequest): InteractionPendingRequest {
  return Object.freeze({
    ownerId: request.ownerId,
    requestId: request.requestId,
    kind: request.kind,
    ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    ...(request.toolName !== undefined ? { toolName: request.toolName } : {}),
    ...(request.payload !== undefined ? { payload: request.payload } : {}),
    ...(request.binding ? { binding: request.binding } : {}),
  });
}
