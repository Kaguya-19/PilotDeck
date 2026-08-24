import assert from "node:assert/strict";
import test from "node:test";

import { LRUMap } from "../../src/session/worktree/LRUMap.js";

test("LRUMap rejects non-positive and non-finite capacities", () => {
  for (const capacity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new LRUMap<string, number>(capacity), /capacity must be positive/);
  }
});

test("LRUMap refreshes hits and evicts the least recently used entry", () => {
  const cache = new LRUMap<string, number>(2);
  assert.equal(cache.get("missing"), undefined);
  assert.equal(cache.has("missing"), false);

  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("LRUMap replacement preserves capacity and delete/clear are idempotent", () => {
  const cache = new LRUMap<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.size, 2);
  assert.equal(cache.delete("missing"), false);
  assert.equal(cache.delete("b"), true);
  assert.equal(cache.delete("b"), false);
  cache.clear();
  cache.clear();
  assert.equal(cache.size, 0);
});
