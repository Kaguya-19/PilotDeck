/**
 * Volatile event carrier owned by an AgentRuntimeScope.
 *
 * It deliberately has no replay, persistence, or state-folding API. Durable
 * session facts stay in SessionRuntime; this carrier only gives scoped live
 * consumers DSH-style ancestor visibility and lifecycle ownership.
 */
export type AgentScopeLiveEvent = Readonly<{
  type: string;
}>;

export type AgentScopeLiveEventBusState = "active" | "draining" | "disposed";

export type AgentScopeLiveEventHandler = (
  event: AgentScopeLiveEvent,
) => void | Promise<void>;

export type AgentScopeLiveEventSubscriberErrorHandler = (
  error: unknown,
  event: AgentScopeLiveEvent,
) => void;

export type AgentScopeLiveEventSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type AgentScopeLiveEventBusOptions = {
  name?: string;
  parent?: AgentScopeLiveEventBus;
  onSubscriberError?: AgentScopeLiveEventSubscriberErrorHandler;
};

/**
 * Routes one volatile event to its exact scope and its ancestors.
 *
 * A child can observe only events it emits itself or from descendants; it
 * cannot observe its parent or siblings. Every subscription belongs to the
 * bus on which it was registered and is removed when that scope disposes.
 */
export class AgentScopeLiveEventBus {
  private readonly name: string;
  private readonly parent?: AgentScopeLiveEventBus;
  private readonly onSubscriberError: AgentScopeLiveEventSubscriberErrorHandler;
  private readonly subscriptions = new Set<AgentScopeLiveEventSubscriptionImpl>();
  private busState: AgentScopeLiveEventBusState = "active";
  private activePublishes = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;
  private disposePromise?: Promise<void>;

  constructor(options: AgentScopeLiveEventBusOptions = {}) {
    this.name = options.name ?? "agent-runtime";
    this.parent = options.parent;
    this.onSubscriberError = options.onSubscriberError ?? (() => undefined);
  }

  get state(): AgentScopeLiveEventBusState {
    return this.busState;
  }

  get inFlight(): number {
    return this.activePublishes;
  }

  createChild(options: Omit<AgentScopeLiveEventBusOptions, "parent"> = {}): AgentScopeLiveEventBus {
    return new AgentScopeLiveEventBus({
      ...options,
      name: options.name ?? `${this.name}:child`,
      parent: this,
      onSubscriberError: options.onSubscriberError ?? this.onSubscriberError,
    });
  }

  subscribe(handler: AgentScopeLiveEventHandler): AgentScopeLiveEventSubscription {
    if (this.busState !== "active") {
      throw new Error(`Cannot subscribe to scoped live events; scope event bus ${this.name} is ${this.busState}.`);
    }
    let subscription: AgentScopeLiveEventSubscriptionImpl;
    subscription = new AgentScopeLiveEventSubscriptionImpl(handler, () => {
      this.subscriptions.delete(subscription);
    });
    this.subscriptions.add(subscription);
    return subscription;
  }

  /**
   * Admit one live event. Handlers are invoked synchronously in registration
   * order, while promise-returning handlers remain part of the drain barrier.
   * Subscriber failures are reported but never prevent sibling delivery.
   */
  publish(event: AgentScopeLiveEvent): Promise<boolean> {
    if (this.busState !== "active") return Promise.resolve(false);

    const groups = this.snapshotSubscriptionGroups();
    const drainingBuses = new Set<AgentScopeLiveEventBus>([this]);
    for (const group of groups) drainingBuses.add(group.owner);
    for (const bus of drainingBuses) bus.activePublishes += 1;

    const pending: Promise<void>[] = [];
    for (const group of groups) {
      for (const subscription of group.subscriptions) {
        try {
          pending.push(Promise.resolve(subscription.handler(event)).catch((error) => {
            group.owner.reportSubscriberError(error, event);
          }));
        } catch (error) {
          group.owner.reportSubscriberError(error, event);
        }
      }
    }

    return Promise.all(pending)
      .then(() => true)
      .finally(() => {
        for (const bus of drainingBuses) bus.releasePublish();
      });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.busState = "draining";
    this.disposePromise = this.finishDispose();
    return this.disposePromise;
  }

  private snapshotSubscriptionGroups(): Array<{
    owner: AgentScopeLiveEventBus;
    subscriptions: AgentScopeLiveEventSubscriptionImpl[];
  }> {
    const result: Array<{
      owner: AgentScopeLiveEventBus;
      subscriptions: AgentScopeLiveEventSubscriptionImpl[];
    }> = [];
    for (let cursor: AgentScopeLiveEventBus | undefined = this; cursor; cursor = cursor.parent) {
      if (cursor.busState !== "active" || cursor.subscriptions.size === 0) continue;
      result.push({ owner: cursor, subscriptions: [...cursor.subscriptions] });
    }
    return result;
  }

  private async finishDispose(): Promise<void> {
    await this.whenDrained();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.clear();
    this.busState = "disposed";
  }

  private whenDrained(): Promise<void> {
    if (this.activePublishes === 0) return Promise.resolve();
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }

  private releasePublish(): void {
    this.activePublishes -= 1;
    if (this.activePublishes === 0) {
      this.resolveDrain?.();
      this.resolveDrain = undefined;
      this.drainPromise = undefined;
    }
  }

  private reportSubscriberError(error: unknown, event: AgentScopeLiveEvent): void {
    try {
      this.onSubscriberError(error, event);
    } catch {
      // Observability must not turn a failed subscriber into a failed event bus.
    }
  }
}

class AgentScopeLiveEventSubscriptionImpl implements AgentScopeLiveEventSubscription {
  private activeState = true;

  constructor(
    readonly handler: AgentScopeLiveEventHandler,
    private readonly onDisposed: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  dispose(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.onDisposed();
  }
}
