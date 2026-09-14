import type { PilotDeckHookEvent } from "../protocol/events.js";

export type PilotDeckHookExecutionEvent =
  | {
      type: "started";
      /** The live session that dispatched this hook. */
      sessionId: string;
      hookName: string;
      hookEvent: PilotDeckHookEvent;
    }
  | {
      type: "response";
      /** The live session that dispatched this hook. */
      sessionId: string;
      hookName: string;
      hookEvent: PilotDeckHookEvent;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
    };

export type PilotDeckHookExecutionEventHandler = (event: PilotDeckHookExecutionEvent) => void;

/** Exact registration returned to a live hook-event consumer. */
export type HookExecutionEventSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type HookExecutionEventBusOptions = {
  /** Observers must not change hook execution semantics. */
  onSubscriberError?: (error: unknown, event: PilotDeckHookExecutionEvent) => void;
};

export class HookExecutionEventBus {
  private readonly subscriptions = new Set<HookExecutionEventSubscriptionImpl>();
  private disposed = false;

  constructor(private readonly options: HookExecutionEventBusOptions = {}) {}

  subscribe(handler: PilotDeckHookExecutionEventHandler): HookExecutionEventSubscription {
    if (this.disposed) {
      throw new Error("Cannot subscribe to hook execution events after the bus is disposed.");
    }
    let subscription: HookExecutionEventSubscriptionImpl;
    subscription = new HookExecutionEventSubscriptionImpl(handler, () => this.subscriptions.delete(subscription));
    this.subscriptions.add(subscription);
    return subscription;
  }

  emit(event: PilotDeckHookExecutionEvent): void {
    if (this.disposed) return;
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active) continue;
      try {
        subscription.handle(event);
      } catch (error) {
        try {
          this.options.onSubscriberError?.(error, event);
        } catch {
          // A diagnostic observer is never part of hook execution semantics.
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of [...this.subscriptions]) subscription.dispose();
  }
}

class HookExecutionEventSubscriptionImpl implements HookExecutionEventSubscription {
  private activeState = true;

  constructor(
    private readonly handler: PilotDeckHookExecutionEventHandler,
    private readonly remove: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  handle(event: PilotDeckHookExecutionEvent): void {
    this.handler(event);
  }

  dispose(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.remove();
  }
}
