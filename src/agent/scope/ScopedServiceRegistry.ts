export type ScopedServiceToken<Service> = {
  readonly id: symbol;
  readonly name: string;
  readonly __service?: Service;
};

export type ScopedServiceRegistryState = "active" | "draining" | "disposed";
export type ScopedServiceRegistrationState = "active" | "draining" | "disposed";

export type ScopedServiceProviderOptions<Service> = {
  dispose?: (service: Service) => void | Promise<void>;
};

export type ScopedServiceLease<Service> = {
  readonly service: Service;
  readonly generation: number;
  readonly active: boolean;
  release(): void;
};

export type ScopedServiceRegistration = {
  readonly tokenName: string;
  readonly generation: number;
  readonly state: ScopedServiceRegistrationState;
  readonly active: boolean;
  readonly inFlight: number;
  stop(): void;
  whenDrained(): Promise<void>;
  dispose(): Promise<void>;
};

export type ScopedServiceReplacement = {
  registration: ScopedServiceRegistration;
  previousDisposed: Promise<void>;
};

export type ScopedServiceRegistryOptions = {
  name?: string;
  /** Tokens this scope must not inherit from its parent. Local overrides still win. */
  blockedTokens?: readonly ScopedServiceToken<unknown>[];
};

export function createScopedServiceToken<Service>(name: string): ScopedServiceToken<Service> {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error("Scoped service token name must not be empty.");
  }
  return Object.freeze({ id: Symbol(normalized), name: normalized });
}

export class ScopedServiceRegistry {
  readonly name: string;

  private parent?: ScopedServiceRegistry;
  private readonly children = new Set<ScopedServiceRegistry>();
  private readonly registrations = new Map<symbol, ScopedServiceRegistrationImpl<unknown>>();
  private readonly blockedTokens: ReadonlySet<symbol>;
  private nextGeneration = 0;
  private registryState: ScopedServiceRegistryState = "active";
  private activeLeases = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;
  private disposePromise?: Promise<void>;

  constructor(options: ScopedServiceRegistryOptions = {}) {
    this.name = options.name?.trim() || "scope";
    this.blockedTokens = new Set(options.blockedTokens?.map((token) => token.id));
  }

  get state(): ScopedServiceRegistryState {
    return this.registryState;
  }

  get inFlight(): number {
    return this.activeLeases;
  }

  createChild(options: ScopedServiceRegistryOptions = {}): ScopedServiceRegistry {
    this.assertActive("create a child scope");
    const child = new ScopedServiceRegistry(options);
    child.parent = this;
    this.children.add(child);
    return child;
  }

  register<Service>(
    token: ScopedServiceToken<Service>,
    service: Service,
    options: ScopedServiceProviderOptions<Service> = {},
  ): ScopedServiceRegistration {
    this.assertActive(`register ${token.name}`);
    if (this.registrations.has(token.id)) {
      throw new Error(`Scoped service is already registered in ${this.name}: ${token.name}`);
    }

    const registration = this.createRegistration(token, service, options);
    this.registrations.set(token.id, registration as ScopedServiceRegistrationImpl<unknown>);
    return registration;
  }

  replace<Service>(
    token: ScopedServiceToken<Service>,
    service: Service,
    options: ScopedServiceProviderOptions<Service> = {},
  ): ScopedServiceReplacement {
    this.assertActive(`replace ${token.name}`);
    const previous = this.registrations.get(token.id);
    if (!previous) {
      throw new Error(`Scoped service is not registered in ${this.name}: ${token.name}`);
    }

    const replacement = this.createRegistration(token, service, options);
    this.registrations.set(token.id, replacement as ScopedServiceRegistrationImpl<unknown>);
    return {
      registration: replacement,
      previousDisposed: previous.dispose(),
    };
  }

  has<Service>(token: ScopedServiceToken<Service>): boolean {
    if (this.registryState !== "active") return false;
    const local = this.registrations.get(token.id);
    if (local?.active) return true;
    if (this.blockedTokens.has(token.id)) return false;
    return this.parent?.has(token) ?? false;
  }

  acquire<Service>(token: ScopedServiceToken<Service>): ScopedServiceLease<Service> {
    this.assertActive(`acquire ${token.name}`);
    const local = this.registrations.get(token.id) as ScopedServiceRegistrationImpl<Service> | undefined;
    const lease = local?.acquire();
    if (lease) return this.trackLease(lease);
    if (this.blockedTokens.has(token.id)) {
      throw new Error(`Scoped service inheritance is blocked: ${token.name}`);
    }
    if (this.parent) return this.trackLease(this.parent.acquire(token));
    throw new Error(`Scoped service is not registered: ${token.name}`);
  }

  async run<Service, Result>(
    token: ScopedServiceToken<Service>,
    operation: (service: Service, generation: number) => Result | Promise<Result>,
  ): Promise<Result> {
    const lease = this.acquire(token);
    try {
      return await operation(lease.service, lease.generation);
    } finally {
      lease.release();
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.registryState = "draining";
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private createRegistration<Service>(
    token: ScopedServiceToken<Service>,
    service: Service,
    options: ScopedServiceProviderOptions<Service>,
  ): ScopedServiceRegistrationImpl<Service> {
    const generation = ++this.nextGeneration;
    let registration: ScopedServiceRegistrationImpl<Service>;
    registration = new ScopedServiceRegistrationImpl({
      token,
      service,
      generation,
      disposeService: options.dispose,
      onStopped: () => {
        if (this.registrations.get(token.id) === registration) {
          this.registrations.delete(token.id);
        }
      },
    });
    return registration;
  }

  private async disposeOwnedResources(): Promise<void> {
    const children = [...this.children].reverse();
    const registrations = [...this.registrations.values()].reverse();
    for (const registration of registrations) registration.stop();

    const childResults = await Promise.allSettled(children.map((child) => child.dispose()));
    await this.whenDrained();
    const registrationResults = await Promise.allSettled(
      registrations.map((registration) => registration.dispose()),
    );
    this.children.clear();
    this.registrations.clear();
    this.registryState = "disposed";
    this.parent?.children.delete(this);

    const errors = [...childResults, ...registrationResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose scoped services in ${this.name}.`);
    }
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; scoped service registry ${this.name} is ${this.registryState}.`);
    }
  }

  private trackLease<Service>(lease: ScopedServiceLease<Service>): ScopedServiceLease<Service> {
    this.activeLeases += 1;
    let active = true;
    return {
      service: lease.service,
      generation: lease.generation,
      get active() {
        return active;
      },
      release: () => {
        if (!active) return;
        active = false;
        lease.release();
        this.activeLeases -= 1;
        if (this.activeLeases === 0) {
          this.resolveDrain?.();
          this.resolveDrain = undefined;
          this.drainPromise = undefined;
        }
      },
    };
  }

  private whenDrained(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve();
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }
}

type ScopedServiceRegistrationImplOptions<Service> = {
  token: ScopedServiceToken<Service>;
  service: Service;
  generation: number;
  disposeService?: (service: Service) => void | Promise<void>;
  onStopped: () => void;
};

class ScopedServiceRegistrationImpl<Service> implements ScopedServiceRegistration {
  readonly tokenName: string;
  readonly generation: number;

  private readonly service: Service;
  private readonly disposeService?: (service: Service) => void | Promise<void>;
  private readonly onStopped: () => void;
  private registrationState: ScopedServiceRegistrationState = "active";
  private activeLeases = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;
  private disposePromise?: Promise<void>;

  constructor(options: ScopedServiceRegistrationImplOptions<Service>) {
    this.tokenName = options.token.name;
    this.generation = options.generation;
    this.service = options.service;
    this.disposeService = options.disposeService;
    this.onStopped = options.onStopped;
  }

  get state(): ScopedServiceRegistrationState {
    return this.registrationState;
  }

  get active(): boolean {
    return this.registrationState === "active";
  }

  get inFlight(): number {
    return this.activeLeases;
  }

  acquire(): ScopedServiceLease<Service> | undefined {
    if (!this.active) return undefined;
    this.activeLeases += 1;
    let active = true;
    return {
      service: this.service,
      generation: this.generation,
      get active() {
        return active;
      },
      release: () => {
        if (!active) return;
        active = false;
        this.activeLeases -= 1;
        if (this.activeLeases === 0) {
          this.resolveDrain?.();
          this.resolveDrain = undefined;
          this.drainPromise = undefined;
        }
      },
    };
  }

  stop(): void {
    if (!this.active) return;
    this.registrationState = "draining";
    this.onStopped();
  }

  whenDrained(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve();
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.stop();
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private async finishDispose(): Promise<void> {
    try {
      await this.whenDrained();
      await this.disposeService?.(this.service);
    } finally {
      this.registrationState = "disposed";
    }
  }
}
