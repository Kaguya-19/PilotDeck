import type {
  AnalyticsEventName,
  AnalyticsEventProperties,
  TelemetryClient,
  TelemetryErrorInput,
  TelemetryFeatureUsedInput,
  TelemetryTrackContext,
} from "./types.js";

/**
 * Live telemetry is intentionally distinct from durable Session events. An
 * observer may inspect a forwarded telemetry call, but cannot affect the
 * caller's result or Session source of truth.
 */
export type TelemetryObservation =
  | {
      type: "track";
      eventName: AnalyticsEventName;
      properties: Readonly<AnalyticsEventProperties>;
      context: Readonly<TelemetryTrackContext>;
    }
  | {
      type: "feature_used" | "feature_loop_stage";
      input: Readonly<TelemetryFeatureUsedInput>;
    }
  | {
      type: "error";
      error: unknown;
      input: Readonly<TelemetryErrorInput>;
    };

export type TelemetryObserver = {
  observe(observation: TelemetryObservation): void | Promise<void>;
  dispose?(): void | Promise<void>;
};

export type TelemetryObserverFailure = {
  name: string;
  generation: number;
  observation: TelemetryObservation;
  error: unknown;
};

export type TelemetryObserverRegistryState = "active" | "draining" | "disposed";
export type TelemetryObserverRegistrationState = "active" | "draining" | "disposed";

export type TelemetryObserverRegistration = {
  readonly name: string;
  readonly generation: number;
  readonly state: TelemetryObserverRegistrationState;
  readonly active: boolean;
  readonly inFlight: number;
  stop(): void;
  whenDrained(): Promise<void>;
  dispose(): Promise<void>;
};

export type TelemetryObserverReplacement = {
  registration: TelemetryObserverRegistration;
  previousDisposed: Promise<void>;
};

export type TelemetryObserverRegistrationOptions = {
  dispose?: (observer: TelemetryObserver) => void | Promise<void>;
};

export type TelemetryObserverRegistryOptions = {
  onObserverFailure?: (failure: TelemetryObserverFailure) => void;
};

/**
 * Owns non-Agent-scoped telemetry observers. Replacements publish a new
 * generation before draining the retired observer, so an in-flight callback
 * can finish without receiving later live events.
 */
export class TelemetryObserverRegistry {
  private readonly registrations = new Map<string, RegistrationImpl>();
  private nextGeneration = 0;
  private registryState: TelemetryObserverRegistryState = "active";
  private disposePromise?: Promise<void>;

  constructor(private readonly options: TelemetryObserverRegistryOptions = {}) {}

  get state(): TelemetryObserverRegistryState {
    return this.registryState;
  }

  get size(): number {
    return this.registrations.size;
  }

  register(
    name: string,
    observer: TelemetryObserver,
    options: TelemetryObserverRegistrationOptions = {},
  ): TelemetryObserverRegistration {
    this.assertActive("register a telemetry observer");
    const normalized = normalizeName(name);
    if (this.registrations.has(normalized)) {
      throw new Error(`Telemetry observer is already registered: ${normalized}`);
    }
    const registration = this.createRegistration(normalized, observer, options);
    this.registrations.set(normalized, registration);
    return registration;
  }

  replace(
    name: string,
    observer: TelemetryObserver,
    options: TelemetryObserverRegistrationOptions = {},
  ): TelemetryObserverReplacement {
    this.assertActive("replace a telemetry observer");
    const normalized = normalizeName(name);
    const previous = this.registrations.get(normalized);
    if (!previous) {
      throw new Error(`Telemetry observer is not registered: ${normalized}`);
    }
    const registration = this.createRegistration(normalized, observer, options);
    this.registrations.set(normalized, registration);
    return {
      registration,
      previousDisposed: previous.dispose(),
    };
  }

  unregister(name: string): Promise<void> {
    this.assertActive("unregister a telemetry observer");
    const normalized = normalizeName(name);
    const registration = this.registrations.get(normalized);
    if (!registration) {
      throw new Error(`Telemetry observer is not registered: ${normalized}`);
    }
    this.registrations.delete(normalized);
    return registration.dispose();
  }

  /** Forwarding is deliberately fire-and-forget and never changes telemetry callers' control flow. */
  observe(observation: TelemetryObservation): void {
    if (this.registryState !== "active") return;
    for (const registration of [...this.registrations.values()]) {
      registration.observe(observation, (error) => this.reportFailure({
        name: registration.name,
        generation: registration.generation,
        observation,
        error,
      }));
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.registryState = "draining";
    const registrations = [...this.registrations.values()].reverse();
    for (const registration of registrations) registration.stop();
    this.disposePromise = (async () => {
      const results = await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      this.registrations.clear();
      this.registryState = "disposed";
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose telemetry observers.");
    })();
    return this.disposePromise;
  }

  private createRegistration(
    name: string,
    observer: TelemetryObserver,
    options: TelemetryObserverRegistrationOptions,
  ): RegistrationImpl {
    let registration: RegistrationImpl;
    registration = new RegistrationImpl({
      name,
      observer,
      generation: ++this.nextGeneration,
      dispose: options.dispose,
      onStopped: () => {
        if (this.registrations.get(name) === registration) {
          this.registrations.delete(name);
        }
      },
    });
    return registration;
  }

  private reportFailure(failure: TelemetryObserverFailure): void {
    try {
      this.options.onObserverFailure?.(failure);
    } catch {
      // Failure diagnostics are observational too and cannot affect callers.
    }
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; telemetry observer registry is ${this.registryState}.`);
    }
  }
}

/**
 * Decorates an existing telemetry client with a live observer carrier. The
 * underlying client remains authoritative for transport, queueing and flush.
 */
export function createObservingTelemetryClient(
  client: TelemetryClient,
  observers: TelemetryObserverRegistry,
): TelemetryClient {
  return {
    track(eventName, properties = {}, context = {}) {
      client.track(eventName, properties, context);
      observers.observe({
        type: "track",
        eventName,
        properties: { ...properties },
        context: { ...context },
      });
    },
    trackFeatureUsed(input) {
      client.trackFeatureUsed(input);
      observers.observe({ type: "feature_used", input: snapshotFeatureInput(input) });
    },
    trackFeatureLoopStage(input) {
      client.trackFeatureLoopStage(input);
      observers.observe({ type: "feature_loop_stage", input: snapshotFeatureInput(input) });
    },
    trackError(error, input = {}) {
      client.trackError(error, input);
      observers.observe({ type: "error", error, input: snapshotErrorInput(input) });
    },
    setEnabled(enabled) {
      client.setEnabled(enabled);
    },
    flush() {
      return client.flush();
    },
    shutdown() {
      return client.shutdown();
    },
    snapshot() {
      return client.snapshot();
    },
    getConfig() {
      return client.getConfig();
    },
  };
}

type RegistrationImplOptions = {
  name: string;
  observer: TelemetryObserver;
  generation: number;
  dispose?: (observer: TelemetryObserver) => void | Promise<void>;
  onStopped: () => void;
};

class RegistrationImpl implements TelemetryObserverRegistration {
  private registrationState: TelemetryObserverRegistrationState = "active";
  private activeObservations = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: RegistrationImplOptions) {}

  get name(): string {
    return this.options.name;
  }

  get generation(): number {
    return this.options.generation;
  }

  get state(): TelemetryObserverRegistrationState {
    return this.registrationState;
  }

  get active(): boolean {
    return this.registrationState === "active";
  }

  get inFlight(): number {
    return this.activeObservations;
  }

  observe(observation: TelemetryObservation, onFailure: (error: unknown) => void): void {
    const release = this.acquire();
    if (!release) return;
    try {
      const result = this.options.observer.observe(observation);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => release(),
          (error) => {
            onFailure(error);
            release();
          },
        );
      } else {
        release();
      }
    } catch (error) {
      onFailure(error);
      release();
    }
  }

  stop(): void {
    if (!this.active) return;
    this.registrationState = "draining";
    this.options.onStopped();
  }

  whenDrained(): Promise<void> {
    if (this.activeObservations === 0) return Promise.resolve();
    return this.drainPromise ??= new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.stop();
    this.disposePromise = (async () => {
      try {
        await this.whenDrained();
        await (this.options.dispose ?? ((observer) => observer.dispose?.()))(this.options.observer);
      } finally {
        this.registrationState = "disposed";
      }
    })();
    return this.disposePromise;
  }

  private acquire(): (() => void) | undefined {
    if (!this.active) return undefined;
    this.activeObservations += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeObservations -= 1;
      if (this.activeObservations === 0) {
        this.resolveDrain?.();
        this.resolveDrain = undefined;
        this.drainPromise = undefined;
      }
    };
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error("Telemetry observer name must not be empty.");
  }
  return normalized;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value
    && typeof (value as PromiseLike<unknown>).then === "function";
}

function snapshotFeatureInput(input: TelemetryFeatureUsedInput): Readonly<TelemetryFeatureUsedInput> {
  return {
    ...input,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

function snapshotErrorInput(input: TelemetryErrorInput): Readonly<TelemetryErrorInput> {
  return {
    ...input,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}
