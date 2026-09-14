import type { AgentEventEmitter } from "../agent/protocol/events.js";
import { createDeterministicElicitationAnswerer } from "../agent/modules/interaction/index.js";
import { CommandHookExecutor } from "../extension/hooks/execution/CommandHookExecutor.js";
import { HookRuntime } from "../extension/hooks/execution/HookRuntime.js";
import type { CallbackHookHandler } from "../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookEvent } from "../extension/hooks/protocol/events.js";
import type { PilotDeckHooksSettings } from "../extension/hooks/protocol/settings.js";
import { GatewayElicitationChannel } from "../gateway/elicitation/GatewayElicitationChannel.js";
import type { GatewayElicitationBus } from "../gateway/elicitation/GatewayElicitationBus.js";
import {
  GATEWAY_PERMISSION_CALLBACK_NAME,
  createGatewayPermissionHook,
} from "../gateway/permission/createGatewayPermissionHook.js";
import type { GatewayPermissionBus } from "../gateway/permission/GatewayPermissionBus.js";
import type { GatewayEvent } from "../gateway/protocol/types.js";
import {
  createDefaultInteractionPolicy,
  createProfiledPermissionDecisionPort,
  createStaticInteractionDeadlinePolicy,
  type InteractionDeadlinePolicy,
  type InteractionPolicy,
  type InteractionProfile,
  type InteractionReconnectPort,
} from "../interaction/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import { PermissionRuntime, type PermissionDecisionPort, type PermissionRule } from "../permission/index.js";
import {
  createElicitationChannelFromAnswerer,
  type PilotDeckElicitationChannel,
  type ShellPort,
} from "../tool/index.js";

/** Narrow Gateway surface consumed by session interaction composition. */
export type GatewaySessionInteractionFacade = Readonly<{
  permissionBus: GatewayPermissionBus;
  elicitationBus: GatewayElicitationBus;
  interactionReconnect: InteractionReconnectPort;
  emit(event: GatewayEvent): boolean;
}>;

/** The only scope effect owned by this bundle is the permission callback registration. */
export type SessionInteractionScope = {
  own(dispose: () => void | Promise<void>): unknown;
};

export type SessionInteractionBundleOptions = {
  sessionKey: string;
  profile: InteractionProfile;
  canPrompt: boolean;
  /** The live allow array shared with PermissionContext for this session. */
  permissionRules: PermissionRule[];
  hookSettings: PilotDeckHooksSettings;
  shell: ShellPort;
  projectRoot: string;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
  eventEmitter?: AgentEventEmitter;
  gateway?: GatewaySessionInteractionFacade;
};

/**
 * Composes session-scoped interaction providers without taking ownership of
 * Gateway pending entries, reconnect state, permission rule storage, or
 * durable interaction audit. Those state owners remain unchanged.
 */
export class SessionInteractionBundle {
  readonly policy: InteractionPolicy;
  readonly deadlinePolicy: InteractionDeadlinePolicy;
  readonly permission: PermissionDecisionPort;
  readonly lifecycle: LifecycleRuntime;
  readonly elicitation?: PilotDeckElicitationChannel;
  readonly ownedElicitation: boolean;
  readonly interactionReconnect?: InteractionReconnectPort;

  private readonly hookRuntime: HookRuntime;
  private readonly gatewayPermissionCallback?: CallbackHookHandler;
  private attached = false;

  constructor(private readonly options: SessionInteractionBundleOptions) {
    this.policy = createDefaultInteractionPolicy();
    this.deadlinePolicy = createStaticInteractionDeadlinePolicy({
      permissionTimeoutMs: options.permissionTimeoutMs,
      questionTimeoutMs: options.questionTimeoutMs,
    });

    const hasGatewayPermissionAnswerer = Boolean(
      options.gateway
      && options.profile.permissionProvider === "gateway"
      && options.canPrompt,
    );
    this.permission = createProfiledPermissionDecisionPort(new PermissionRuntime(), {
      policy: this.policy,
      mode: options.profile.policyMode,
      hasAnswerer: hasGatewayPermissionAnswerer,
      canPrompt: options.canPrompt,
    });

    const hookSettings: PilotDeckHooksSettings = hasGatewayPermissionAnswerer
      ? {
          ...options.hookSettings,
          PermissionRequest: [
            ...(options.hookSettings.PermissionRequest ?? []),
            { hooks: [{ type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME }] },
          ],
        }
      : options.hookSettings;
    this.hookRuntime = new HookRuntime(hookSettings, new CommandHookExecutor(options.shell));
    this.lifecycle = new LifecycleRuntime(this.hookRuntime);

    if (options.gateway && hasGatewayPermissionAnswerer) {
      this.gatewayPermissionCallback = createGatewayPermissionHook({
        sessionKey: options.sessionKey,
        bus: options.gateway.permissionBus,
        emit: (event) => options.gateway!.emit(event),
        permissionRules: options.permissionRules,
        deadlinePolicy: this.deadlinePolicy,
        policy: this.policy,
        policyMode: options.profile.policyMode,
        canPrompt: options.canPrompt,
      });
    }

    if (options.profile.questionProvider === "deterministic") {
      this.elicitation = createElicitationChannelFromAnswerer(createDeterministicElicitationAnswerer(), {
        policy: this.policy,
        policyMode: options.profile.policyMode,
        canPrompt: options.canPrompt,
      });
    } else if (options.profile.questionProvider === "gateway" && options.gateway) {
      this.elicitation = new GatewayElicitationChannel({
        sessionKey: options.sessionKey,
        bus: options.gateway.elicitationBus,
        emit: (event) => options.gateway!.emit(event),
        dispatchHook: (hookEvent, payload) => {
          this.lifecycle.dispatch({
            event: hookEvent as PilotDeckHookEvent,
            baseInput: { sessionId: options.sessionKey, transcriptPath: "", cwd: options.projectRoot },
            payload,
            matchQuery: hookEvent,
          }).catch(() => {});
        },
        emitAgentEvent: (_type, payload) => {
          options.eventEmitter?.({
            type: "elicitation_requested",
            sessionId: options.sessionKey,
            turnId: "",
            requestId: payload.requestId,
            toolName: payload.toolName,
          });
        },
        deadlinePolicy: this.deadlinePolicy,
        policy: this.policy,
        policyMode: options.profile.policyMode,
        canPrompt: options.canPrompt,
      });
    }
    this.ownedElicitation = this.elicitation !== undefined;
    if (options.gateway && (options.profile.questionProvider === "gateway" || hasGatewayPermissionAnswerer)) {
      this.interactionReconnect = options.gateway.interactionReconnect;
    }
  }

  /**
   * Registers the optional Gateway permission callback at the exact Agent
   * scope. A failing scope ownership operation immediately rolls registration
   * back, leaving no callback able to create future Gateway pending entries.
   */
  attach(scope: SessionInteractionScope): void {
    if (this.attached) {
      throw new Error("SessionInteractionBundle is already attached.");
    }
    if (!this.gatewayPermissionCallback) {
      this.attached = true;
      return;
    }

    const registration = this.hookRuntime.getCallbackExecutor().register(
      GATEWAY_PERMISSION_CALLBACK_NAME,
      this.gatewayPermissionCallback,
    );
    try {
      scope.own(() => registration.dispose());
      this.attached = true;
    } catch (error) {
      registration.dispose();
      throw error;
    }
  }
}
