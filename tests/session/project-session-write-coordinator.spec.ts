import assert from "node:assert/strict";
import test from "node:test";

import { ProjectSessionWriteCoordinator } from "../../src/session/storage/ProjectSessionWriteCoordinator.js";

const scope = {
  projectRoot: "/project",
  pilotHome: "/pilot-home",
  sessionId: "session",
};

test("project session write coordinator serializes one session and releases the next writer after failure", async () => {
  const coordinator = new ProjectSessionWriteCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.run(scope, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:fail");
    throw new Error("first write failed");
  });
  const second = coordinator.run(scope, async () => {
    events.push("second:start");
    return "second result";
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /first write failed/);
  assert.equal(await second, "second result");
  assert.deepEqual(events, ["first:start", "first:fail", "second:start"]);

  assert.equal(await coordinator.run(scope, () => "third result"), "third result");
});

test("project session write coordinator permits independent session writers to start together", async () => {
  const coordinator = new ProjectSessionWriteCoordinator();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = coordinator.run(scope, async () => {
    started.push("first");
    await gate;
  });
  const second = coordinator.run({ ...scope, sessionId: "other-session" }, async () => {
    started.push("second");
    await gate;
  });

  await Promise.resolve();
  assert.deepEqual(started, ["first", "second"]);
  release();
  await Promise.all([first, second]);
});
