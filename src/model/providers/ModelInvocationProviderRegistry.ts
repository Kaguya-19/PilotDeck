import type { ModelRuntime } from "../ModelRuntime.js";
import { normalizeProviderBaseUrl } from "../normalizeProviderBaseUrl.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelConfig,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import type { ModelCapabilities } from "../protocol/capabilities.js";
import { ModelConfigError, ModelRequestError } from "../protocol/errors.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";
import { complete, streamModel, type ModelRuntimeOptions } from "../streaming/streamModel.js";

/**
 * DSH-style LLM provider Definition for one configured provider route.
 *
 * A provider owns a single stable route id. It may be replaced by a newer
 * generation, but a generation that already accepted stream/complete work
 * remains alive until that work releases its lease.
 */
export type ModelInvocationProvider = {
  readonly providerId: string;
  stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent>;
  complete(request: CanonicalModelRequest, options?: ModelRuntimeOptions): Promise<CanonicalModelResponse>;
  getCapabilities(modelId: string): ModelCapabilities;
  getMultimodal(modelId: string): MultimodalConstraints;
  getProviderProtocol(): ModelProtocol;
  getProviderBaseUrl(): string | undefined;
  dispose?(): void | Promise<void>;
};

export type ModelInvocationProviderRegistration = {
  readonly providerId: string;
  readonly generation: number;
  dispose(): Promise<void>;
  whenDrained(): Promise<void>;
};

export type ModelInvocationProviderReplacement = {
  readonly registration: ModelInvocationProviderRegistration;
  /** Resolves after the retired generation drains and disposes. */
  readonly retired?: Promise<void>;
};

export type ModelInvocationProviderLease = {
  readonly provider: ModelInvocationProvider;
  readonly generation: number;
  release(): void;
};

type EntryState = "active" | "retiring" | "disposed";

type ProviderEntry = {
  provider: ModelInvocationProvider;
  generation: number;
  state: EntryState;
  activeLeases: number;
  drainPromise?: Promise<void>;
  resolveDrain?: () => void;
  disposePromise?: Promise<void>;
};

/**
 * Owns active LLM provider routes for one application composition scope.
 *
 * The registry is deliberately process-local: it does not persist health,
 * session state, or transport identities. Consumers acquire a route only for
 * the duration of a stream/complete invocation. Replacement publishes the
 * new route first, then retires the old generation after its accepted work
 * drains.
 */
export class ModelInvocationProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();
  private nextGeneration = 1;
  private disposed = false;
  private disposePromise?: Promise<void>;

  register(provider: ModelInvocationProvider): ModelInvocationProviderRegistration {
    this.assertOpen();
    this.assertProvider(provider);
    if (this.entries.has(provider.providerId)) {
      throw new ModelConfigError(
        "duplicate_provider",
        `Provider ${provider.providerId} is already registered. Use replace() to publish a new generation.`,
        { providerId: provider.providerId },
      );
    }
    const entry = this.createEntry(provider);
    this.entries.set(provider.providerId, entry);
    return this.registration(entry);
  }

  replace(provider: ModelInvocationProvider): ModelInvocationProviderReplacement {
    this.assertOpen();
    this.assertProvider(provider);
    const replacement = this.createEntry(provider);
    const previous = this.entries.get(provider.providerId);
    this.entries.set(provider.providerId, replacement);
    const retired = previous ? this.retire(previous) : undefined;
    // Replacement is intentionally non-blocking. Keep a rejection observed
    // until the composition owner explicitly awaits `retired`.
    void retired?.catch(() => undefined);
    return { registration: this.registration(replacement), ...(retired ? { retired } : {}) };
  }

  async unregister(providerId: string): Promise<boolean> {
    const entry = this.entries.get(providerId);
    if (!entry) return false;
    this.entries.delete(providerId);
    await this.retire(entry);
    return true;
  }

  acquire(providerId: string): ModelInvocationProviderLease {
    const entry = this.entries.get(providerId);
    if (!entry || entry.state !== "active") {
      throw missingProvider(providerId);
    }
    entry.activeLeases += 1;
    let released = false;
    return {
      provider: entry.provider,
      generation: entry.generation,
      release: () => {
        if (released) return;
        released = true;
        entry.activeLeases -= 1;
        if (entry.activeLeases === 0) {
          entry.resolveDrain?.();
          entry.resolveDrain = undefined;
          entry.drainPromise = undefined;
        }
      },
    };
  }

  stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    const lease = this.acquire(request.provider);
    return (async function* () {
      try {
        yield* lease.provider.stream(request, options);
      } finally {
        lease.release();
      }
    })();
  }

  async complete(request: CanonicalModelRequest, options?: ModelRuntimeOptions): Promise<CanonicalModelResponse> {
    const lease = this.acquire(request.provider);
    try {
      return await lease.provider.complete(request, options);
    } finally {
      lease.release();
    }
  }

  getCapabilities(providerId: string, modelId: string): ModelCapabilities {
    return this.current(providerId).getCapabilities(modelId);
  }

  getMultimodal(providerId: string, modelId: string): MultimodalConstraints {
    return this.current(providerId).getMultimodal(modelId);
  }

  getProviderProtocol(providerId: string): ModelProtocol | undefined {
    return this.entries.get(providerId)?.state === "active"
      ? this.entries.get(providerId)?.provider.getProviderProtocol()
      : undefined;
  }

  getProviderBaseUrl(providerId: string): string | undefined {
    return this.entries.get(providerId)?.state === "active"
      ? this.entries.get(providerId)?.provider.getProviderBaseUrl()
      : undefined;
  }

  getProviderGeneration(providerId: string): number | undefined {
    const entry = this.entries.get(providerId);
    return entry?.state === "active" ? entry.generation : undefined;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private async finishDispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    const results = await Promise.allSettled(entries.map((entry) => this.retire(entry)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose model invocation providers.");
    }
  }

  private current(providerId: string): ModelInvocationProvider {
    const entry = this.entries.get(providerId);
    if (!entry || entry.state !== "active") throw missingProvider(providerId);
    return entry.provider;
  }

  private createEntry(provider: ModelInvocationProvider): ProviderEntry {
    return {
      provider,
      generation: this.nextGeneration++,
      state: "active",
      activeLeases: 0,
    };
  }

  private registration(entry: ProviderEntry): ModelInvocationProviderRegistration {
    return {
      providerId: entry.provider.providerId,
      generation: entry.generation,
      dispose: async () => {
        if (this.entries.get(entry.provider.providerId) === entry) {
          this.entries.delete(entry.provider.providerId);
        }
        await this.retire(entry);
      },
      whenDrained: () => this.whenDrained(entry),
    };
  }

  private retire(entry: ProviderEntry): Promise<void> {
    if (entry.disposePromise) return entry.disposePromise;
    entry.state = "retiring";
    entry.disposePromise = (async () => {
      try {
        await this.whenDrained(entry);
        await entry.provider.dispose?.();
      } finally {
        entry.state = "disposed";
      }
    })();
    return entry.disposePromise;
  }

  private whenDrained(entry: ProviderEntry): Promise<void> {
    if (entry.activeLeases === 0) return Promise.resolve();
    if (!entry.drainPromise) {
      entry.drainPromise = new Promise<void>((resolve) => {
        entry.resolveDrain = resolve;
      });
    }
    return entry.drainPromise;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new ModelConfigError("registry_disposed", "Model invocation provider registry is disposed.");
    }
  }

  private assertProvider(provider: ModelInvocationProvider): void {
    if (!provider.providerId || provider.providerId.trim().length === 0) {
      throw new ModelConfigError("invalid_provider", "Model invocation provider requires a non-empty providerId.");
    }
  }
}

/** Native Provider adapter for one parsed PilotDeck provider route. */
export function createNativeModelInvocationProvider(
  provider: ProviderConfig,
  options: ModelRuntimeOptions = {},
): ModelInvocationProvider {
  const config: ModelConfig = { providers: { [provider.id]: provider } };
  const getModel = (modelId: string) => {
    const model = provider.models[modelId];
    if (!model) {
      throw new ModelRequestError(
        "model_not_found",
        `Model ${modelId} does not exist in provider ${provider.id}.`,
      );
    }
    return model;
  };
  return {
    providerId: provider.id,
    stream: (request, callOptions) => streamModel(request, config, { ...options, ...callOptions }),
    complete: (request, callOptions) => complete(request, config, { ...options, ...callOptions }),
    getCapabilities: (modelId) => getModel(modelId).capabilities,
    getMultimodal: (modelId) => getModel(modelId).multimodal,
    getProviderProtocol: () => provider.protocol,
    getProviderBaseUrl: () => normalizeProviderBaseUrl(provider.url),
  };
}

/**
 * Compatibility facade for consumers not yet migrated to a narrow invocation
 * port. The facade does not own or dispose the registry.
 */
export function createModelRuntimeFromProviderRegistry(
  registry: ModelInvocationProviderRegistry,
): ModelRuntime {
  return {
    stream: (request, options) => registry.stream(request, options),
    complete: (request, options) => registry.complete(request, options),
    getCapabilities: (providerId, modelId) => registry.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => registry.getMultimodal(providerId, modelId),
    getProviderProtocol: (providerId) => registry.getProviderProtocol(providerId),
    getProviderBaseUrl: (providerId) => registry.getProviderBaseUrl(providerId),
  };
}

function missingProvider(providerId: string): ModelRequestError {
  return new ModelRequestError("provider_not_found", `Provider ${providerId} does not exist.`);
}
