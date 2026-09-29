import type { AgentEventEmitter } from "../agent/protocol/events.js";
import { createDeterministicElicitationAnswerer } from "../agent/modules/interaction/index.js";
import { CommandHookExecutor } from "../extension/hooks/execution/CommandHookExecutor.js";
import { HookRuntime } from "../extension/hooks/execution/HookRuntime.js";
import type { CallbackHookHandler } from "../extension/hooks/execution/CallbackHookExecutor.js";
import { HookExecutionEventBus } from "../extension/hooks/events/HookExecutionEventBus.js";
import { isPilotDeckHookEvent, type PilotDeckHookEvent } from "../extension/hooks/protocol/events.js";
import type { PilotDeckHooksSettings } from "../extension/hooks/protocol/settings.js";
import { GatewayElicitationChannel } from "../gateway/elicitation/GatewayElicitationChannel.js";
import type { GatewayElicitationBus } from "../gateway/elicitation/GatewayElicitationBus.js";
import type { GatewayUserDialogBus } from "../gateway/user-dialog/GatewayUserDialogBus.js";
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
  type PilotDeckFileUpdateNotifier,
  type PilotDeckElicitationChannel,
  type ShellPort,
} from "../tool/index.js";

/** Narrow Gateway surface consumed by session interaction composition. */
export type GatewaySessionInteractionFacade = Readonly<{
  permissionBus: GatewayPermissionBus;
  elicitationBus: GatewayElicitationBus;
  userDialogBus?: GatewayUserDialogBus;
  interactionReconnect: InteractionReconnectPort;
  emit(event: GatewayEvent): boolean;
  registerAsyncHook?(input: {
    hookName: string;
    hookEvent: string;
    invocationId: string;
    timeoutMs?: number;
    includeHookEvents: boolean;
  }): void;
  registerConfigChangeHandler?(handler: (payload: {
    changedPaths: string[];
    changeClasses: string[];
  }) => void): () => void;
  registerSessionHookHandler?(handler: (
    event: PilotDeckHookEvent,
    payload: Record<string, unknown>,
  ) => void): () => void;
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
  sdkHooks?: {
    url: string;
    headers?: Record<string, string>;
    events: Partial<Record<string, Array<{ matcher?: string; timeout?: number }>>>;
  };
  includeHookEvents?: boolean;
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
  readonly fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  readonly ownedElicitation: boolean;
  readonly interactionReconnect?: InteractionReconnectPort;

  private readonly hookRuntime: HookRuntime;
  private readonly configChangeLifecycle?: LifecycleRuntime;
  private readonly fileChangedLifecycle?: LifecycleRuntime;
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

    const sdkHookSettings = createSdkHookSettings(options.sdkHooks);
    const {
      ConfigChange: sdkConfigChangeHooks,
      FileChanged: sdkFileChangedHooks,
      ...sdkAgentLoopHookSettings
    } = sdkHookSettings;
    const mergedHookSettings = mergeHookSettings(options.hookSettings, sdkAgentLoopHookSettings);
    const hookSettings: PilotDeckHooksSettings = hasGatewayPermissionAnswerer
      ? {
          ...mergedHookSettings,
          PermissionRequest: [
            ...(mergedHookSettings.PermissionRequest ?? []),
            { hooks: [{ type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME }] },
          ],
        }
      : mergedHookSettings;
    const hookEventBus = new HookExecutionEventBus();
    const gatewayAsyncHookRegistration = options.gateway?.registerAsyncHook;
    const registerAsyncHook = gatewayAsyncHookRegistration && options.sdkHooks
      ? (registration: {
          hookName: string;
          hookEvent: PilotDeckHookEvent;
          invocationId: string;
          timeoutMs?: number;
        }) => gatewayAsyncHookRegistration({
          ...registration,
          includeHookEvents: options.includeHookEvents === true,
        })
      : undefined;
    this.hookRuntime = new HookRuntime(
      hookSettings,
      new CommandHookExecutor(options.shell),
      hookEventBus,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registerAsyncHook,
    );
    this.lifecycle = new LifecycleRuntime(this.hookRuntime);
    this.configChangeLifecycle = sdkConfigChangeHooks?.length
      ? new LifecycleRuntime(new HookRuntime(
          { ConfigChange: sdkConfigChangeHooks },
          new CommandHookExecutor(options.shell),
          hookEventBus,
        ))
      : undefined;
    this.fileChangedLifecycle = sdkFileChangedHooks?.length
      ? new LifecycleRuntime(new HookRuntime(
          { FileChanged: sdkFileChangedHooks },
          new CommandHookExecutor(options.shell),
          hookEventBus,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          registerAsyncHook,
        ))
      : undefined;
    if (this.fileChangedLifecycle) {
      this.fileUpdateNotifier = {
        didSave: async (update) => {
          await this.fileChangedLifecycle!.dispatch({
            event: "FileChanged",
            baseInput: {
              sessionId: options.sessionKey,
              transcriptPath: "",
              cwd: options.projectRoot,
            },
            payload: {
              filePath: update.relativePath,
              absolutePath: update.absolutePath,
              root: update.root,
              changeType: update.previousContent === null ? "created" : "updated",
            },
            matchQuery: update.relativePath,
          }).catch(() => {});
        },
      };
    }

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
    const disposers: Array<() => void | Promise<void>> = [];
    try {
      if (this.gatewayPermissionCallback) {
        const registration = this.hookRuntime.getCallbackExecutor().register(
          GATEWAY_PERMISSION_CALLBACK_NAME,
          this.gatewayPermissionCallback,
        );
        disposers.push(() => registration.dispose());
      }
      if (this.configChangeLifecycle && this.options.gateway?.registerConfigChangeHandler) {
        disposers.push(this.options.gateway.registerConfigChangeHandler((payload) => {
          void this.configChangeLifecycle!.dispatch({
            event: "ConfigChange",
            baseInput: {
              sessionId: this.options.sessionKey,
              transcriptPath: "",
              cwd: this.options.projectRoot,
            },
            payload,
            matchQuery: "ConfigChange",
          }).catch(() => {});
        }));
        disposers.push(() => this.configChangeLifecycle!.dispose());
      }
      if (this.options.gateway?.registerSessionHookHandler) {
        disposers.push(this.options.gateway.registerSessionHookHandler((event, payload) => {
          void this.lifecycle.dispatch({
            event,
            baseInput: {
              sessionId: this.options.sessionKey,
              transcriptPath: "",
              cwd: this.options.projectRoot,
            },
            payload,
            matchQuery: event,
          }).catch(() => {});
        }));
      }
      if (this.fileChangedLifecycle) disposers.push(() => this.fileChangedLifecycle!.dispose());
      for (const dispose of disposers) scope.own(dispose);
      this.attached = true;
    } catch (error) {
      for (const dispose of disposers.reverse()) void dispose();
      throw error;
    }
  }
}

function createSdkHookSettings(
  config: SessionInteractionBundleOptions["sdkHooks"],
): PilotDeckHooksSettings {
  if (!config) return {};
  const settings: PilotDeckHooksSettings = {};
  for (const [event, matchers] of Object.entries(config.events)) {
    if (!isPilotDeckHookEvent(event)) continue;
    settings[event] = (matchers ?? []).map((matcher, index) => ({
      ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
      hooks: [{
        type: "http" as const,
        url: appendSdkHookSelector(config.url, event, index),
        ...(config.headers ? { headers: { ...config.headers } } : {}),
      }],
    }));
  }
  return settings;
}

function mergeHookSettings(base: PilotDeckHooksSettings, extra: PilotDeckHooksSettings): PilotDeckHooksSettings {
  const merged: PilotDeckHooksSettings = { ...base };
  for (const [event, matchers] of Object.entries(extra)) {
    const hookEvent = event as PilotDeckHookEvent;
    merged[hookEvent] = [...(base[hookEvent] ?? []), ...(matchers ?? [])];
  }
  return merged;
}

function appendSdkHookSelector(url: string, event: string, matcher: number): string {
  const endpoint = new URL(url);
  endpoint.searchParams.set("event", event);
  endpoint.searchParams.set("matcher", String(matcher));
  return endpoint.toString();
}
