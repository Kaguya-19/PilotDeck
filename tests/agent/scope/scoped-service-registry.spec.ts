import assert from "node:assert/strict";
import test from "node:test";

import {
  ScopedServiceRegistry,
  createScopedServiceToken,
} from "../../../src/agent/scope/index.js";

test("child scopes inherit providers and can remove a local override", async () => {
  const token = createScopedServiceToken<{ source: string }>("test.service");
  const parent = new ScopedServiceRegistry({ name: "parent" });
  const child = parent.createChild({ name: "child" });
  parent.register(token, { source: "parent" });

  assert.equal(await child.run(token, (service) => service.source), "parent");

  const override = child.register(token, { source: "child" });
  assert.equal(await child.run(token, (service) => service.source), "child");

  await override.dispose();
  assert.equal(await child.run(token, (service) => service.source), "parent");

  await parent.dispose();
});

test("child scopes can block inherited capabilities while retaining local override semantics", async () => {
  const token = createScopedServiceToken<{ source: string }>("test.blocked");
  const parent = new ScopedServiceRegistry({ name: "parent-blocked" });
  parent.register(token, { source: "parent" });
  const blocked = parent.createChild({ name: "blocked", blockedTokens: [token] });

  assert.equal(blocked.has(token), false);
  assert.throws(() => blocked.acquire(token), /inheritance is blocked/);

  blocked.register(token, { source: "child" });
  assert.equal(await blocked.run(token, (service) => service.source), "child");

  await blocked.dispose();
  await parent.dispose();
});

test("replacement publishes a new generation while the previous provider drains", async () => {
  const token = createScopedServiceToken<{ source: string }>("test.replaceable");
  const registry = new ScopedServiceRegistry({ name: "replacement" });
  const disposed: string[] = [];
  const original = registry.register(
    token,
    { source: "old" },
    { dispose: (service) => { disposed.push(service.source); } },
  );
  const oldLease = registry.acquire(token);

  let replacementSettled = false;
  const replacement = registry.replace(
    token,
    { source: "new" },
    { dispose: (service) => { disposed.push(service.source); } },
  );
  replacement.previousDisposed.then(() => {
    replacementSettled = true;
  });

  assert.equal(original.state, "draining");
  assert.equal(original.inFlight, 1);
  assert.equal(replacementSettled, false);
  assert.equal(await registry.run(token, (service) => service.source), "new");

  oldLease.release();
  oldLease.release();
  await replacement.previousDisposed;

  assert.equal(original.state, "disposed");
  assert.equal(replacement.registration.generation, original.generation + 1);
  assert.deepEqual(disposed, ["old"]);

  await registry.dispose();
  assert.deepEqual(disposed, ["old", "new"]);
});

test("an operation leased before replacement can finish without blocking the new provider", async () => {
  const token = createScopedServiceToken<{ source: string }>("test.late-result");
  const registry = new ScopedServiceRegistry({ name: "late-result" });
  const disposed: string[] = [];
  registry.register(
    token,
    { source: "old" },
    { dispose: (service) => { disposed.push(service.source); } },
  );

  let finishOld!: () => void;
  const oldFinished = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const oldOperation = registry.run(token, async (service) => {
    await oldFinished;
    return service.source;
  });
  const replacement = registry.replace(
    token,
    { source: "new" },
    { dispose: (service) => { disposed.push(service.source); } },
  );

  assert.equal(await registry.run(token, (service) => service.source), "new");
  assert.deepEqual(disposed, []);

  finishOld();
  assert.equal(await oldOperation, "old");
  await replacement.previousDisposed;
  assert.deepEqual(disposed, ["old"]);

  await registry.dispose();
});

test("scope disposal stops new work, drains children, and is idempotent", async () => {
  const parentToken = createScopedServiceToken<{ source: string }>("test.parent");
  const childToken = createScopedServiceToken<{ source: string }>("test.child");
  const parent = new ScopedServiceRegistry({ name: "parent" });
  const child = parent.createChild({ name: "child" });
  const disposed: string[] = [];
  let markChildDisposed!: () => void;
  const childDisposed = new Promise<void>((resolve) => {
    markChildDisposed = resolve;
  });
  parent.register(parentToken, { source: "parent" }, {
    dispose: (service) => { disposed.push(service.source); },
  });
  child.register(childToken, { source: "child" }, {
    dispose: (service) => {
      disposed.push(service.source);
      markChildDisposed();
    },
  });
  const lease = child.acquire(parentToken);

  const firstDispose = parent.dispose();
  const secondDispose = parent.dispose();
  assert.equal(firstDispose, secondDispose);
  assert.equal(parent.state, "draining");
  assert.equal(parent.inFlight, 1);
  assert.equal(child.inFlight, 1);
  assert.throws(() => parent.register(parentToken, { source: "late" }), /is draining/);
  assert.throws(() => child.acquire(parentToken), /is draining/);
  assert.throws(() => parent.createChild(), /is draining/);
  assert.deepEqual(disposed, []);

  lease.release();
  await childDisposed;
  assert.deepEqual(disposed, ["child"]);
  await firstDispose;

  assert.equal(parent.state, "disposed");
  assert.equal(child.state, "disposed");
  assert.equal(parent.inFlight, 0);
  assert.equal(child.inFlight, 0);
  assert.deepEqual(disposed, ["child", "parent"]);
});

test("scope disposal attempts every provider and aggregates disposer failures", async () => {
  const firstToken = createScopedServiceToken<object>("test.failure.first");
  const secondToken = createScopedServiceToken<object>("test.failure.second");
  const registry = new ScopedServiceRegistry({ name: "failure" });
  const disposed: string[] = [];
  registry.register(firstToken, {}, {
    dispose: () => {
      disposed.push("first");
      throw new Error("first failed");
    },
  });
  registry.register(secondToken, {}, {
    dispose: () => {
      disposed.push("second");
    },
  });

  await assert.rejects(registry.dispose(), AggregateError);
  assert.equal(registry.state, "disposed");
  assert.deepEqual(disposed.sort(), ["first", "second"]);
});
