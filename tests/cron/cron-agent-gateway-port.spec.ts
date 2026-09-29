import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CronTask } from "../../src/cron/protocol/types.js";
import { CronFire, type CronActiveRun } from "../../src/cron/runtime/CronFire.js";
import type { CronAgentGatewayPort } from "../../src/cron/runtime/CronAgentGatewayPort.js";
import { resolveCronPaths } from "../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../src/cron/storage/CronTaskStore.js";

function task(projectKey: string): CronTask {
  return {
    schemaVersion: 1,
    taskId: "task-port",
    message: "Summarize the project state",
    schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    status: "scheduled",
    sessionKey: "cron:task-port",
    channelKey: "cron",
    projectKey,
    timezone: "UTC",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    nextRunAt: "2026-09-09T01:00:00.000Z",
    revision: 0,
    scheduleComputationVersion: 2,
  };
}

test("CronFire runs through the narrow agent gateway facade and persists its terminal result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-agent-port-"));
  const projectKey = join(root, "project");
  const store = new CronTaskStore(resolveCronPaths({ pilotHome: root, projectKey }));
  const scheduled = task(projectKey);
  const active = new Map<string, CronActiveRun>();
  const submitted: string[] = [];
  const agentGateway: CronAgentGatewayPort = {
    async *submitTurn(input) {
      submitted.push(input.sessionKey);
      yield { type: "turn_started", runId: input.runId };
      yield { type: "assistant_text_delta", text: "Cron result" };
    },
    async abortTurn() {
      assert.fail("CronFire must not abort a successful run.");
    },
    async closeSession() {},
  };

  try {
    await store.putTask(scheduled);
    const fire = new CronFire({
      gateway: agentGateway,
      store,
      now: () => new Date("2026-09-09T01:00:00.000Z"),
      registerActiveRun: (run) => active.set(run.runId, run),
      unregisterActiveRun: (runId) => {
        const run = active.get(runId);
        active.delete(runId);
        return run;
      },
      getActiveRun: (runId) => active.get(runId),
      runTimeoutMs: 60_000,
      defaultTimezone: "UTC",
      releaseTaskSession: async () => undefined,
    });

    await fire.runTask(scheduled, "run-port");

    assert.deepEqual(submitted, [scheduled.sessionKey]);
    assert.equal(active.size, 0);
    const [record] = await store.listRuns(1);
    assert.equal(record?.runId, "run-port");
    assert.equal(record?.outcome, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
