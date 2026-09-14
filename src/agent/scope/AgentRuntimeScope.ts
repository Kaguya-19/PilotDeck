import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { PromptContributionRegistry } from "../../context/prompt/PromptContributionRegistry.js";
import type { PermissionDecisionPort } from "../../permission/index.js";
import type {
  PilotDeckToolScheduler,
  ToolRegistry,
  ToolRuntime,
} from "../../tool/index.js";
import type { PilotDeckElicitationChannel } from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type { AgentRouterRuntime } from "../runtime/AgentRuntimeDependencies.js";
import type { SubagentProvider } from "../sub/SubagentProvider.js";
import type { SubagentProviderRegistry } from "../sub/SubagentProviderRegistry.js";
import type { InteractionDeadlinePolicy, InteractionPolicy } from "../../interaction/index.js";
import type { InteractionReconnectPort } from "../../interaction/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import {
  AgentScopeLiveEventBus,
  type AgentScopeLiveEventSubscriberErrorHandler,
} from "./AgentScopeLiveEventBus.js";
import {
  ScopedServiceRegistry,
  createScopedServiceToken,
  type ScopedServiceRegistryState,
  type ScopedServiceToken,
} from "./ScopedServiceRegistry.js";

export type AgentRuntimeScopeServices = {
  router: AgentRouterRuntime;
  permission: PermissionDecisionPort;
  interactionPolicy?: InteractionPolicy;
  interactionDeadlinePolicy?: InteractionDeadlinePolicy;
  interactionReconnect?: InteractionReconnectPort;
  toolRegistry: ToolRegistry;
  toolScheduler: PilotDeckToolScheduler;
  toolRuntime?: ToolRuntime;
  context?: AgentContextRuntime;
  lifecycle?: LifecycleRuntime;
  promptContributions?: PromptContributionRegistry;
  elicitation?: PilotDeckElicitationChannel;
  subagentProvider?: SubagentProvider;
  subagentProviders?: SubagentProviderRegistry;
};

export type AgentRuntimeScopeOptions = {
  name?: string;
  /** Reports one volatile scoped-event subscriber failure without interrupting sibling delivery. */
  onLiveEventSubscriberError?: AgentScopeLiveEventSubscriberErrorHandler;
  ownedPromptContributions?: boolean;
  ownedLifecycle?: boolean;
  ownedToolRegistry?: boolean;
  ownedContext?: boolean;
  ownedElicitation?: boolean;
  ownedInteractionReconnect?: boolean;
  ownedSubagentProvider?: boolean;
  ownedSubagentProviders?: boolean;
  /** Optional capabilities to hide from the parent scope. */
  blockedServices?: readonly (keyof typeof AGENT_RUNTIME_SCOPE_TOKENS)[];
};

/** A disposable contribution owned by one exact AgentRuntimeScope. */
export type AgentRuntimeScopeEffect = {
  readonly active: boolean;
  dispose(): Promise<void>;
};

export const AGENT_RUNTIME_SCOPE_TOKENS = Object.freeze({
  router: createScopedServiceToken<AgentRouterRuntime>("agent.router"),
  permission: createScopedServiceToken<PermissionDecisionPort>("agent.permission"),
  interactionPolicy: createScopedServiceToken<InteractionPolicy>("agent.interaction-policy"),
  interactionDeadlinePolicy: createScopedServiceToken<InteractionDeadlinePolicy>("agent.interaction-deadline-policy"),
  interactionReconnect: createScopedServiceToken<InteractionReconnectPort>("agent.interaction-reconnect"),
  toolRegistry: createScopedServiceToken<ToolRegistry>("agent.tool-registry"),
  toolScheduler: createScopedServiceToken<PilotDeckToolScheduler>("agent.tool-scheduler"),
  toolRuntime: createScopedServiceToken<ToolRuntime>("agent.tool-runtime"),
  context: createScopedServiceToken<AgentContextRuntime>("agent.context"),
  lifecycle: createScopedServiceToken<LifecycleRuntime>("agent.lifecycle"),
  promptContributions: createScopedServiceToken<PromptContributionRegistry>("agent.prompt-contributions"),
  elicitation: createScopedServiceToken<PilotDeckElicitationChannel>("agent.elicitation"),
  subagentProvider: createScopedServiceToken<SubagentProvider>("agent.subagent-provider"),
  subagentProviders: createScopedServiceToken<SubagentProviderRegistry>("agent.subagent-providers"),
});

export class AgentRuntimeScope {
  private disposePromise?: Promise<void>;
  private readonly children = new Set<AgentRuntimeScope>();
  private readonly effects = new Set<AgentRuntimeScopeEffectImpl>();

  private constructor(
    private readonly registry: ScopedServiceRegistry,
    readonly services: AgentRuntimeScopeServices,
    readonly liveEvents: AgentScopeLiveEventBus,
    private readonly inheritedLeases: Array<{ release(): void }> = [],
    private readonly parent?: AgentRuntimeScope,
  ) {}

  static createRoot(
    services: AgentRuntimeScopeServices,
    options: AgentRuntimeScopeOptions = {},
  ): AgentRuntimeScope {
    const registry = new ScopedServiceRegistry({ name: options.name ?? "agent-runtime" });
    registerServices(registry, services, options);
    return new AgentRuntimeScope(
      registry,
      services,
      new AgentScopeLiveEventBus({
        name: options.name ?? "agent-runtime",
        onSubscriberError: options.onLiveEventSubscriberError,
      }),
    );
  }

  get state(): ScopedServiceRegistryState {
    return this.registry.state;
  }

  /**
   * Attach an exact-scope contribution to this scope's teardown boundary.
   * This is deliberately separate from service registration: it owns a
   * consumer registration (such as a hook callback), not a service provider.
   */
  own(dispose: () => void | Promise<void>): AgentRuntimeScopeEffect {
    if (this.disposePromise || this.registry.state !== "active") {
      throw new Error(`Cannot own an effect; agent runtime scope is ${this.registry.state}.`);
    }
    let effect: AgentRuntimeScopeEffectImpl;
    effect = new AgentRuntimeScopeEffectImpl(dispose, () => this.effects.delete(effect));
    this.effects.add(effect);
    return effect;
  }

  createChild(
    overrides: Partial<AgentRuntimeScopeServices>,
    options: AgentRuntimeScopeOptions = {},
  ): AgentRuntimeScope {
    if (this.disposePromise || this.registry.state !== "active") {
      throw new Error(`Cannot create child agent runtime scope; parent is ${this.registry.state}.`);
    }
    const child = this.registry.createChild({
      name: options.name ?? "agent-runtime-child",
      blockedTokens: options.blockedServices?.map((name) => AGENT_RUNTIME_SCOPE_TOKENS[name]),
    });
    registerServices(child, overrides, options);

    const leases: Array<{ release(): void }> = [];
    const acquire = <Service>(token: ScopedServiceToken<Service>) => {
      const lease = child.acquire(token);
      leases.push(lease);
      return lease.service;
    };
    const acquireOptional = <Service>(token: ScopedServiceToken<Service>) =>
      child.has(token) ? acquire(token) : undefined;

    try {
      const services: AgentRuntimeScopeServices = {
        router: acquire<AgentRouterRuntime>(AGENT_RUNTIME_SCOPE_TOKENS.router),
        permission: acquire<PermissionDecisionPort>(AGENT_RUNTIME_SCOPE_TOKENS.permission),
        interactionPolicy: acquireOptional<InteractionPolicy>(AGENT_RUNTIME_SCOPE_TOKENS.interactionPolicy),
        interactionDeadlinePolicy: acquireOptional<InteractionDeadlinePolicy>(
          AGENT_RUNTIME_SCOPE_TOKENS.interactionDeadlinePolicy,
        ),
        interactionReconnect: acquireOptional<InteractionReconnectPort>(
          AGENT_RUNTIME_SCOPE_TOKENS.interactionReconnect,
        ),
        toolRegistry: acquire<ToolRegistry>(AGENT_RUNTIME_SCOPE_TOKENS.toolRegistry),
        toolScheduler: acquire<PilotDeckToolScheduler>(AGENT_RUNTIME_SCOPE_TOKENS.toolScheduler),
        toolRuntime: acquireOptional<ToolRuntime>(AGENT_RUNTIME_SCOPE_TOKENS.toolRuntime),
        context: acquireOptional<AgentContextRuntime>(AGENT_RUNTIME_SCOPE_TOKENS.context),
        lifecycle: acquireOptional<LifecycleRuntime>(AGENT_RUNTIME_SCOPE_TOKENS.lifecycle),
        promptContributions: acquireOptional<PromptContributionRegistry>(
          AGENT_RUNTIME_SCOPE_TOKENS.promptContributions,
        ),
        elicitation: acquireOptional<PilotDeckElicitationChannel>(
          AGENT_RUNTIME_SCOPE_TOKENS.elicitation,
        ),
        subagentProvider: acquireOptional<SubagentProvider>(
          AGENT_RUNTIME_SCOPE_TOKENS.subagentProvider,
        ),
        subagentProviders: acquireOptional<SubagentProviderRegistry>(
          AGENT_RUNTIME_SCOPE_TOKENS.subagentProviders,
        ),
      };
      const childScope = new AgentRuntimeScope(
        child,
        services,
        this.liveEvents.createChild({
          name: options.name ?? "agent-runtime-child",
          onSubscriberError: options.onLiveEventSubscriberError,
        }),
        leases,
        this,
      );
      this.children.add(childScope);
      return childScope;
    } catch (error) {
      for (const lease of leases.reverse()) lease.release();
      void child.dispose();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    // Stop event admission synchronously with scope teardown. The async
    // disposal path below still waits for events already accepted to drain.
    void this.liveEvents.dispose();
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    const errors: unknown[] = [];
    const childResults = await Promise.allSettled(
      [...this.children].reverse().map((child) => child.dispose()),
    );
    for (const result of childResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    this.children.clear();

    try {
      await this.liveEvents.dispose();
    } catch (error) {
      errors.push(error);
    }

    const effectResults = await Promise.allSettled(
      [...this.effects].reverse().map((effect) => effect.dispose()),
    );
    this.effects.clear();
    for (const result of effectResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    for (const lease of this.inheritedLeases.reverse()) lease.release();
    try {
      await this.registry.dispose();
    } catch (error) {
      errors.push(error);
    } finally {
      this.parent?.children.delete(this);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose agent runtime scope.");
    }
  }
}

class AgentRuntimeScopeEffectImpl implements AgentRuntimeScopeEffect {
  private activeState = true;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly disposeContribution: () => void | Promise<void>,
    private readonly onDisposed: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.activeState = false;
    this.disposePromise = Promise.resolve()
      .then(() => this.disposeContribution())
      .finally(this.onDisposed);
    return this.disposePromise;
  }
}

function registerServices(
  registry: ScopedServiceRegistry,
  services: Partial<AgentRuntimeScopeServices>,
  options: AgentRuntimeScopeOptions = {},
): void {
  if (services.router) registry.register(AGENT_RUNTIME_SCOPE_TOKENS.router, services.router);
  if (services.permission) registry.register(AGENT_RUNTIME_SCOPE_TOKENS.permission, services.permission);
  if (services.interactionPolicy) registry.register(AGENT_RUNTIME_SCOPE_TOKENS.interactionPolicy, services.interactionPolicy);
  if (services.interactionDeadlinePolicy) {
    registry.register(AGENT_RUNTIME_SCOPE_TOKENS.interactionDeadlinePolicy, services.interactionDeadlinePolicy);
  }
  if (services.interactionReconnect) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.interactionReconnect,
      services.interactionReconnect,
      options.ownedInteractionReconnect
        ? { dispose: (port) => port.dispose() }
        : {},
    );
  }
  if (services.toolRegistry) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.toolRegistry,
      services.toolRegistry,
      options.ownedToolRegistry
        ? { dispose: (toolRegistry) => toolRegistry.dispose() }
        : {},
    );
  }
  if (services.toolScheduler) registry.register(AGENT_RUNTIME_SCOPE_TOKENS.toolScheduler, services.toolScheduler);
  if (services.toolRuntime) registry.register(AGENT_RUNTIME_SCOPE_TOKENS.toolRuntime, services.toolRuntime);
  if (services.context) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.context,
      services.context,
      options.ownedContext
        ? { dispose: (context) => context.dispose?.() }
        : {},
    );
  }
  if (services.lifecycle) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.lifecycle,
      services.lifecycle,
      options.ownedLifecycle
        ? { dispose: (lifecycle) => lifecycle.dispose() }
        : {},
    );
  }
  if (services.promptContributions) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.promptContributions,
      services.promptContributions,
      options.ownedPromptContributions
        ? { dispose: (promptContributions) => promptContributions.dispose() }
        : {},
    );
  }
  if (services.elicitation) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.elicitation,
      services.elicitation,
      options.ownedElicitation
        ? { dispose: (elicitation) => elicitation.dispose?.("agent_scope_disposed") }
        : {},
    );
  }
  if (services.subagentProvider) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.subagentProvider,
      services.subagentProvider,
      options.ownedSubagentProvider
        ? { dispose: (provider) => provider.dispose?.() }
        : {},
    );
  }
  if (services.subagentProviders) {
    registry.register(
      AGENT_RUNTIME_SCOPE_TOKENS.subagentProviders,
      services.subagentProviders,
      options.ownedSubagentProviders
        ? { dispose: (providers) => providers.dispose() }
        : {},
    );
  }
}
