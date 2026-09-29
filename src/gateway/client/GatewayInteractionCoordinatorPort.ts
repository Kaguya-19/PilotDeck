import type {
  GatewayDisconnectInteractionInput,
  GatewayDisconnectInteractionResult,
  GatewayElicitationResponseInput,
  GatewayPermissionDecisionInput,
  GatewayReconnectInteractionInput,
  GatewayReconnectInteractionResult,
  GatewaySessionPermissionGrantInput,
} from "../protocol/types.js";
import type { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import type { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import type {
  InteractionConnectionBinding,
  InteractionReconnectPort,
} from "../../interaction/index.js";
import type { PermissionRule } from "../../permission/index.js";

/** Live Gateway owner for reconnectable question and permission round-trips. */
export type GatewayInteractionCoordinatorPort = {
  getElicitationBus(): GatewayElicitationBus;
  getPermissionBus(): GatewayPermissionBus;
  getReconnectPort(): InteractionReconnectPort;
  getBinding(sessionKey: string): InteractionConnectionBinding | undefined;
  reconnect(input: GatewayReconnectInteractionInput): GatewayReconnectInteractionResult;
  reconnectForTurn(
    sessionKey: string,
    binding: InteractionConnectionBinding,
  ): GatewayReconnectInteractionResult;
  disconnect(input: GatewayDisconnectInteractionInput): GatewayDisconnectInteractionResult;
  rejectPendingTurn(sessionKey: string, reason: string): void;
  closeSession(sessionKey: string, reason: string): void;
  respondElicitation(input: GatewayElicitationResponseInput): { delivered: boolean };
  decidePermission(input: GatewayPermissionDecisionInput): { delivered: boolean };
  grantSessionPermission(input: GatewaySessionPermissionGrantInput): { granted: boolean; entry?: string };
  sessionAllowRules(sessionKey: string): readonly PermissionRule[];
  dispose(reason: string): void;
};
