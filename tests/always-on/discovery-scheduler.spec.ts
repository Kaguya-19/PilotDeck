import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultAlwaysOnConfig } from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { AlwaysOnError } from "../../src/always-on/protocol/errors.js";
import type { AlwaysOnDiscoveryState } from "../../src/always-on/protocol/types.js";
import { DiscoveryScheduler } from "../../src/always-on/runtime/DiscoveryScheduler.js";
import { defaultDiscoveryState } from "../../src/always-on/storage/DiscoveryStateStore.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";

test("DiscoveryScheduler fires once, releases its lock, and stops idempotently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-discovery-scheduler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectKey = join(root, "project");
  await mkdir(projectKey, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey });
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.dormancy.enabled = false;
  config.projects[projectKey] = { enabled: true };

  let state: AlwaysOnDiscoveryState = defaultDiscoveryState(new Date("2026-01-01T00:00:00.000Z"));
  let fireCount = 0;
  const stateStore = {
    read: async () => state,
    markFireStarted: async (runId: string, now: Date) => {
      state = { ...state, lastRunId: runId, lastFireStartedAt: now.toISOString() };
      return state;
    },
    clearDormant: async () => state,
  };
  const scheduler = new DiscoveryScheduler({
    config,
    projectKey,
    paths,
    stateStore: stateStore as never,
    cycleStore: { getRecord: async () => undefined } as never,
    leases: { listFresh: () => [] } as never,
    fire: { run: async () => { fireCount += 1; return { outcome: "executed" }; } } as never,
    uuid: () => "run-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    logger: { info: () => undefined, warn: () => undefined },
    isSessionInFlight: () => false,
  });

  await scheduler.start();
  await scheduler.start();
  assert.deepEqual(await scheduler.runTickOnce(), { outcome: "fired" });
  assert.equal(fireCount, 1);
  assert.equal(state.lastRunId, "run-1");
  await scheduler.stop();
  await scheduler.stop();
  assert.deepEqual(await scheduler.runTickOnce(), { outcome: "blocked", reason: "disabled" });
});

test("DiscoveryScheduler reports gate, cycle, and lock blocks without firing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-discovery-blocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectKey = join(root, "project");
  await mkdir(projectKey, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey });
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.dormancy.enabled = false;
  config.workspace.maxPlansPerCycle = 1;
  config.projects[projectKey] = { enabled: true };

  const state = {
    ...defaultDiscoveryState(new Date("2026-01-01T00:00:00.000Z")),
    activeWorkCycleId: "cycle",
  };
  const baseDeps = {
    config,
    projectKey,
    paths,
    stateStore: {
      read: async () => state,
      markFireStarted: async () => state,
      clearDormant: async () => state,
    } as never,
    leases: { listFresh: () => [] } as never,
    fire: { run: async () => { throw new Error("must not fire"); } } as never,
    uuid: () => "run-blocked",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    logger: { info: () => undefined, warn: () => undefined },
  };

  const busy = new DiscoveryScheduler({ ...baseDeps, cycleStore: { getRecord: async () => undefined } as never, isSessionInFlight: () => true });
  assert.deepEqual(await busy.runTickOnce(), { outcome: "blocked", reason: "agent_busy" });

  const full = new DiscoveryScheduler({
    ...baseDeps,
    cycleStore: { getRecord: async () => ({ status: "active", planIds: ["existing"] }) } as never,
    isSessionInFlight: () => false,
  });
  assert.deepEqual(await full.runTickOnce(), { outcome: "blocked", reason: "cycle_full" });

  await mkdir(join(paths.projectDir, "locks"), { recursive: true });
  await writeFile(paths.discoveryLockFile, "held", "utf8");
  const lock = new DiscoveryScheduler({ ...baseDeps, cycleStore: { getRecord: async () => undefined } as never, isSessionInFlight: () => false });
  assert.deepEqual(await lock.runTickOnce(), { outcome: "blocked", reason: "lock_busy" });
});

test("DiscoveryScheduler converts fire failures and always removes the discovery lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-discovery-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectKey = join(root, "project");
  await mkdir(projectKey, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey });
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.dormancy.enabled = false;
  config.projects[projectKey] = { enabled: true };
  const state = defaultDiscoveryState(new Date("2026-01-01T00:00:00.000Z"));
  const scheduler = new DiscoveryScheduler({
    config,
    projectKey,
    paths,
    stateStore: { read: async () => state, markFireStarted: async () => state, clearDormant: async () => state } as never,
    cycleStore: { getRecord: async () => undefined } as never,
    leases: { listFresh: () => [] } as never,
    fire: { run: async () => { throw new Error("fire failed"); } } as never,
    uuid: () => "run-failure",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    logger: { info: () => undefined, warn: () => undefined },
    isSessionInFlight: () => false,
  });
  await assert.rejects(() => scheduler.runTickOnce(), (error: unknown) => error instanceof AlwaysOnError && error.code === "internal");
  assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(paths.discoveryLockFile)), false);
});

test("DiscoveryScheduler logs scheduled tick failures and handles dormant and non-full cycles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-discovery-scheduled-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectKey = join(root, "project");
  await mkdir(projectKey, { recursive: true });
  const paths = resolveAlwaysOnPaths({ pilotHome: join(root, "home"), projectKey });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const config = defaultAlwaysOnConfig();
  config.enabled = true;
  config.trigger.enabled = true;
  config.dormancy.enabled = true;
  config.projects[projectKey] = { enabled: true };

  const warnings: string[] = [];
  let state: AlwaysOnDiscoveryState = {
    ...defaultDiscoveryState(now),
    dormant: { since: now.toISOString(), lastBaselineAt: now.toISOString() },
  };
  const stateStore = {
    read: async () => state,
    markFireStarted: async () => state,
    clearDormant: async () => state,
  };

  const scheduler = new DiscoveryScheduler({
    config,
    projectKey,
    paths,
    stateStore: stateStore as never,
    cycleStore: { getRecord: async () => undefined } as never,
    leases: { listFresh: () => [] } as never,
    fire: { run: async () => ({ outcome: "no_plan" }) } as never,
    uuid: () => "dormant-run",
    now: () => now,
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    isSessionInFlight: () => false,
  });
  assert.deepEqual(await scheduler.runTickOnce(), { outcome: "blocked", reason: "dormant_no_signal" });
  await scheduler.stop();

  // An active but non-full cycle must still permit a fire.
  state = { ...defaultDiscoveryState(now), activeWorkCycleId: "cycle" };
  let fires = 0;
  const cycleScheduler = new DiscoveryScheduler({
    config: { ...config, dormancy: { ...config.dormancy, enabled: false }, workspace: { ...config.workspace, maxPlansPerCycle: 2 } },
    projectKey,
    paths: resolveAlwaysOnPaths({ pilotHome: join(root, "home-2"), projectKey }),
    stateStore: stateStore as never,
    cycleStore: { getRecord: async () => ({ status: "completed", planIds: ["old"] }) } as never,
    leases: { listFresh: () => [] } as never,
    fire: { run: async () => { fires += 1; return { outcome: "executed" }; } } as never,
    uuid: () => "cycle-run",
    now: () => now,
    logger: { info: () => undefined, warn: () => undefined },
    isSessionInFlight: () => false,
  });
  assert.deepEqual(await cycleScheduler.runTickOnce(), { outcome: "fired" });
  assert.equal(fires, 1);
  await cycleScheduler.stop();

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduled: (() => void) | undefined;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    scheduled = callback as () => void;
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  try {
    const failing = new DiscoveryScheduler({
      config: { ...config, dormancy: { ...config.dormancy, enabled: false } },
      projectKey,
      paths: resolveAlwaysOnPaths({ pilotHome: join(root, "home-3"), projectKey }),
      stateStore: { ...stateStore, read: async () => defaultDiscoveryState(now) } as never,
      cycleStore: { getRecord: async () => undefined } as never,
      leases: { listFresh: () => [] } as never,
      fire: { run: async () => { throw new Error("scheduled failure"); } } as never,
      uuid: () => "scheduled-run",
      now: () => now,
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
      isSessionInFlight: () => false,
    });
    await failing.start();
    assert.ok(scheduled);
    scheduled!();
    await failing.stop();
    assert.ok(warnings.some((message) => message.includes("always-on tick failed")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
