import assert from "node:assert/strict";
import test from "node:test";

import {
  SubagentProviderRegistry,
  type SubagentProvider,
  type SubagentProviderLifecycleEvent,
  type SubagentRunRequest,
} from "../../../src/agent/sub/index.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";

function provider(name: string, onDispose: () => void): SubagentProvider {
  return {
    name,
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async () => ({
      result: Promise.resolve({
        subagentId: "child",
        definitionId: "explore",
        markdown: "ok",
        usage: {},
        turns: 1,
        durationMs: 1,
      }),
      dispose: async () => undefined,
    }),
    dispose: onDispose,
  };
}

function request(): SubagentRunRequest {
  return {
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect files.",
    parentConfig: {} as SubagentRunRequest["parentConfig"],
    parentDependencies: {} as SubagentRunRequest["parentDependencies"],
    parentSessionId: "parent",
    parentTurnId: "turn",
    subagentSessionId: "child-session",
    subagentId: "child",
  };
}

test("subagent provider registry replaces by generation and drains old runs", async () => {
  const registry = new SubagentProviderRegistry();
  let oldDisposed = 0;
  let newDisposed = 0;
  const oldRegistration = registry.register("native", provider("native", () => { oldDisposed += 1; }));
  const run = await registry.start("native", request());
  const replacement = registry.replace("native", provider("native", () => { newDisposed += 1; }));

  assert.equal(replacement.registration.generation > oldRegistration.generation, true);
  assert.equal(oldDisposed, 0);
  await run.dispose();
  await replacement.previousDisposed;
  assert.equal(oldDisposed, 1);
  assert.equal(registry.get("native")?.name, "native");

  await registry.dispose();
  assert.equal(newDisposed, 1);
  assert.equal(registry.state, "disposed");
});

test("subagent provider registry rejects new starts after drain", async () => {
  const registry = new SubagentProviderRegistry();
  registry.register("native", provider("native", () => undefined));
  const disposing = registry.dispose();
  await assert.rejects(() => registry.start("native", request()), /registry is draining|not available/);
  await disposing;
});

test("subagent provider lifecycle publishes replacement before draining and removing the old generation", async () => {
  const registry = new SubagentProviderRegistry();
  const events: SubagentProviderLifecycleEvent[] = [];
  const subscription = registry.subscribeLifecycle((event) => events.push(event));
  const first = registry.register("native", provider("native", () => undefined));
  const run = await registry.start("native", request());
  const replacement = registry.replace("native", provider("native", () => undefined));

  assert.deepEqual(events.map((event) => [event.type, event.generation]), [
    ["registered", first.generation],
    ["registered", replacement.registration.generation],
    ["draining", first.generation],
  ]);

  let oldRemoved = false;
  void replacement.previousDisposed.then(() => { oldRemoved = true; });
  await Promise.resolve();
  assert.equal(oldRemoved, false);

  await run.dispose();
  await replacement.previousDisposed;
  assert.equal(oldRemoved, true);
  assert.deepEqual(events.at(-1), {
    type: "removed",
    name: "native",
    generation: first.generation,
    reason: "replaced",
  });
  assert.equal(registry.get("native")?.name, "native");

  await registry.dispose();
  assert.equal(subscription.active, false);
});

test("subagent provider unregister emits an owned removal lifecycle and isolates observers", async () => {
  const registry = new SubagentProviderRegistry();
  const events: SubagentProviderLifecycleEvent[] = [];
  registry.subscribeLifecycle(() => { throw new Error("observer failed"); });
  const subscription = registry.subscribeLifecycle((event) => events.push(event));
  const registration = registry.register("remote", provider("remote", () => undefined));

  await registry.unregister("remote");
  assert.equal(registry.get("remote"), undefined);
  assert.deepEqual(events.slice(1), [
    {
      type: "draining",
      name: "remote",
      generation: registration.generation,
      reason: "unregistered",
    },
    {
      type: "removed",
      name: "remote",
      generation: registration.generation,
      reason: "unregistered",
    },
  ]);

  subscription.dispose();
  assert.equal(subscription.active, false);
  await registry.dispose();
});

test("subagent provider receives the descriptor resolved from its registered identity", async () => {
  const registry = new SubagentProviderRegistry();
  let descriptor: unknown;
  registry.register("remote", {
    name: "provider-object-name-is-not-authoritative",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async (resolved) => {
      descriptor = resolved.descriptor;
      return {
        result: Promise.resolve({
          subagentId: resolved.subagentId,
          definitionId: resolved.definition.id,
          markdown: "ok",
          usage: {},
          turns: 1,
          durationMs: 1,
        }),
        dispose: async () => undefined,
      };
    },
  });

  const run = await registry.start("remote", request());
  assert.deepEqual(descriptor, {
    version: 1,
    mode: "one-shot",
    provider: "remote",
    definitionId: "explore",
  });
  await run.dispose();
  await registry.dispose();
});

test("continuable preparation fails loudly without dispatching the one-shot path", async () => {
  const registry = new SubagentProviderRegistry();
  let oneShotStarts = 0;
  registry.register("one-shot", {
    name: "one-shot",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    start: async () => {
      oneShotStarts += 1;
      throw new Error("one-shot start must not run");
    },
  });

  await assert.rejects(
    registry.prepareContinuable("one-shot", {
      subagentSessionId: "continuable-child",
      parentSessionId: "parent",
      definition: SUBAGENT_DEFINITIONS.explore,
      parentConfig: {} as never,
      parentDependencies: {} as never,
    }),
    /does not support continuable children/,
  );
  assert.equal(oneShotStarts, 0);
  await registry.dispose();
});

test("continuable preparation holds a generation lease and returns detached creation data", async () => {
  const registry = new SubagentProviderRegistry();
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
  let oldDisposed = 0;
  const seedEntries: unknown[] = [];
  registry.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => {
      await preparationGate;
      return { seedEntries: seedEntries as never[] };
    },
    dispose: () => { oldDisposed += 1; },
  });

  const preparing = registry.prepareContinuable("continuable", {
    subagentSessionId: "continuable-child",
    parentSessionId: "parent",
    definition: SUBAGENT_DEFINITIONS.explore,
    parentConfig: {} as never,
    parentDependencies: {} as never,
  });
  await Promise.resolve();
  const replacement = registry.replace("continuable", {
    name: "continuable",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
  });
  assert.equal(oldDisposed, 0);

  releasePreparation();
  const prepared = await preparing;
  seedEntries.push({ mutated: true });
  assert.equal(prepared.provider, "continuable");
  assert.deepEqual(prepared.spec, { seedEntries: [] });
  await replacement.previousDisposed;
  assert.equal(oldDisposed, 1);
  await registry.dispose();
});

test("continuable preparation observes caller abort before provider admission", async () => {
  const registry = new SubagentProviderRegistry();
  let invoked = 0;
  registry.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => {
      invoked += 1;
      return {};
    },
  });
  const controller = new AbortController();
  controller.abort("parent stopped");

  await assert.rejects(
    registry.prepareContinuable("continuable", {
      subagentSessionId: "continuable-child",
      parentSessionId: "parent",
      definition: SUBAGENT_DEFINITIONS.explore,
      parentConfig: {} as never,
      parentDependencies: {} as never,
      abortSignal: controller.signal,
    }),
    /preparation aborted: parent stopped/,
  );
  assert.equal(invoked, 0);
  await registry.dispose();
});

test("continuable preparation rejects provider data that is not lossless JSON", async () => {
  const registry = new SubagentProviderRegistry();
  registry.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => ({
      seedEntries: [{ unsupported: undefined }] as never[],
    }),
  });

  await assert.rejects(
    registry.prepareContinuable("continuable", {
      subagentSessionId: "continuable-child",
      parentSessionId: "parent",
      definition: SUBAGENT_DEFINITIONS.explore,
      parentConfig: {} as never,
      parentDependencies: {} as never,
    }),
    /contains a non-JSON value/,
  );
  await registry.dispose();
});
