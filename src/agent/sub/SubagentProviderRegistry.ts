import type {
  ContinuableSubagentCreateSpec,
  ContinuableSubagentPrepareRequest,
  SubagentProvider,
  SubagentRunHandle,
  SubagentRunRequest,
} from "./SubagentProvider.js";
import { snapshotSubagentDescriptor } from "./SubagentDescriptor.js";

export type SubagentProviderRegistryState = "active" | "draining" | "disposed";

export type SubagentProviderRegistration = {
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  readonly inFlight: number;
  stop(): void;
  whenDrained(): Promise<void>;
  dispose(): Promise<void>;
};

export type SubagentProviderReplacement = {
  registration: SubagentProviderRegistration;
  previousDisposed: Promise<void>;
};

export type SubagentProviderLifecycleEvent =
  | {
      type: "registered";
      name: string;
      generation: number;
      capabilities: SubagentProvider["capabilities"];
    }
  | {
      type: "draining";
      name: string;
      generation: number;
      reason: "replaced" | "unregistered" | "registry_disposed";
    }
  | {
      type: "removed";
      name: string;
      generation: number;
      reason: "replaced" | "unregistered" | "registry_disposed";
    };

export type SubagentProviderLifecycleSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type SubagentProviderRegistrationOptions = {
  dispose?: (provider: SubagentProvider) => void | Promise<void>;
};

export type PreparedContinuableSubagent = {
  provider: string;
  generation: number;
  spec: ContinuableSubagentCreateSpec;
};

/**
 * Scope-local named provider registry. A lease remains held until the
 * provider-created run handle is disposed, so provider unload cannot race an
 * accepted child run. Replacement publishes the new generation first and
 * drains the old provider independently.
 */
export class SubagentProviderRegistry {
  private readonly providers = new Map<string, RegistrationImpl>();
  private readonly lifecycleSubscribers = new Set<LifecycleSubscriptionImpl>();
  private nextGeneration = 0;
  private registryState: SubagentProviderRegistryState = "active";
  private disposePromise?: Promise<void>;

  get state(): SubagentProviderRegistryState {
    return this.registryState;
  }

  get size(): number {
    return this.providers.size;
  }

  register(
    name: string,
    provider: SubagentProvider,
    options: SubagentProviderRegistrationOptions = {},
  ): SubagentProviderRegistration {
    this.assertActive("register a subagent provider");
    const normalized = normalizeName(name);
    if (this.providers.has(normalized)) {
      throw new Error(`Subagent provider is already registered: ${normalized}`);
    }
    const registration = this.createRegistration(normalized, provider, options);
    this.providers.set(normalized, registration);
    this.emitLifecycle({
      type: "registered",
      name: normalized,
      generation: registration.generation,
      capabilities: { ...provider.capabilities },
    });
    return registration;
  }

  replace(
    name: string,
    provider: SubagentProvider,
    options: SubagentProviderRegistrationOptions = {},
  ): SubagentProviderReplacement {
    this.assertActive("replace a subagent provider");
    const normalized = normalizeName(name);
    const previous = this.providers.get(normalized);
    if (!previous) throw new Error(`Subagent provider is not registered: ${normalized}`);
    const registration = this.createRegistration(normalized, provider, options);
    this.providers.set(normalized, registration);
    this.emitLifecycle({
      type: "registered",
      name: normalized,
      generation: registration.generation,
      capabilities: { ...provider.capabilities },
    });
    return {
      registration,
      previousDisposed: previous.dispose("replaced"),
    };
  }

  unregister(name: string): Promise<void> {
    this.assertActive("unregister a subagent provider");
    const normalized = normalizeName(name);
    const registration = this.providers.get(normalized);
    if (!registration) {
      throw new Error(`Subagent provider is not registered: ${normalized}`);
    }
    this.providers.delete(normalized);
    return registration.dispose("unregistered");
  }

  subscribeLifecycle(
    subscriber: (event: SubagentProviderLifecycleEvent) => void,
  ): SubagentProviderLifecycleSubscription {
    this.assertActive("subscribe to subagent provider lifecycle");
    const subscription = new LifecycleSubscriptionImpl(subscriber, () => {
      this.lifecycleSubscribers.delete(subscription);
    });
    this.lifecycleSubscribers.add(subscription);
    return subscription;
  }

  get(name: string): SubagentProvider | undefined {
    if (this.registryState !== "active") return undefined;
    const registration = this.providers.get(normalizeName(name));
    return registration?.active ? registration.provider : undefined;
  }

  list(): readonly SubagentProvider[] {
    if (this.registryState !== "active") return [];
    return [...this.providers.values()]
      .filter((registration) => registration.active)
      .map((registration) => registration.provider);
  }

  /** Start through a named provider and retain ownership until run disposal. */
  async start(name: string, request: SubagentRunRequest): Promise<SubagentRunHandle> {
    this.assertActive("start a subagent run");
    const registration = this.providers.get(normalizeName(name));
    if (!registration?.active) {
      throw new Error(`Subagent provider is not available: ${name}`);
    }
    const release = registration.acquire();
    try {
      if (request.mode !== undefined && request.mode !== "one-shot") {
        throw new Error(`Subagent provider "${name}" cannot start a continuable child through the one-shot run path.`);
      }
      const resolvedRequest = {
        ...request,
        mode: "one-shot" as const,
        descriptor: snapshotSubagentDescriptor({
          mode: "one-shot",
          provider: registration.name,
          definitionId: request.definition.id,
        }),
      };
      if (registration.provider.start) {
        const run = await registration.provider.start(resolvedRequest);
        let active = true;
        return {
          result: run.result,
          dispose: async (reason) => {
            if (!active) return;
            active = false;
            try {
              await run.dispose(reason);
            } finally {
              release();
            }
          },
        };
      }
      if (registration.provider.run) {
        const result = registration.provider.run(resolvedRequest);
        let active = true;
        return {
          result,
          dispose: async () => {
            if (!active) return;
            active = false;
            try {
              await result;
            } finally {
              release();
            }
          },
        };
      }
      release();
      throw new Error(`Subagent provider "${name}" does not support one-shot runs.`);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Resolve only detached creation data; the future manager remains the child owner. */
  async prepareContinuable(
    name: string,
    request: ContinuableSubagentPrepareRequest,
  ): Promise<PreparedContinuableSubagent> {
    this.assertActive("prepare a continuable subagent");
    const registration = this.providers.get(normalizeName(name));
    if (!registration?.active) {
      throw new Error(`Subagent provider is not available: ${name}`);
    }
    const prepare = registration.provider.prepareContinuable;
    if (!registration.provider.capabilities.continuation || !prepare) {
      throw new Error(`Subagent provider "${name}" does not support continuable children.`);
    }
    if (request.abortSignal?.aborted) {
      throw abortError(request.abortSignal.reason);
    }
    const release = registration.acquire();
    try {
      const spec = await prepare.call(registration.provider, request);
      if (request.abortSignal?.aborted) {
        throw abortError(request.abortSignal.reason);
      }
      return {
        provider: registration.name,
        generation: registration.generation,
        spec: snapshotContinuableCreateSpec(spec),
      };
    } finally {
      release();
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.registryState = "draining";
    const registrations = [...this.providers.values()].reverse();
    for (const registration of registrations) registration.stop();
    this.disposePromise = (async () => {
      const drainResults = await Promise.allSettled(
        registrations.map((registration) => registration.dispose("registry_disposed")),
      );
      this.providers.clear();
      this.registryState = "disposed";
      for (const subscription of this.lifecycleSubscribers) subscription.dispose();
      const errors = drainResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose subagent providers.");
      }
    })();
    return this.disposePromise;
  }

  private createRegistration(
    name: string,
    provider: SubagentProvider,
    options: SubagentProviderRegistrationOptions,
  ): RegistrationImpl {
    const dispose = options.dispose ?? ((owned: SubagentProvider) => owned.dispose?.());
    return new RegistrationImpl(name, provider, ++this.nextGeneration, dispose, (event) => {
      this.emitLifecycle(event);
      if (this.providers.get(name)?.provider === provider) this.providers.delete(name);
    });
  }

  private emitLifecycle(event: SubagentProviderLifecycleEvent): void {
    for (const subscription of this.lifecycleSubscribers) {
      try {
        subscription.notify(event);
      } catch {
        // Lifecycle observers cannot change provider ownership or teardown.
      }
    }
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; subagent provider registry is ${this.registryState}.`);
    }
  }
}

class LifecycleSubscriptionImpl implements SubagentProviderLifecycleSubscription {
  private subscriptionActive = true;

  constructor(
    private readonly subscriber: (event: SubagentProviderLifecycleEvent) => void,
    private readonly onDispose: () => void,
  ) {}

  get active(): boolean {
    return this.subscriptionActive;
  }

  notify(event: SubagentProviderLifecycleEvent): void {
    if (this.subscriptionActive) this.subscriber(event);
  }

  dispose(): void {
    if (!this.subscriptionActive) return;
    this.subscriptionActive = false;
    this.onDispose();
  }
}

class RegistrationImpl implements SubagentProviderRegistration {
  private registrationState: "active" | "draining" | "disposed" = "active";
  private activeRuns = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;
  private disposePromise?: Promise<void>;

  constructor(
    readonly name: string,
    readonly provider: SubagentProvider,
    readonly generation: number,
    private readonly disposeProvider: ((provider: SubagentProvider) => void | Promise<void>) | undefined,
    private readonly emitLifecycle: (event: SubagentProviderLifecycleEvent) => void,
  ) {}

  get active(): boolean {
    return this.registrationState === "active";
  }

  get inFlight(): number {
    return this.activeRuns;
  }

  stop(): void {
    if (this.registrationState === "active") this.registrationState = "draining";
  }

  acquire(): () => void {
    if (!this.active) throw new Error(`Subagent provider is not active: ${this.name}`);
    this.activeRuns += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeRuns -= 1;
      if (this.activeRuns === 0) {
        this.resolveDrain?.();
        this.resolveDrain = undefined;
        this.drainPromise = undefined;
      }
    };
  }

  whenDrained(): Promise<void> {
    if (this.activeRuns === 0) return Promise.resolve();
    return this.drainPromise ??= new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
  }

  dispose(
    reason: "replaced" | "unregistered" | "registry_disposed" = "unregistered",
  ): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.stop();
    this.emitLifecycle({
      type: "draining",
      name: this.name,
      generation: this.generation,
      reason,
    });
    this.disposePromise = (async () => {
      await this.whenDrained();
      await this.disposeProvider?.(this.provider);
      this.registrationState = "disposed";
      this.emitLifecycle({
        type: "removed",
        name: this.name,
        generation: this.generation,
        reason,
      });
    })();
    return this.disposePromise;
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) throw new Error("Subagent provider name must not be empty.");
  return normalized;
}

function snapshotContinuableCreateSpec(
  spec: ContinuableSubagentCreateSpec,
): ContinuableSubagentCreateSpec {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new TypeError("Continuable subagent creation spec must be an object.");
  }
  const unknown = Object.keys(spec).find((key) => key !== "seedEntries");
  if (unknown) {
    throw new TypeError(`Continuable subagent creation spec has unknown field "${unknown}".`);
  }
  if (spec.seedEntries !== undefined && !Array.isArray(spec.seedEntries)) {
    throw new TypeError("Continuable subagent creation spec seedEntries must be an array.");
  }
  assertLosslessJson(spec, "continuable subagent creation spec", new Set());
  const serialized = JSON.stringify(spec);
  if (serialized === undefined) {
    throw new TypeError("Continuable subagent creation spec must be JSON serializable.");
  }
  return JSON.parse(serialized) as ContinuableSubagentCreateSpec;
}

function assertLosslessJson(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contains a non-finite number.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value.`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle.`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} contains a sparse array.`);
      assertLosslessJson(value[index], `${path}[${index}]`, seen);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} contains a symbol key.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} is not a plain JSON field.`);
      }
      assertLosslessJson(descriptor.value, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function abortError(reason: unknown): Error {
  return new Error(
    typeof reason === "string" && reason.length > 0
      ? `Continuable subagent preparation aborted: ${reason}`
      : "Continuable subagent preparation aborted.",
  );
}
