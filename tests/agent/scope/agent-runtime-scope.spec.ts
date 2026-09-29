import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeScope } from "../../../src/agent/scope/index.js";
import { PromptContributionRegistry, type AgentContextRuntime } from "../../../src/context/index.js";
import type { PermissionDecisionPort } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { AgentRouterRuntime } from "../../../src/agent/index.js";
import type { PilotDeckElicitationChannel } from "../../../src/tool/elicitation/PilotDeckElicitationChannel.js";
import type { SubagentProvider } from "../../../src/agent/sub/SubagentProvider.js";
import type { InteractionDeadlinePolicy, InteractionPolicy } from "../../../src/interaction/index.js";
import type { LifecycleRuntime } from "../../../src/lifecycle/index.js";
import { CallbackHookExecutor, HookRuntime } from "../../../src/extension/index.js";
import { BackgroundTaskRuntime } from "../../../src/task/runtime/BackgroundTaskRuntime.js";
import type { DetachedShellPort } from "../../../src/tool/execution-world/DetachedShellPort.js";

test("agent child scope inherits shared services and owns tool runtime overrides", async () => {
  const router = {} as AgentRouterRuntime;
  const permission = {} as PermissionDecisionPort;
  const context = {} as AgentContextRuntime;
  const parentRegistry = new ToolRegistry();
  const parentScheduler = {} as never;
  const childRegistry = new ToolRegistry();
  const childScheduler = {} as never;
  const childRuntime = {} as never;
  const root = AgentRuntimeScope.createRoot({
    router,
    permission,
    context,
    toolRegistry: parentRegistry,
    toolScheduler: parentScheduler,
  });
  const child = root.createChild({
    toolRegistry: childRegistry,
    toolScheduler: childScheduler,
    toolRuntime: childRuntime,
  }, { ownedToolRegistry: true });

  assert.equal(child.services.router, router);
  assert.equal(child.services.permission, permission);
  assert.equal(child.services.context, context);
  assert.equal(child.services.toolRegistry, childRegistry);
  assert.equal(child.services.toolScheduler, childScheduler);
  assert.equal(child.services.toolRuntime, childRuntime);

  await child.dispose();
  assert.equal(child.state, "disposed");
  assert.equal(childRegistry.state, "disposed");
  assert.equal(root.state, "active");

  await root.dispose();
  assert.equal(root.state, "disposed");
});

test("disposing a parent runtime scope disposes child wrappers before inherited leases", async () => {
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const child = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    toolRuntime: {} as never,
  });

  await root.dispose();

  assert.equal(root.state, "disposed");
  assert.equal(child.state, "disposed");
});

test("prompt contribution registries are inherited and disposed only by their owning scope", async () => {
  const rootPrompt = new PromptContributionRegistry({ name: "root-prompt" });
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    promptContributions: rootPrompt,
  }, { ownedPromptContributions: true });
  const inherited = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });

  assert.equal(inherited.services.promptContributions, rootPrompt);
  await inherited.dispose();
  assert.equal(rootPrompt.state, "active");

  const childPrompt = rootPrompt.createChild({ name: "child-prompt" });
  const overridden = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    promptContributions: childPrompt,
  }, { ownedPromptContributions: true });
  assert.equal(overridden.services.promptContributions, childPrompt);

  await overridden.dispose();
  assert.equal(childPrompt.state, "disposed");
  assert.equal(rootPrompt.state, "active");

  await root.dispose();
  assert.equal(rootPrompt.state, "disposed");
});

test("elicitation is an optional inherited capability and can be overridden by a child scope", async () => {
  const parentElicitation = {} as PilotDeckElicitationChannel;
  const childElicitation = {} as PilotDeckElicitationChannel;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    elicitation: parentElicitation,
  });
  const inherited = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const overridden = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    elicitation: childElicitation,
  });

  assert.equal(inherited.services.elicitation, parentElicitation);
  assert.equal(overridden.services.elicitation, childElicitation);
  await inherited.dispose();
  await overridden.dispose();
  assert.equal(root.services.elicitation, parentElicitation);
  await root.dispose();
});

test("agent child scope can explicitly disable inherited elicitation", async () => {
  const parentElicitation = {} as PilotDeckElicitationChannel;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    elicitation: parentElicitation,
  });
  const child = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  }, { blockedServices: ["elicitation"] });

  assert.equal(child.services.elicitation, undefined);
  assert.equal(root.services.elicitation, parentElicitation);
  await child.dispose();
  await root.dispose();
});

test("agent child scope inherits and can override the named subagent provider", async () => {
  const parentProvider = {} as SubagentProvider;
  const childProvider = {} as SubagentProvider;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    subagentProvider: parentProvider,
  });
  const inherited = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const overridden = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    subagentProvider: childProvider,
  });

  assert.equal(inherited.services.subagentProvider, parentProvider);
  assert.equal(overridden.services.subagentProvider, childProvider);
  await inherited.dispose();
  await overridden.dispose();
  await root.dispose();
});

test("agent child scope inherits and can override interaction policy", async () => {
  const parentPolicy = {} as InteractionPolicy;
  const childPolicy = {} as InteractionPolicy;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    interactionPolicy: parentPolicy,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const inherited = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });
  const overridden = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    interactionPolicy: childPolicy,
  });

  assert.equal(inherited.services.interactionPolicy, parentPolicy);
  assert.equal(overridden.services.interactionPolicy, childPolicy);
  await inherited.dispose();
  await overridden.dispose();
  await root.dispose();
});

test("agent child scope inherits and can override interaction deadline policy", async () => {
  const parentDeadline = {} as InteractionDeadlinePolicy;
  const childDeadline = {} as InteractionDeadlinePolicy;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    interactionDeadlinePolicy: parentDeadline,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const inherited = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });
  const overridden = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    interactionDeadlinePolicy: childDeadline,
  });

  assert.equal(inherited.services.interactionDeadlinePolicy, parentDeadline);
  assert.equal(overridden.services.interactionDeadlinePolicy, childDeadline);
  await inherited.dispose();
  await overridden.dispose();
  await root.dispose();
});

test("agent scope owns a lifecycle runtime and children only lease it", async () => {
  let disposeCount = 0;
  const lifecycle = {
    dispose: async () => {
      disposeCount += 1;
    },
  } as LifecycleRuntime;
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    lifecycle,
  }, { ownedLifecycle: true });
  const child = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });

  assert.equal(child.services.lifecycle, lifecycle);
  await child.dispose();
  assert.equal(disposeCount, 0);

  await root.dispose();
  assert.equal(disposeCount, 1);
});

test("scope-owned effects release exact registrations child-first and stop new effects", async () => {
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const child = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const disposed: string[] = [];
  const rootEffect = root.own(() => { disposed.push("root"); });
  const childEffect = child.own(() => { disposed.push("child"); });

  await root.dispose();

  assert.deepEqual(disposed, ["child", "root"]);
  assert.equal(rootEffect.active, false);
  assert.equal(childEffect.active, false);
  await rootEffect.dispose();
  assert.deepEqual(disposed, ["child", "root"], "manual disposal stays idempotent after scope teardown");
  assert.throws(() => root.own(() => undefined), /Cannot own an effect/);
});

test("manually released scope effect is not released again during teardown", async () => {
  const scope = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  let disposed = 0;
  const effect = scope.own(() => { disposed += 1; });

  await effect.dispose();
  assert.equal(effect.active, false);
  await scope.dispose();
  assert.equal(disposed, 1);
});

test("scope-owned hook event projections stop without disposing the shared runtime", async () => {
  const callbacks = new CallbackHookExecutor();
  callbacks.register("observe", () => "ok");
  const runtime = new HookRuntime(
    { SessionStart: [{ hooks: [{ type: "callback", name: "observe" }] }] },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    callbacks,
  );
  const scope = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const observed: string[] = [];
  const subscription = runtime.subscribeExecutionEvents((event) => observed.push(event.type));
  scope.own(() => subscription.dispose());

  await scope.dispose();
  assert.equal(subscription.active, false);
  await runtime.run({
    event: "SessionStart",
    hookInput: {
      event: "SessionStart",
      hookEventName: "SessionStart",
      sessionId: "scope-stopped",
      cwd: "/workspace",
      transcriptPath: "/workspace/transcript.jsonl",
    },
    cwd: "/workspace",
  });
  assert.deepEqual(observed, []);
  await runtime.dispose();
});

test("scope-owned task completion projections stop without disposing the project task runtime", async () => {
  let settleExit!: () => void;
  const shell: DetachedShellPort = {
    async start() {
      const exit = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
        settleExit = () => resolve({ exitCode: 0, exitSignal: null });
      });
      return { pid: 9101, exit, terminate: () => settleExit() };
    },
  };
  const backgroundTasks = new BackgroundTaskRuntime({ shell });
  const scope = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const observed: string[] = [];
  const subscription = backgroundTasks.subscribeCompletionEvents((event) => observed.push(event.taskId));
  scope.own(() => subscription.dispose());

  await scope.dispose();
  assert.equal(subscription.active, false);

  // The project-owned provider remains usable; only this session's observer was released.
  const task = await backgroundTasks.start({ command: "echo done", cwd: "/workspace", sessionId: "released-scope" });
  settleExit();
  await backgroundTasks.waitFor(task.taskId);

  assert.deepEqual(observed, []);
  await backgroundTasks.dispose();
});

test("scoped live events flow upward to ancestors without leaking to parents or siblings", async () => {
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const left = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });
  const right = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });
  const rootEvents: string[] = [];
  const leftEvents: string[] = [];
  const rightEvents: string[] = [];
  root.liveEvents.subscribe((event) => { rootEvents.push(event.type); });
  left.liveEvents.subscribe((event) => { leftEvents.push(event.type); });
  right.liveEvents.subscribe((event) => { rightEvents.push(event.type); });

  await root.liveEvents.publish({ type: "root" });
  await left.liveEvents.publish({ type: "left" });
  await right.liveEvents.publish({ type: "right" });

  assert.deepEqual(rootEvents, ["root", "left", "right"]);
  assert.deepEqual(leftEvents, ["left"]);
  assert.deepEqual(rightEvents, ["right"]);
  await root.dispose();
});

test("scoped live events stop new delivery, drain in-flight handlers, and isolate subscriber failures", async () => {
  const failures: string[] = [];
  const scope = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  }, {
    onLiveEventSubscriberError: (error) => failures.push((error as Error).message),
  });
  let resolveDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let siblingDeliveries = 0;
  const subscription = scope.liveEvents.subscribe(async () => {
    await deliveryGate;
  });
  scope.liveEvents.subscribe(() => {
    throw new Error("subscriber failed");
  });
  scope.liveEvents.subscribe(() => {
    siblingDeliveries += 1;
  });

  const delivery = scope.liveEvents.publish({ type: "volatile" });
  assert.equal(scope.liveEvents.inFlight, 1);
  assert.deepEqual(failures, ["subscriber failed"]);
  assert.equal(siblingDeliveries, 1);

  const disposing = scope.dispose();
  assert.equal(scope.liveEvents.state, "draining");
  assert.throws(() => scope.liveEvents.subscribe(() => undefined), /Cannot subscribe to scoped live events/);
  assert.equal(await scope.liveEvents.publish({ type: "late" }), false);

  let disposed = false;
  void disposing.then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false, "scope waits for already-admitted live delivery");

  resolveDelivery();
  assert.equal(await delivery, true);
  await disposing;
  assert.equal(scope.liveEvents.state, "disposed");
  assert.equal(subscription.active, false);
});

test("ancestor event subscriptions remain draining while a child delivery is in flight", async () => {
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });
  const child = root.createChild({ toolRegistry: new ToolRegistry(), toolScheduler: {} as never });
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  root.liveEvents.subscribe(async () => {
    await deliveryGate;
  });

  const delivery = child.liveEvents.publish({ type: "child-live" });
  assert.equal(root.liveEvents.inFlight, 1);
  const disposing = root.dispose();
  await Promise.resolve();
  assert.equal(root.liveEvents.state, "draining");

  releaseDelivery();
  await delivery;
  await disposing;
  assert.equal(root.liveEvents.state, "disposed");
});

test("a failed ancestor subscriber reports through its owning scope", async () => {
  const parentFailures: string[] = [];
  const childFailures: string[] = [];
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  }, {
    onLiveEventSubscriberError: (error) => parentFailures.push((error as Error).message),
  });
  const child = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  }, {
    onLiveEventSubscriberError: (error) => childFailures.push((error as Error).message),
  });
  root.liveEvents.subscribe(() => {
    throw new Error("parent subscriber failed");
  });

  await child.liveEvents.publish({ type: "child-live" });

  assert.deepEqual(parentFailures, ["parent subscriber failed"]);
  assert.deepEqual(childFailures, []);
  await root.dispose();
});
