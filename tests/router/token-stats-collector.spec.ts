import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenStatsCollector, type RouterStatsRecord } from "../../src/router/stats/TokenStatsCollector.js";

function record(overrides: Partial<RouterStatsRecord> = {}): RouterStatsRecord {
  return {
    sessionId: "session-1",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: "provider",
    model: "model",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function enabledConfig(dir: string, extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    filePath: join(dir, "configured-name.jsonl"),
    ...extra,
  } as ConstructorParameters<typeof TokenStatsCollector>[0];
}

test("disabled collector is a no-op and flush remains compatible", async () => {
  const collector = new TokenStatsCollector(undefined);
  collector.observe(record());
  await collector.flush();
  assert.deepEqual(collector.snapshot(), {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalBaselineCost: 0,
    totalSavedCost: 0,
    perScenario: {},
    perModel: {},
    perProvider: {},
    perTier: {},
    perRole: {},
  });
  assert.deepEqual(collector.recent(), []);
  collector.dispose();
});

test("observe calculates configured cost, baseline and aggregate dimensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    const collector = new TokenStatsCollector(enabledConfig(dir, {
      modelPricing: {
        "provider/model": { input: 10, output: 20, cacheRead: 5 },
        "base/base-model": { input: 1, output: 2, cacheRead: 0.5 },
      },
      baselineModel: { provider: "base", model: "base-model" },
    }));
    const first = record({
      tier: "reasoning",
      role: "main",
      usage: { inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 4_000_000 },
    });
    collector.observe(first);
    assert.deepEqual(first.cost, { input: 10, output: 40, cacheRead: 15, total: 105 });
    assert.equal(first.baselineCost, 10.5);

    const native = record({
      sessionId: "session-2",
      provider: "other",
      model: "native",
      usage: { inputTokens: 1, outputTokens: 1, nativeCost: 7 },
      scenarioType: "explicit",
      resolvedFrom: "explicit",
      role: "subagent",
      startedAt: "2026-01-01T01:00:00.000Z",
    });
    collector.observe(native);
    assert.deepEqual(native.cost, { input: 0, output: 0, cacheRead: 0, total: 7 });

    const snapshot = collector.snapshot();
    assert.equal(snapshot.totalRequests, 2);
    assert.equal(snapshot.totalInputTokens, 1_000_001);
    assert.equal(snapshot.totalOutputTokens, 2_000_001);
    assert.equal(snapshot.perScenario.default, 1);
    assert.equal(snapshot.perScenario.explicit, 1);
    assert.equal(snapshot.perProvider.provider, 1);
    assert.equal(snapshot.perRole.main, 1);
    assert.equal(snapshot.perRole.subagent, 1);
    assert.equal(snapshot.perTier.reasoning, 1);
    assert.deepEqual(collector.hourlySnapshots().map((bucket) => bucket.hour), [
      "2026-01-01T00",
      "2026-01-01T01",
    ]);
    assert.equal(collector.sessionSnapshot("session-1")?.requestLog.length, 1);
    assert.equal(collector.recent(1)[0]?.sessionId, "session-2");

    snapshot.perProvider.provider = 99;
    assert.equal(collector.snapshot().perProvider.provider, 1);
    collector.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native cost and same baseline model use the provider-reported or model cost", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    const collector = new TokenStatsCollector(enabledConfig(dir, {
      modelPricing: { "provider/model": { input: 2, output: 4 } },
      baselineModel: { provider: "provider", model: "model" },
    }));
    const next = record({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
    collector.observe(next);
    assert.deepEqual(next.cost, { input: 2, output: 4, cacheRead: 0, total: 6 });
    assert.equal(next.baselineCost, 6);
    collector.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collector rebuilds JSONL, skips malformed records and appends after dispose", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    const jsonl = join(dir, "stats.jsonl");
    writeFileSync(jsonl, [
      JSON.stringify(record({ sessionId: "older", startedAt: "2026-01-01T00:00:00.000Z" })),
      "not-json",
      JSON.stringify({ sessionId: "missing-time" }),
      JSON.stringify(record({ sessionId: "newer", startedAt: "2026-01-01T02:00:00.000Z" })),
    ].join("\n") + "\n");
    const collector = new TokenStatsCollector(enabledConfig(dir));
    assert.equal(collector.snapshot().totalRequests, 2);
    assert.deepEqual(collector.recent(2).map((item) => item.sessionId), ["older", "newer"]);
    collector.dispose();
    collector.observe(record({ sessionId: "after-dispose", startedAt: "2026-01-01T03:00:00.000Z" }));
    assert.match(readFileSync(jsonl, "utf8"), /after-dispose/);
    collector.clear();
    assert.equal(readFileSync(jsonl, "utf8"), "");
    assert.equal(collector.snapshot().totalRequests, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy stats.json is migrated to sorted JSONL and renamed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    const legacy = record({ sessionId: "legacy", startedAt: "2026-01-01T02:00:00.000Z" });
    const earlier = record({ sessionId: "legacy", startedAt: "2026-01-01T01:00:00.000Z" });
    writeFileSync(join(dir, "stats.json"), JSON.stringify({
      sessions: { legacy: { requestLog: [legacy, earlier] } },
    }));
    const collector = new TokenStatsCollector(enabledConfig(dir));
    assert.equal(collector.snapshot().totalRequests, 2);
    assert.deepEqual(collector.recent(2).map((item) => item.startedAt), [
      earlier.startedAt,
      legacy.startedAt,
    ]);
    assert.equal(existsSync(join(dir, "stats.json.bak")), true);
    collector.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hour and session retention removes only the oldest buckets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    const collector = new TokenStatsCollector(enabledConfig(dir));
    for (let hour = 0; hour < 73; hour += 1) {
      const startedAt = "2026-01-01T" + String(hour).padStart(2, "0") + ":00:00.000Z";
      collector.observe(record({ sessionId: "hour-" + hour, startedAt }));
    }
    assert.equal(collector.hourlySnapshots().length, 72);
    assert.equal(collector.hourlySnapshots()[0]?.hour, "2026-01-01T01");

    for (let index = 0; index < 201; index += 1) {
      const second = String(index % 60).padStart(2, "0");
      collector.observe(record({
        sessionId: "session-" + index,
        startedAt: "2026-02-01T00:00:" + second + ".000Z",
        endedAt: "2026-02-01T00:00:" + second + ".500Z",
      }));
    }
    assert.equal(collector.sessionSnapshot("session-0"), undefined);
    assert.ok(collector.sessionSnapshot("session-200"));
    collector.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collector rebuild prunes persisted request logs and handles unknown pricing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-rebuild-boundaries-"));
  try {
    const jsonl = join(dir, "stats.jsonl");
    const lines: string[] = [];
    for (let index = 0; index < 201; index += 1) {
      const hour = String(index).padStart(3, "0");
      lines.push(JSON.stringify(record({
        sessionId: "long-session",
        startedAt: `2026-01-01T${hour}:00:00.000Z`,
        endedAt: `2026-01-01T${hour}:00:01.000Z`,
      })));
    }
    for (let hour = 0; hour < 73; hour += 1) {
      const stamp = String(hour).padStart(2, "0");
      lines.push(JSON.stringify(record({
        sessionId: `hour-${hour}`,
        startedAt: `2026-02-01T${stamp}:00:00.000Z`,
      })));
    }
    writeFileSync(jsonl, `${lines.join("\n")}\n`);

    const collector = new TokenStatsCollector(enabledConfig(dir));
    assert.equal(collector.sessionSnapshot("long-session")?.requestLog.length, 100);
    assert.equal(collector.hourlySnapshots().length, 72);
    const unknown = record({
      sessionId: "unknown-cost",
      provider: "missing-provider",
      model: "missing-model",
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: 0 },
    });
    collector.observe(unknown);
    assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, total: 0 });
    assert.equal(unknown.baselineCost, 0);
    collector.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
