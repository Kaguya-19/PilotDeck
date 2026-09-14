import {
  createNativeInteractionReconnectPort,
  type InteractionConnectionBinding,
  type InteractionReconnectPort,
} from "../../interaction/index.js";
import { permissionEntryToRule } from "../../permission/index.js";
import { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import {
  GatewaySessionPermissionRuleSetRegistry,
  type GatewaySessionPermissionGrantPort,
} from "../permission/GatewaySessionPermissionRuleSetRegistry.js";
import type {
  GatewayDisconnectInteractionInput,
  GatewayDisconnectInteractionResult,
  GatewayElicitationResponseInput,
  GatewayPermissionDecisionInput,
  GatewayReconnectInteractionInput,
  GatewayReconnectInteractionResult,
  GatewaySessionPermissionGrantInput,
} from "../protocol/types.js";
import type { GatewayInteractionCoordinatorPort } from "./GatewayInteractionCoordinatorPort.js";

export type GatewayInteractionCoordinatorOptions = {
  reconnectPort?: InteractionReconnectPort;
  elicitationBus?: GatewayElicitationBus;
  permissionBus?: GatewayPermissionBus;
  permissionGrants?: GatewaySessionPermissionGrantPort;
  onElicitationDelivered?: (sessionKey: string, requestId: string) => void;
};

/**
 * Native owner for live, reconnectable Gateway interactions.
 *
 * Durable permission rules remain in the supplied session grant provider;
 * Router/Agent lifecycle remains with the Gateway host. This coordinator only
 * settles and cleans up the volatile host round-trips tied to those owners.
 */
export class GatewayInteractionCoordinator implements GatewayInteractionCoordinatorPort {
  private readonly reconnectPort: InteractionReconnectPort;
  private readonly elicitationBus: GatewayElicitationBus;
  private readonly permissionBus: GatewayPermissionBus;
  private readonly permissionGrants: GatewaySessionPermissionGrantPort;

  constructor(private readonly options: GatewayInteractionCoordinatorOptions = {}) {
    this.reconnectPort = options.reconnectPort ?? createNativeInteractionReconnectPort();
    this.elicitationBus = options.elicitationBus ?? new GatewayElicitationBus(this.reconnectPort);
    this.permissionBus = options.permissionBus ?? new GatewayPermissionBus(this.reconnectPort);
    this.permissionGrants = options.permissionGrants ?? new GatewaySessionPermissionRuleSetRegistry();
  }

  getElicitationBus(): GatewayElicitationBus {
    return this.elicitationBus;
  }

  getPermissionBus(): GatewayPermissionBus {
    return this.permissionBus;
  }

  getReconnectPort(): InteractionReconnectPort {
    return this.reconnectPort;
  }

  getBinding(sessionKey: string): InteractionConnectionBinding | undefined {
    return this.reconnectPort.currentBinding(sessionKey);
  }

  reconnect(input: GatewayReconnectInteractionInput): GatewayReconnectInteractionResult {
    if (!input.nextBinding) {
      return { outcome: "stale_binding", requests: [] };
    }
    return this.reconnectPort.reconnect(input.sessionKey, input.nextBinding, input.previousBinding);
  }

  reconnectForTurn(
    sessionKey: string,
    binding: InteractionConnectionBinding,
  ): GatewayReconnectInteractionResult {
    const currentBinding = this.reconnectPort.currentBinding(sessionKey);
    if (currentBinding && currentBinding.connectionId !== binding.connectionId) {
      return { outcome: "stale_binding", requests: [] };
    }
    return this.reconnectPort.reconnect(sessionKey, binding, currentBinding);
  }

  disconnect(input: GatewayDisconnectInteractionInput): GatewayDisconnectInteractionResult {
    const disconnected = this.reconnectPort.disconnect(input.sessionKey, input.binding);
    return {
      disconnected,
      preserveTurn: disconnected && (
        this.elicitationBus.hasPendingSession(input.sessionKey)
        || this.permissionBus.hasPendingSession(input.sessionKey)
      ),
    };
  }

  rejectPendingTurn(sessionKey: string, reason: string): void {
    this.elicitationBus.rejectSession(sessionKey, reason);
    this.permissionBus.denySession(sessionKey, reason);
  }

  closeSession(sessionKey: string, reason: string): void {
    this.rejectPendingTurn(sessionKey, reason);
    this.reconnectPort.disposeOwner(sessionKey);
    this.permissionGrants.closeSession(sessionKey);
  }

  respondElicitation(input: GatewayElicitationResponseInput): { delivered: boolean } {
    const entry = this.elicitationBus.consume(input.sessionKey, input.requestId, input.interactionBinding);
    if (!entry) return { delivered: false };
    entry.resolve(input.answer);
    this.options.onElicitationDelivered?.(input.sessionKey, input.requestId);
    return { delivered: true };
  }

  decidePermission(input: GatewayPermissionDecisionInput): { delivered: boolean } {
    const entry = this.permissionBus.consume(input.sessionKey, input.requestId, input.interactionBinding);
    if (!entry) return { delivered: false };
    entry.resolve({
      requestId: input.requestId,
      decision: input.decision,
      remember: input.remember,
      reason: input.reason,
    });
    return { delivered: true };
  }

  grantSessionPermission(input: GatewaySessionPermissionGrantInput): { granted: boolean; entry?: string } {
    const rule = permissionEntryToRule(input.entry, "allow", "session");
    if (!rule.toolName) return { granted: false };
    this.permissionGrants.grant(input.sessionKey, rule);
    return { granted: true, entry: input.entry };
  }

  sessionAllowRules(sessionKey: string) {
    return this.permissionGrants.allowRules(sessionKey);
  }

  dispose(reason: string): void {
    this.permissionGrants.dispose();
    this.elicitationBus.dispose(reason);
    this.permissionBus.dispose(reason);
    this.reconnectPort.dispose();
  }
}
