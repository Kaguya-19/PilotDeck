import type {
  HookExecutionEventSubscription,
  PilotDeckHookExecutionEventHandler,
} from "../extension/index.js";
import type {
  AgentScopeLiveEvent,
  AgentScopeLiveEventBus,
  AgentScopeLiveEventSubscription,
} from "../agent/scope/AgentScopeLiveEventBus.js";
import type {
  BackgroundTaskCompletionHandler,
  BackgroundTaskCompletionSubscription,
} from "../task/index.js";
import type { GatewayEvent } from "./protocol/types.js";
import { createGatewayHookExecutionProjection } from "./hooks/GatewayHookExecutionProjection.js";
import { createGatewayBackgroundTaskCompletionProjection } from "./tasks/GatewayBackgroundTaskCompletionProjection.js";

/** The narrow hook-event surface consumed by one session live projection. */
export type GatewayHookExecutionEventSource = {
  subscribeHookExecutionEvents(handler: PilotDeckHookExecutionEventHandler): HookExecutionEventSubscription;
};

/** The narrow task-completion surface consumed by one session live projection. */
export type GatewayBackgroundTaskCompletionEventSource = {
  subscribeCompletionEvents(handler: BackgroundTaskCompletionHandler): BackgroundTaskCompletionSubscription;
};

type GatewayHookExecutionLiveEvent = AgentScopeLiveEvent & {
  type: "gateway.hook_execution";
  sessionKey: string;
  event: Parameters<PilotDeckHookExecutionEventHandler>[0];
};

type GatewayBackgroundTaskCompletionLiveEvent = AgentScopeLiveEvent & {
  type: "gateway.background_task_completion";
  sessionKey: string;
  event: Parameters<BackgroundTaskCompletionHandler>[0];
};

type GatewaySessionLiveEvent = GatewayHookExecutionLiveEvent | GatewayBackgroundTaskCompletionLiveEvent;

export type GatewaySessionLiveProjectionScope = {
  own(dispose: () => void | Promise<void>): unknown;
  liveEvents: Pick<AgentScopeLiveEventBus, "publish" | "subscribe">;
};

export type GatewaySessionLiveProjectionBundleOptions = {
  /** The exact Agent scope that owns these two live consumer registrations. */
  scope: GatewaySessionLiveProjectionScope;
  sessionKey: string;
  hookExecutionEvents: GatewayHookExecutionEventSource;
  backgroundTaskCompletionEvents: GatewayBackgroundTaskCompletionEventSource;
  emit: (event: GatewayEvent) => boolean;
};

/**
 * Composes the two existing session-local live projections without taking
 * ownership of either producer. The AgentRuntimeScope owns the resulting
 * registration, so session teardown stops projection but leaves project task
 * and session hook runtimes usable by their existing owners.
 */
export class GatewaySessionLiveProjectionBundle {
  private attached = false;

  constructor(private readonly options: GatewaySessionLiveProjectionBundleOptions) {}

  attach(): void {
    if (this.attached) {
      throw new Error("GatewaySessionLiveProjectionBundle is already attached.");
    }

    let hookSubscription: HookExecutionEventSubscription | undefined;
    let taskSubscription: BackgroundTaskCompletionSubscription | undefined;
    let projectionSubscription: AgentScopeLiveEventSubscription | undefined;
    try {
      const hookProjection = createGatewayHookExecutionProjection({
        sessionKey: this.options.sessionKey,
        emit: this.options.emit,
      });
      const taskProjection = createGatewayBackgroundTaskCompletionProjection({
        sessionKey: this.options.sessionKey,
        emit: this.options.emit,
      });
      projectionSubscription = this.options.scope.liveEvents.subscribe((event) => {
        if (isGatewayHookExecutionLiveEvent(event) && event.sessionKey === this.options.sessionKey) {
          hookProjection(event.event);
        }
        if (isGatewayBackgroundTaskCompletionLiveEvent(event) && event.sessionKey === this.options.sessionKey) {
          taskProjection(event.event);
        }
      });
      hookSubscription = this.options.hookExecutionEvents.subscribeHookExecutionEvents(
        (event) => this.publishHookExecutionEvent(event),
      );
      taskSubscription = this.options.backgroundTaskCompletionEvents.subscribeCompletionEvents(
        (event) => this.publishBackgroundTaskCompletionEvent(event),
      );
      const attachedHookSubscription = hookSubscription;
      const attachedTaskSubscription = taskSubscription;
      this.options.scope.own(() => disposeSubscriptions([
        attachedTaskSubscription,
        attachedHookSubscription,
      ]));
      this.attached = true;
    } catch (error) {
      try {
        disposeSubscriptions([taskSubscription, hookSubscription, projectionSubscription]);
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          "Failed to attach Gateway session live projections.",
        );
      }
      throw error;
    }
  }

  private publishHookExecutionEvent(event: Parameters<PilotDeckHookExecutionEventHandler>[0]): void {
    if (event.sessionId !== this.options.sessionKey) return;
    const scopedEvent: GatewayHookExecutionLiveEvent = {
      type: "gateway.hook_execution",
      sessionKey: this.options.sessionKey,
      event,
    };
    void this.options.scope.liveEvents.publish(scopedEvent);
  }

  private publishBackgroundTaskCompletionEvent(event: Parameters<BackgroundTaskCompletionHandler>[0]): void {
    if (event.sessionId !== this.options.sessionKey) return;
    const scopedEvent: GatewayBackgroundTaskCompletionLiveEvent = {
      type: "gateway.background_task_completion",
      sessionKey: this.options.sessionKey,
      event,
    };
    void this.options.scope.liveEvents.publish(scopedEvent);
  }
}

function disposeSubscriptions(
  subscriptions: ReadonlyArray<
    | HookExecutionEventSubscription
    | BackgroundTaskCompletionSubscription
    | AgentScopeLiveEventSubscription
    | undefined
  >,
): void {
  const errors: unknown[] = [];
  for (const subscription of subscriptions) {
    try {
      subscription?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to dispose Gateway session live projections.");
  }
}

function isGatewayHookExecutionLiveEvent(event: AgentScopeLiveEvent): event is GatewayHookExecutionLiveEvent {
  return event.type === "gateway.hook_execution";
}

function isGatewayBackgroundTaskCompletionLiveEvent(
  event: AgentScopeLiveEvent,
): event is GatewayBackgroundTaskCompletionLiveEvent {
  return event.type === "gateway.background_task_completion";
}
