import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { AgentFactoryProvider } from "../../../src/agent/scope/AgentFactoryProvider.js";
import { AgentHandle } from "../../../src/agent/scope/AgentHandle.js";
import { AgentRegistry } from "../../../src/agent/scope/AgentRegistry.js";

test("agent factory keeps async setup unpublished until synchronous commit", async () => {
  const registry = new AgentRegistry({ name: "publication-test" });
  const provider = new AgentFactoryProvider({ registry });
  const setupEntered = deferred<void>();
  const releaseSetup = deferred<void>();
  const handle = new AgentHandle(fakeSession("agent-1"));

  const creation = provider.create("agent-1", () => handle, {
    setup: async () => {
      setupEntered.resolve();
      await releaseSetup.promise;
    },
  });

  await setupEntered.promise;
  assert.equal(registry.get("agent-1"), undefined);
  assert.equal(provider.inFlightTransactions, 1);

  releaseSetup.resolve();
  assert.equal(await creation, handle);
  assert.equal(registry.get("agent-1"), handle);

  await provider.dispose();
  await registry.dispose();
});

test("agent factory rolls back setup and publish failures without replacing a live agent", async () => {
  const registry = new AgentRegistry({ name: "rollback-test" });
  const provider = new AgentFactoryProvider({ registry });
  const previous = new AgentHandle(fakeSession("previous"));
  registry.register("agent-1", previous);

  let setupDisposed = 0;
  const setupCandidate = new AgentHandle(fakeSession("setup-candidate"), {
    onDispose: () => { setupDisposed += 1; },
  });
  await assert.rejects(
    provider.replace("agent-1", () => setupCandidate, {
      setup: async () => { throw new Error("setup failed"); },
    }),
    /setup failed/,
  );
  assert.equal(registry.get("agent-1"), previous);
  assert.equal(previous.state, "active");
  assert.equal(setupCandidate.state, "disposed");
  assert.equal(setupDisposed, 1);

  let conflictDisposed = 0;
  const conflictCandidate = new AgentHandle(fakeSession("conflict-candidate"), {
    onDispose: () => { conflictDisposed += 1; },
  });
  await assert.rejects(
    provider.create("agent-1", () => conflictCandidate),
    /already registered/,
  );
  assert.equal(registry.get("agent-1"), previous);
  assert.equal(conflictCandidate.state, "disposed");
  assert.equal(conflictDisposed, 1);
  assert.equal(provider.ownedCount, 0);

  await provider.dispose();
  await registry.dispose();
});

test("agent factory provider unload drains every handle it created and is idempotent", async () => {
  const registry = new AgentRegistry({ name: "provider-dispose-test" });
  const provider = new AgentFactoryProvider({ registry });
  const disposed: string[] = [];
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve; });
  const active = new AgentHandle({
    async *submit() {
      yield { type: "session_started", sessionId: "active" } as const;
      await turnFinished;
    },
    abort() {
      finishTurn();
    },
    snapshot() {
      return idleSnapshot("active");
    },
  } as unknown as AgentSession, {
    onDispose: () => { disposed.push("active"); },
  });
  const idle = new AgentHandle(fakeSession("idle"), {
    onDispose: () => { disposed.push("idle"); },
  });

  await provider.create("active", () => active);
  await provider.create("idle", () => idle);
  const iterator = active.submit({ type: "text", text: "run" });
  await iterator.next();
  const completion = iterator.next();

  const firstDispose = provider.dispose();
  const secondDispose = provider.dispose();
  assert.equal(firstDispose, secondDispose);
  assert.equal(provider.state, "draining");
  assert.equal((await completion).done, true);
  await firstDispose;

  assert.equal(provider.state, "disposed");
  assert.equal(provider.inFlightTransactions, 0);
  assert.equal(provider.ownedCount, 0);
  assert.equal(registry.size, 0);
  assert.deepEqual(disposed.sort(), ["active", "idle"]);
  await registry.dispose();
});

test("provider unload prevents a pending setup from publishing and waits for rollback", async () => {
  const registry = new AgentRegistry({ name: "provider-pending-test" });
  const provider = new AgentFactoryProvider({ registry });
  const setupEntered = deferred<void>();
  const releaseSetup = deferred<void>();
  const candidate = new AgentHandle(fakeSession("pending"));
  const creation = provider.create("pending", () => candidate, {
    setup: async () => {
      setupEntered.resolve();
      await releaseSetup.promise;
    },
  });

  await setupEntered.promise;
  const disposal = provider.dispose();
  releaseSetup.resolve();

  await assert.rejects(creation, /provider is draining/);
  await disposal;
  assert.equal(candidate.state, "disposed");
  assert.equal(registry.get("pending"), undefined);
  assert.equal(provider.inFlightTransactions, 0);
  await registry.dispose();
});

function fakeSession(sessionId: string): AgentSession {
  return {
    async *submit() {},
    abort() {},
    snapshot() {
      return idleSnapshot(sessionId);
    },
  } as unknown as AgentSession;
}

function idleSnapshot(sessionId: string) {
  return {
    sessionId,
    messages: [],
    usage: {},
    status: "idle" as const,
    permissionDenials: [],
    abortController: new AbortController(),
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
