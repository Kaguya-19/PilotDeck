import {
  ModelInvocationProviderRegistry,
  createModelRuntimeFromProviderRegistry,
  createNativeModelInvocationProvider,
  type ModelInvocationProvider,
  type ModelRuntime,
} from "../model/index.js";
import type { PilotConfigSnapshot } from "../pilot/index.js";

export type ProjectModelRuntimeResources = {
  model: ModelRuntime;
  modelProviders: ModelInvocationProviderRegistry;
};

export type ProjectModelRuntimeBundleOptions = {
  snapshot: PilotConfigSnapshot;
  /** Compatibility injection for a complete ModelRuntime. The caller retains that runtime's lifecycle. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /** Native/provider-profile injection. The bundle owns registered provider disposal. */
  modelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
};

/**
 * Application-scoped LLM provider composition for one project generation.
 * It owns only its invocation-provider registry. Router policy, session
 * selection, request materialization, and telemetry remain outside.
 */
export class ProjectModelRuntimeBundle {
  private readonly modelProviders = new ModelInvocationProviderRegistry();
  private staged = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: ProjectModelRuntimeBundleOptions) {}

  stage(): ProjectModelRuntimeResources {
    if (this.staged) {
      throw new Error("ProjectModelRuntimeBundle.stage called more than once.");
    }
    if (this.disposePromise) {
      throw new Error("ProjectModelRuntimeBundle is already disposing.");
    }
    this.staged = true;

    if (this.options.modelInvocationProviderFactory) {
      for (const provider of this.options.modelInvocationProviderFactory(this.options.snapshot)) {
        this.modelProviders.register(provider);
      }
      return {
        model: createModelRuntimeFromProviderRegistry(this.modelProviders),
        modelProviders: this.modelProviders,
      };
    }
    if (this.options.modelFactory) {
      return {
        model: this.options.modelFactory(this.options.snapshot),
        modelProviders: this.modelProviders,
      };
    }
    for (const provider of Object.values(this.options.snapshot.config.model.providers)) {
      this.modelProviders.register(createNativeModelInvocationProvider(provider));
    }
    return {
      model: createModelRuntimeFromProviderRegistry(this.modelProviders),
      modelProviders: this.modelProviders,
    };
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.modelProviders.dispose();
  }
}
