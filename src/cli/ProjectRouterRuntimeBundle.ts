import { TokenAccountingRuntime } from "../context/index.js";
import type { ModelInvocationProviderRegistry, ModelRuntime } from "../model/index.js";
import {
  createNativeRouterProviderHealthPort,
  createRegistryRouterModelInvocationPort,
  createRouterRuntime,
  type RouterProviderHealthPort,
  type RouterSessionStatePort,
  type RouterRuntime,
  type CustomRouterRegistry,
} from "../router/index.js";
import type { RouterEventBus } from "../router/protocol/events.js";
import type { PilotConfigSnapshot } from "../pilot/index.js";
import type { TelemetryClient } from "../telemetry/index.js";

export type ProjectRouterRuntimeResources = {
  tokenAccounting: TokenAccountingRuntime;
  router: RouterRuntime;
};

export type ProjectRouterRuntimeBundleOptions = {
  snapshot: PilotConfigSnapshot;
  model: ModelRuntime;
  modelProviders: ModelInvocationProviderRegistry;
  /** Preserve the legacy complete-runtime injection branch. */
  useModelRuntime: boolean;
  extensions: { loadSkillPrompt(extensionId: string): Promise<string | undefined> };
  /** Project-owned session registry; never reads a live plugin generation. */
  customRouterRegistry?: CustomRouterRegistry;
  now: () => Date;
  telemetry: TelemetryClient;
  createRouterConfig: (snapshot: PilotConfigSnapshot) => Parameters<typeof createRouterRuntime>[0];
  createRouterEventBus: () => RouterEventBus;
  /** Application-owned volatile routing state shared by project generations. */
  sessionState?: RouterSessionStatePort;
  /** Selects the project-scoped, volatile provider-health policy. */
  createProviderHealth?: (input: { now: () => number }) => RouterProviderHealthPort;
};

/**
 * Project-scoped Router composition. It consumes existing model and extension
 * providers but owns RouterRuntime shutdown; provider registries and plugin
 * generations retain their separate lifecycle owners.
 */
export class ProjectRouterRuntimeBundle {
  private router?: RouterRuntime;
  private staged = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: ProjectRouterRuntimeBundleOptions) {}

  stage(): ProjectRouterRuntimeResources {
    if (this.staged) {
      throw new Error("ProjectRouterRuntimeBundle.stage called more than once.");
    }
    if (this.disposePromise) {
      throw new Error("ProjectRouterRuntimeBundle is already disposing.");
    }
    this.staged = true;
    const tokenAccounting = new TokenAccountingRuntime({
      modelConfig: this.options.snapshot.config.model,
    });
    const providerHealth = this.options.createProviderHealth?.({
      now: () => this.options.now().getTime(),
    }) ?? createNativeRouterProviderHealthPort({
      now: () => this.options.now().getTime(),
    });
    const router = createRouterRuntime(this.options.createRouterConfig(this.options.snapshot), {
      ...(this.options.useModelRuntime
        ? { modelRuntime: this.options.model }
        : { modelInvoker: createRegistryRouterModelInvocationPort(this.options.modelProviders) }),
      now: this.options.now,
      customRouterRegistry: this.options.customRouterRegistry,
      loadSkillPrompt: (extensionId) => this.options.extensions.loadSkillPrompt(extensionId),
      events: this.options.createRouterEventBus(),
      telemetry: this.options.telemetry,
      ...(this.options.sessionState ? { sessionState: this.options.sessionState } : {}),
      providerHealth,
    });
    this.router = router;
    return { tokenAccounting, router };
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.router?.shutdown() ?? Promise.resolve();
  }
}
