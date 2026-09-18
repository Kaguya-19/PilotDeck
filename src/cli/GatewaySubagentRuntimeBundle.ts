import {
  AgentRegistry,
  NativeSubagentContinuationHost,
  SubagentContinuationManager,
  SubagentProviderRegistry,
  createNativeSubagentProvider,
} from "../agent/index.js";
import { SessionSubagentContinuationBundle, type SessionSubagentContinuationRuntime } from "./SessionSubagentContinuationBundle.js";

export type GatewaySubagentContinuations = SessionSubagentContinuationRuntime & {
  readonly providers: SubagentProviderRegistry;
};

export type GatewaySubagentRuntimeBundleOptions = {
  agentRegistryName?: string;
  onCleanupError?: (error: unknown) => void;
  uuid?: () => string;
};

/**
 * Native application composition for continuable subagents.
 *
 * The manager remains the sole child-activation owner, the host remains the
 * sole child-session constructor, and each Agent scope owns its own tool
 * registration. This bundle only wires the native provider family together.
 */
export class GatewaySubagentRuntimeBundle {
  readonly agents: AgentRegistry;
  readonly providers: SubagentProviderRegistry;
  readonly host: NativeSubagentContinuationHost;
  readonly manager: SubagentContinuationManager;
  readonly continuations: GatewaySubagentContinuations;

  private disposePromise?: Promise<void>;

  constructor(options: GatewaySubagentRuntimeBundleOptions = {}) {
    this.agents = new AgentRegistry({ name: options.agentRegistryName ?? "local-gateway-agents" });
    this.providers = new SubagentProviderRegistry();
    const nativeProvider = createNativeSubagentProvider();
    this.providers.register(nativeProvider.name, nativeProvider, {
      dispose: (provider) => provider.dispose?.(),
    });
    this.host = new NativeSubagentContinuationHost({ onCleanupError: options.onCleanupError });
    this.manager = new SubagentContinuationManager({
      agents: this.agents,
      providers: this.providers,
      host: this.host,
      uuid: options.uuid,
    });
    this.continuations = {
      provider: nativeProvider.name,
      host: this.host,
      manager: this.manager,
      providers: this.providers,
    };

    const sessionConsumer = new SessionSubagentContinuationBundle({
      runtime: this.continuations,
    });
    this.host.setChildConfigurator((input) => sessionConsumer.attach({
      handle: input.handle,
      config: input.config,
      dependencies: input.dependencies,
      projectStorage: input.projectStorage,
      agentLoopFactory: input.agentLoopFactory,
      testAgentLoopFactory: input.testAgentLoopFactory,
      collectFileArtifacts: input.collectFileArtifacts,
    }));
  }

  /** Boot rollback owner: drain active children before provider disposal. */
  dispose(reason = "gateway_subagent_runtime_disposed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeResources(reason);
    return this.disposePromise;
  }

  private async disposeResources(reason: string): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.manager.dispose(reason);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.providers.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.agents.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose Gateway subagent runtime.");
    }
  }
}
