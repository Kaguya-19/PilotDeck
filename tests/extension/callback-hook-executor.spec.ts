import assert from "node:assert/strict";
import test from "node:test";

import { CallbackHookExecutor, HookExecutionEventBus, HookRuntime } from "../../src/extension/index.js";
import { AsyncHookRegistry } from "../../src/extension/index.js";

const hook = { type: "callback" as const, name: "permission" };
const hookInput = { event: "PermissionRequest", sessionId: "session-1", cwd: "/workspace" } as never;

test("callback hook registration replacement invalidates the old handle", async () => {
  const executor = new CallbackHookExecutor();
  const first = executor.register("permission", () => "first");
  const second = executor.register("permission", () => "second");

  assert.equal(first.active, false);
  assert.equal(second.active, true);
  const result = await executor.execute({ hook, hookInput });
  assert.equal(result.stdout, "second");

  first.dispose();
  assert.equal((await executor.execute({ hook, hookInput })).stdout, "second");
  second.dispose();
  assert.match((await executor.execute({ hook, hookInput })).stderr, /not registered/);
  await executor.dispose();
});

test("callback hook disposal stops new registrations and drains an in-flight callback", async () => {
  const executor = new CallbackHookExecutor();
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const finished = executor.register("slow", async () => {
    await started;
    return "done";
  });
  const execution = executor.execute({ hook: { ...hook, name: "slow" }, hookInput });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disposal = executor.dispose();
  assert.equal(executor.lifecycleState, "draining");
  assert.throws(() => executor.register("late", () => "late"), /draining/);
  release();
  assert.equal((await execution).stdout, "done");
  await disposal;
  assert.equal(finished.active, false);
  assert.equal(executor.lifecycleState, "disposed");
});

test("hook runtime rejects new runs while draining and waits for an in-flight hook", async () => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const callbacks = new CallbackHookExecutor();
  callbacks.register("slow", async () => {
    await started;
    return "done";
  });
  const runtime = new HookRuntime(
    {
      PermissionRequest: [{ hooks: [{ type: "callback", name: "slow" }] }],
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    callbacks,
  );
  const run = runtime.run({
    event: "PermissionRequest",
    hookInput: {
      event: "PermissionRequest",
      hookEventName: "PermissionRequest",
      sessionId: "session-1",
      cwd: "/workspace",
      transcriptPath: "/workspace/transcript.jsonl",
    },
    cwd: "/workspace",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disposal = runtime.dispose();
  assert.equal(runtime.lifecycleState, "draining");
  await assert.rejects(
    () => runtime.run({
      event: "PermissionRequest",
      hookInput: {
        event: "PermissionRequest",
        hookEventName: "PermissionRequest",
        sessionId: "session-1",
        cwd: "/workspace",
        transcriptPath: "/workspace/transcript.jsonl",
      },
      cwd: "/workspace",
    }),
    /hook runtime is draining/,
  );
  release();
  await run;
  await disposal;
  assert.equal(runtime.lifecycleState, "disposed");
});

test("async hook registry owns pending requests and rejects registrations after disposal", async () => {
  const registry = new AsyncHookRegistry();
  const pending = {
    id: "pending-1",
    startedAt: new Date(),
    hookName: "slow",
    hookEvent: "PermissionRequest" as const,
    stdout: "",
    stderr: "",
    responseDelivered: false,
  };
  const registration = registry.register(pending);
  const replacement = registry.register({ ...pending });
  assert.equal(registration.active, false);
  assert.equal(replacement.active, true);
  replacement.dispose();
  assert.equal(replacement.active, false);
  assert.equal(registration.active, false);
  await registry.dispose();
  assert.equal(registry.lifecycleState, "disposed");
  assert.equal(registration.active, false);
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.register({
    id: "late",
    startedAt: new Date(),
    hookName: "late",
    hookEvent: "PermissionRequest" as const,
    stdout: "",
    stderr: "",
    responseDelivered: false,
  }), /registry is disposed/);
});

test("async hook responses resume only after explicit completion and cancellation drops them", async () => {
  const registry = new AsyncHookRegistry();
  registry.register({
    id: "resume-me",
    startedAt: new Date(),
    hookName: "slow",
    hookEvent: "PermissionRequest",
    stdout: '{"async":true}',
    stderr: "",
    responseDelivered: false,
  });

  assert.deepEqual(registry.collectResponses(), []);
  assert.equal(registry.complete("resume-me", {
    stdout: '{"continue":false,"reason":"finished"}',
  }), true);
  const responses = registry.collectResponses();
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.output.type, "sync");
  assert.equal(responses[0]!.rewake, false);
  registry.removeDelivered();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.complete("resume-me", { stdout: "{}" }), false);

  const cancelled = registry.register({
    id: "cancel-me",
    startedAt: new Date(),
    hookName: "slow",
    hookEvent: "PermissionRequest",
    stdout: '{"async":true}',
    stderr: "",
    responseDelivered: false,
  });
  assert.equal(registry.cancel("cancel-me"), true);
  assert.equal(cancelled.active, false);
  assert.deepEqual(registry.collectResponses(), []);
  await registry.dispose();
  assert.equal(registry.complete("cancel-me", { output: { type: "sync" } }), false);
});

test("hook runtime exposes the scoped async resume and cancel contract", async () => {
  const callbacks = new CallbackHookExecutor();
  callbacks.register("async", () => ({ type: "async" }));
  const pending = new AsyncHookRegistry();
  const runtime = new HookRuntime(
    { PermissionRequest: [{ hooks: [{ type: "callback", name: "async" }] }] },
    undefined,
    undefined,
    pending,
    undefined,
    undefined,
    undefined,
    callbacks,
  );

  const run = await runtime.run({
    event: "PermissionRequest",
    hookInput: {
      event: "PermissionRequest",
      hookEventName: "PermissionRequest",
      sessionId: "session-1",
      cwd: "/workspace",
      transcriptPath: "/workspace/transcript.jsonl",
    },
    cwd: "/workspace",
  });
  assert.equal(run.pendingAsyncHooks.length, 1);
  const id = pending.list()[0]!.id;
  assert.equal(run.pendingAsyncHooks[0]!.id, id);
  assert.equal(runtime.completeAsyncHook(id, { output: { type: "sync", continue: false } }), true);
  assert.equal(runtime.collectAsyncResponses()[0]!.output.type, "sync");
  runtime.removeDeliveredAsyncResponses();
  assert.equal(runtime.cancelAsyncHook(id), false);
  await runtime.dispose();
});

test("hook execution subscribers receive session-aware events, isolate failures, and stop exactly", async () => {
  const callbacks = new CallbackHookExecutor();
  callbacks.register("observe", () => "private-hook-output");
  const diagnostics: unknown[] = [];
  const eventBus = new HookExecutionEventBus({
    onSubscriberError: (error) => diagnostics.push(error),
  });
  const runtime = new HookRuntime(
    { PermissionRequest: [{ hooks: [{ type: "callback", name: "observe" }] }] },
    undefined,
    eventBus,
    undefined,
    undefined,
    undefined,
    undefined,
    callbacks,
  );
  const observed: import("../../src/extension/index.js").PilotDeckHookExecutionEvent[] = [];
  runtime.subscribeExecutionEvents(() => {
    throw new Error("observer failed");
  });
  const subscription = runtime.subscribeExecutionEvents((event) => observed.push(event));

  const result = await runtime.run({
    event: "PermissionRequest",
    hookInput: {
      event: "PermissionRequest",
      hookEventName: "PermissionRequest",
      sessionId: "session-live-events",
      cwd: "/workspace",
      transcriptPath: "/workspace/transcript.jsonl",
    },
    cwd: "/workspace",
  });

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(observed.map((event) => event.type), ["started", "response"]);
  assert.deepEqual(observed.map((event) => event.sessionId), ["session-live-events", "session-live-events"]);
  assert.equal(result.events[1]?.type, "response");
  assert.equal(result.events[1]?.type === "response" ? result.events[1].stdout : undefined, "private-hook-output");

  subscription.dispose();
  assert.equal(subscription.active, false);
  await runtime.run({
    event: "PermissionRequest",
    hookInput: {
      event: "PermissionRequest",
      hookEventName: "PermissionRequest",
      sessionId: "session-live-events",
      cwd: "/workspace",
      transcriptPath: "/workspace/transcript.jsonl",
    },
    cwd: "/workspace",
  });
  assert.equal(observed.length, 2);

  await runtime.dispose();
  await assert.rejects(
    () => runtime.run({
      event: "PermissionRequest",
      hookInput,
      cwd: "/workspace",
    }),
    /hook runtime is disposed/,
  );
});
