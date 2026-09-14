import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import { createDefaultInteractionPolicy, createNativeInteractionReconnectPort } from "../../interaction/index.js";
import { PermissionRuntime } from "../../permission/index.js";
import { ConcurrentToolScheduler, ToolRuntime } from "../../tool/index.js";
import type { PilotDeckElicitationChannel } from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type { AgentEventEmitter } from "../protocol/events.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { AgentRuntimeScope } from "../scope/AgentRuntimeScope.js";
import { createNativeSubagentProvider } from "../sub/SubagentProvider.js";
import { SubagentProviderRegistry } from "../sub/SubagentProviderRegistry.js";

/** Native session inputs before ToolRuntime and scope defaults are composed. */
export type AgentSessionScopeBundleDependencies = Omit<AgentRuntimeDependencies, "tools"> & {
  tools: Partial<AgentRuntimeDependencies["tools"]> & Pick<AgentRuntimeDependencies["tools"], "registry">;
};

export type AgentSessionScopeBundleOptions = {
  sessionId: string;
  dependencies: AgentSessionScopeBundleDependencies;
  context?: AgentContextRuntime;
  elicitation?: PilotDeckElicitationChannel;
  eventEmitter?: AgentEventEmitter;
  ownedScope?: boolean;
  ownedToolRegistry?: boolean;
  /** Transfers an injected reconnect provider to the session scope. */
  ownedInteractionReconnect?: boolean;
};

export type AgentSessionScopeBundleResources = {
  scope: AgentRuntimeScope;
  ownsScope: boolean;
  permission: NonNullable<AgentRuntimeDependencies["permission"]>;
  interactionPolicy: NonNullable<AgentRuntimeDependencies["interactionPolicy"]>;
  interactionDeadlinePolicy: AgentRuntimeDependencies["interactionDeadlinePolicy"];
  interactionReconnect: AgentRuntimeDependencies["interactionReconnect"];
  scheduler: NonNullable<AgentRuntimeDependencies["tools"]["scheduler"]>;
  subagentProvider: AgentRuntimeDependencies["subagentProvider"];
  subagentProviders: AgentRuntimeDependencies["subagentProviders"];
  ownedSubagentProvider: boolean;
};

/**
 * Composes the native service providers scoped to one AgentSession.
 *
 * It deliberately does not own Session persistence, durable event recording,
 * or AgentLoop construction. Those remain with AgentSessionRuntimeBundle and
 * createAgentSession respectively.
 */
export class AgentSessionScopeBundle {
  constructor(private readonly options: AgentSessionScopeBundleOptions) {}

  compose(): AgentSessionScopeBundleResources {
    const dependencies = this.options.dependencies;
    const permission = dependencies.permission ?? new PermissionRuntime();
    const interactionPolicy = dependencies.interactionPolicy ?? createDefaultInteractionPolicy();
    const interactionDeadlinePolicy = dependencies.interactionDeadlinePolicy;
    const createsScope = dependencies.scope === undefined;
    const createsInteractionReconnect = dependencies.interactionReconnect === undefined && createsScope;
    const interactionReconnect = dependencies.interactionReconnect
      ?? (createsScope ? createNativeInteractionReconnectPort() : undefined);

    const configuredSubagentProviders = dependencies.subagentProviders;
    const subagentProvider = dependencies.subagentProvider
      ?? configuredSubagentProviders?.list()[0]
      ?? (configuredSubagentProviders ? undefined : createNativeSubagentProvider());
    const ownedSubagentProvider = dependencies.ownedSubagentProvider === true
      || (dependencies.subagentProvider === undefined
        && configuredSubagentProviders === undefined
        && createsScope);
    const subagentProviders = configuredSubagentProviders
      ?? (createsScope ? new SubagentProviderRegistry() : undefined);
    if (subagentProviders && configuredSubagentProviders === undefined && subagentProvider) {
      subagentProviders.register(subagentProvider.name, subagentProvider, {
        dispose: ownedSubagentProvider
          ? (provider) => provider.dispose?.()
          : () => undefined,
      });
    }

    const toolRuntime = new ToolRuntime(
      dependencies.tools.registry,
      permission,
      dependencies.lifecycle,
      this.options.eventEmitter,
    );
    const scheduler = dependencies.tools.scheduler
      ?? new ConcurrentToolScheduler(toolRuntime, dependencies.tools.registry);
    const scope = dependencies.scope ?? AgentRuntimeScope.createRoot({
      router: dependencies.router,
      permission,
      interactionPolicy,
      interactionDeadlinePolicy,
      interactionReconnect,
      toolRegistry: dependencies.tools.registry,
      toolScheduler: scheduler,
      toolRuntime,
      context: this.options.context,
      lifecycle: dependencies.lifecycle,
      promptContributions: dependencies.promptContributions?.registry,
      elicitation: this.options.elicitation,
      ...(subagentProvider ? { subagentProvider } : {}),
      subagentProviders,
    }, {
      name: `agent-session:${this.options.sessionId}`,
      ownedToolRegistry: this.options.ownedToolRegistry === true,
      ownedContext: dependencies.ownedContext === true,
      ownedPromptContributions: dependencies.promptContributions?.owned === true,
      ownedLifecycle: dependencies.ownedLifecycle === true,
      ownedElicitation: dependencies.ownedElicitation === true,
      // A fallback port is created for this session. Injected ports remain
      // caller-owned unless their ownership was explicitly transferred.
      ownedInteractionReconnect: this.options.ownedInteractionReconnect === true || createsInteractionReconnect,
      // The registry owns provider disposal; the lookup token must not do it
      // a second time during scope teardown.
      ownedSubagentProvider: false,
      ownedSubagentProviders: subagentProviders !== undefined
        && configuredSubagentProviders === undefined
        && createsScope,
    });

    return {
      scope,
      ownsScope: createsScope || this.options.ownedScope === true,
      permission,
      interactionPolicy,
      interactionDeadlinePolicy,
      interactionReconnect,
      scheduler,
      subagentProvider,
      subagentProviders,
      ownedSubagentProvider,
    };
  }
}
