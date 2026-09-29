import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectRouterEventBusProvider } from "../../src/cli/ProjectRouterEventBusProvider.js";
import type { RouterRetryProgressEvent } from "../../src/router/protocol/events.js";

test("project Router event provider migrates the legacy log and forwards retry progress", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-router-events-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const oldPath = join(pilotHome, "router-events.jsonl");
  await writeFile(oldPath, "{\"legacy\":true}\n", "utf8");

  const observed: RouterRetryProgressEvent[] = [];
  const provider = new ProjectRouterEventBusProvider({
    pilotHome,
    onRetryProgress: (event) => observed.push(event),
  });
  const retry: RouterRetryProgressEvent = {
    type: "pilotdeck_router_retry_progress",
    sessionId: "session-1",
    turnId: "turn-1",
    attempt: 2,
    maxAttempts: 4,
    delayMs: 250,
    reason: "rate_limit",
    provider: "openai",
    model: "test",
  };

  provider.create().emit(retry);

  const eventsPath = join(pilotHome, "router", "events.jsonl");
  const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ legacy: true }, retry]);
  assert.deepEqual(observed, [retry]);
  await assert.rejects(() => access(oldPath));
});

test("project Router event provider isolates a live observer failure", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-router-events-observer-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const provider = new ProjectRouterEventBusProvider({
    pilotHome,
    onRetryProgress: () => { throw new Error("observer unavailable"); },
  });

  assert.doesNotThrow(() => provider.create().emit({
    type: "pilotdeck_router_retry_progress",
    sessionId: "session-2",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 0,
    reason: "network_error",
    provider: "test",
    model: "model",
  }));
  const eventsPath = join(pilotHome, "router", "events.jsonl");
  assert.match(await readFile(eventsPath, "utf8"), /pilotdeck_router_retry_progress/);
});
