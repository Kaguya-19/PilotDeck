import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeScope, AgentScopeLiveEventBus } from "../../src/agent/index.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { PermissionDecisionPort } from "../../src/permission/index.js";
import { ToolRegistry } from "../../src/tool/index.js";
import {
  GatewaySessionLiveProjectionBundle,
  type GatewayBackgroundTaskCompletionEventSource,
  type GatewayEvent,
  type GatewayHookExecutionEventSource,
} from "../../src/gateway/index.js";
import type { BackgroundTaskCompletionHandler } from "../../src/task/index.js";
import type { PilotDeckHookExecutionEventHandler } from "../../src/extension/index.js";

test("session live projection bundle projects both sources and releases them with its exact scope", async () => {
  const hookSource = new HookSource();
  const taskSource = new TaskSource();
  const emitted: GatewayEvent[] = [];
  const scope = createScope();

  new GatewaySessionLiveProjectionBundle({
    scope,
    sessionKey: "session-a",
    hookExecutionEvents: hookSource,
    backgroundTaskCompletionEvents: taskSource,
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  }).attach();

  hookSource.emit({
    type: "started",
    sessionId: "session-b",
    hookName: "other",
    hookEvent: "SessionStart",
  });
  hookSource.emit({
    type: "started",
    sessionId: "session-a",
    hookName: "session-hook",
    hookEvent: "SessionStart",
  });
  taskSource.emit({
    sessionId: "session-a",
    taskId: "task-a",
    status: "completed",
    exitCode: 0,
    outputPreview: "done\n",
    totalBytes: 5,
    startedAt: "2026-09-09T00:00:00.000Z",
    endedAt: "2026-09-09T00:00:01.000Z",
  });
  assert.deepEqual(emitted.map((event) => event.type === "agent_status" ? event.event : event.type), [
    "hook_execution_started",
    "background_task_completed",
  ]);

  await scope.dispose();
  assert.equal(hookSource.subscription?.active, false);
  assert.equal(taskSource.subscription?.active, false);

  hookSource.emit({
    type: "started",
    sessionId: "session-a",
    hookName: "late",
    hookEvent: "SessionStart",
  });
  taskSource.emit({
    sessionId: "session-a",
    taskId: "late",
    status: "completed",
    outputPreview: "late",
    totalBytes: 4,
    startedAt: "2026-09-09T00:00:00.000Z",
    endedAt: "2026-09-09T00:00:01.000Z",
  });
  assert.equal(emitted.length, 2);
});

test("session live projection bundle rolls back hook registration when task subscription fails", () => {
  const hookSource = new HookSource();
  const scope = new RecordingScope();
  const bundle = new GatewaySessionLiveProjectionBundle({
    scope,
    sessionKey: "session-a",
    hookExecutionEvents: hookSource,
    backgroundTaskCompletionEvents: {
      subscribeCompletionEvents() {
        throw new Error("task subscribe failed");
      },
    },
    emit: () => true,
  });

  assert.throws(() => bundle.attach(), /task subscribe failed/);
  assert.equal(hookSource.subscription?.active, false);
  assert.equal(scope.effects.length, 0);
});

test("session live projection bundle rolls back both subscriptions when scope ownership rejects", () => {
  const hookSource = new HookSource();
  const taskSource = new TaskSource();
  const bundle = new GatewaySessionLiveProjectionBundle({
    scope: new RecordingScope({ rejectOwn: true }),
    sessionKey: "session-a",
    hookExecutionEvents: hookSource,
    backgroundTaskCompletionEvents: taskSource,
    emit: () => true,
  });

  assert.throws(() => bundle.attach(), /scope is closed/);
  assert.equal(hookSource.subscription?.active, false);
  assert.equal(taskSource.subscription?.active, false);
});

test("session live projection routes source events through the owning scope event bus", async () => {
  const parent = createScope();
  const sessionScope = parent.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const hookSource = new HookSource();
  const taskSource = new TaskSource();
  const observedTypes: string[] = [];
  const emitted: GatewayEvent[] = [];
  parent.liveEvents.subscribe((event) => { observedTypes.push(event.type); });

  new GatewaySessionLiveProjectionBundle({
    scope: sessionScope,
    sessionKey: "session-a",
    hookExecutionEvents: hookSource,
    backgroundTaskCompletionEvents: taskSource,
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  }).attach();

  hookSource.emit({
    type: "started",
    sessionId: "session-a",
    hookName: "scope-hook",
    hookEvent: "SessionStart",
  });
  taskSource.emit({
    sessionId: "session-a",
    taskId: "scope-task",
    status: "completed",
    outputPreview: "done",
    totalBytes: 4,
    startedAt: "2026-09-09T00:00:00.000Z",
    endedAt: "2026-09-09T00:00:01.000Z",
  });

  assert.deepEqual(observedTypes, ["gateway.hook_execution", "gateway.background_task_completion"]);
  assert.deepEqual(emitted.map((event) => event.type === "agent_status" ? event.event : event.type), [
    "hook_execution_started",
    "background_task_completed",
  ]);
  await parent.dispose();
});

class HookSource implements GatewayHookExecutionEventSource {
  subscription?: TestSubscription<PilotDeckHookExecutionEventHandler>;

  subscribeHookExecutionEvents(handler: PilotDeckHookExecutionEventHandler) {
    this.subscription = new TestSubscription(handler);
    return this.subscription;
  }

  emit(event: Parameters<PilotDeckHookExecutionEventHandler>[0]): void {
    if (this.subscription?.active) this.subscription.handler(event);
  }
}

class TaskSource implements GatewayBackgroundTaskCompletionEventSource {
  subscription?: TestSubscription<BackgroundTaskCompletionHandler>;

  subscribeCompletionEvents(handler: BackgroundTaskCompletionHandler) {
    this.subscription = new TestSubscription(handler);
    return this.subscription;
  }

  emit(event: Parameters<BackgroundTaskCompletionHandler>[0]): void {
    if (this.subscription?.active) this.subscription.handler(event);
  }
}

class TestSubscription<Handler> {
  active = true;

  constructor(readonly handler: Handler) {}

  dispose(): void {
    this.active = false;
  }
}

class RecordingScope {
  readonly effects: Array<() => void | Promise<void>> = [];
  readonly liveEvents = new AgentScopeLiveEventBus();

  constructor(private readonly options: { rejectOwn?: boolean } = {}) {}

  own(dispose: () => void | Promise<void>): void {
    if (this.options.rejectOwn) throw new Error("scope is closed");
    this.effects.push(dispose);
  }
}

function createScope(): AgentRuntimeScope {
  return AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
}
