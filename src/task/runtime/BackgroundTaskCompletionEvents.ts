import type { PilotDeckBackgroundTaskStatus } from "../protocol/types.js";

export type BackgroundTaskCompletionEvent = {
  sessionId?: string;
  taskId: string;
  status: Extract<PilotDeckBackgroundTaskStatus, "completed" | "failed" | "cancelled">;
  exitCode?: number | null;
  outputPreview: string;
  totalBytes: number;
  startedAt: string;
  endedAt: string;
};

export type BackgroundTaskCompletionHandler = (event: BackgroundTaskCompletionEvent) => void;

export type BackgroundTaskCompletionSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type BackgroundTaskCompletionEventBusOptions = {
  /** Completion observers are live-only and must never affect task settlement. */
  onSubscriberError?: (error: unknown, event: BackgroundTaskCompletionEvent) => void;
};

/** Disposable, failure-isolated live completion observer registry. */
export class BackgroundTaskCompletionEventBus {
  private readonly subscriptions = new Set<BackgroundTaskCompletionSubscriptionImpl>();
  private disposed = false;

  constructor(private readonly options: BackgroundTaskCompletionEventBusOptions = {}) {}

  subscribe(handler: BackgroundTaskCompletionHandler): BackgroundTaskCompletionSubscription {
    if (this.disposed) {
      throw new Error("Cannot subscribe to background task completion events after the bus is disposed.");
    }
    let subscription: BackgroundTaskCompletionSubscriptionImpl;
    subscription = new BackgroundTaskCompletionSubscriptionImpl(handler, () => this.subscriptions.delete(subscription));
    this.subscriptions.add(subscription);
    return subscription;
  }

  emit(event: BackgroundTaskCompletionEvent): void {
    if (this.disposed) return;
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active) continue;
      try {
        subscription.handle(event);
      } catch (error) {
        try {
          this.options.onSubscriberError?.(error, event);
        } catch {
          // Diagnostics are never part of task completion semantics.
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

class BackgroundTaskCompletionSubscriptionImpl implements BackgroundTaskCompletionSubscription {
  private activeState = true;

  constructor(
    private readonly handler: BackgroundTaskCompletionHandler,
    private readonly remove: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  handle(event: BackgroundTaskCompletionEvent): void {
    this.handler(event);
  }

  dispose(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.remove();
  }
}
