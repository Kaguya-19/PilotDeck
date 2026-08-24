import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryCollector, sanitizeProperties } from "../../src/telemetry/collector.js";
import { resolveTelemetryRuntimeContext, hashTelemetryId } from "../../src/telemetry/context.js";
import { TelemetrySender } from "../../src/telemetry/sender.js";

test("sanitizeProperties removes path-like values recursively", () => {
  assert.deepEqual(sanitizeProperties({
    cwd: "/private/project",
    keep: "value",
    nested: { filePath: "/tmp/file", answer: 42 },
    values: ["ok", "/tmp/secret", null],
  }), { keep: "value", nested: { answer: 42 }, values: ["ok", null] });
});

test("telemetry context hashes installation and session identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-context-"));
  try {
    await writeFile(join(dir, "server-token"), "token-value\n");
    const env = { PILOT_HOME: dir, COMMIT_HASH: "abc123", PILOTDECK_VERSION: "1.2.3", DOCKER_CONTAINER: "1" };
    const context = resolveTelemetryRuntimeContext({ env, pilotHome: dir });
    assert.equal(context.deploymentMode, "docker");
    assert.equal(context.commitHash, "abc123");
    assert.equal(context.appVersion, "1.2.3");
    assert.equal(context.installationId, hashTelemetryId("token-value"));
    assert.deepEqual(resolveTelemetryRuntimeContext({ env, pilotHome: dir }), context);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("telemetry context uses stable fallbacks when no gateway token or explicit metadata exists", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-fallback-"));
  const originalArgv = process.argv[1];
  const originalCwd = process.cwd();
  t.after(async () => {
    process.argv[1] = originalArgv;
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });
  try {
    const context = resolveTelemetryRuntimeContext({
      pilotHome: dir,
      env: { PILOT_HOME: dir, HOME: "/home/test", npm_config_user_agent: "pnpm/10" },
    });
    assert.equal(context.installationId.length, 24);
    assert.equal(context.appVersion, "0.0.0");
    assert.notEqual(context.commitHash, "");

    process.argv[1] = "/usr/local/bin/pilotdeck";
    process.chdir(dir);
    const installerContext = resolveTelemetryRuntimeContext({
      pilotHome: dir,
      env: { PILOT_HOME: dir, HOME: "/home/test", PILOTDECK_VERSION: "test" },
    });
    assert.equal(installerContext.deploymentMode, "curl_installer");
  } finally {
    process.argv[1] = originalArgv;
  }
});

test("telemetry collector emits sanitized, hashed events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-collector-"));
  const requests: Array<{ body: unknown; url: string }> = [];
  try {
    const collector = createTelemetryCollector({
      pilotHome: dir,
      enabled: true,
      env: { ANALYTICS_BASE_URL: "https://telemetry.test/", ANALYTICS_BATCH_SIZE: "10", COMMIT_HASH: "test" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("ok", { status: 200 });
      },
    });
    collector.trackFeatureUsed({ module: "router", loopStage: "model_request", sessionId: "session-secret", metadata: { cwd: "/private" } });
    collector.trackError(new Error("boom"), { module: "router", code: "failure", sessionId: "session-secret", metadata: { provider: "openai", providerBaseUrl: "https://api.example.test/v1" } });
    await collector.flush();
    assert.equal(requests.length, 1);
    const events = requests[0].body as Array<{ sessionId?: string; properties: Record<string, unknown> }>;
    assert.equal(events.length, 3);
    assert.equal(events[0].sessionId, hashTelemetryId("session-secret"));
    assert.equal(events[0].properties.cwd, undefined);
    assert.equal(events[2].properties.providerBaseUrl, "https://api.example.test/v1");
    await collector.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TelemetrySender retries failed batches and persists remaining queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-sender-"));
  const queueFilePath = join(dir, "queue.jsonl");
  let calls = 0;
  try {
    const sender = new TelemetrySender({
      enabled: true,
      baseUrl: "https://telemetry.test/",
      flushIntervalMs: 60_000,
      batchSize: 2,
      timeoutMs: 100,
      maxRetries: 1,
      maxQueueSize: 2,
      queueFilePath,
    }, { fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("bad", { status: 503 });
      return new Response("ok", { status: 200 });
    } });
    const event = { schemaVersion: "analytics.v2" as const, eventId: "e1", eventName: "feature_used" as const, occurredAt: new Date().toISOString(), installationId: "i", instanceId: "x", deploymentMode: "source" as const, commitHash: "c", appVersion: "v", platform: process.platform, properties: {} };
    sender.enqueue(event);
    await sender.flush();
    assert.equal(sender.snapshot().retries, 1);
    await sender.flush();
    assert.equal(sender.snapshot().sent, 1);
    await sender.shutdown();
    assert.equal((await readFile(queueFilePath)).toString(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TelemetrySender handles disabled mode, queue limits, restore and terminal drops", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-sender-edges-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queueFilePath = join(dir, "queue.jsonl");
  const event = { schemaVersion: "analytics.v2" as const, eventId: "edge-1", eventName: "feature_used" as const, occurredAt: new Date().toISOString(), installationId: "i", instanceId: "x", deploymentMode: "source" as const, commitHash: "c", appVersion: "v", platform: process.platform, properties: {} };
  await writeFile(queueFilePath, `${JSON.stringify({ event, attempts: -3 })}\nnot-json\n${JSON.stringify({ attempts: 2 })}\n`, "utf8");
  let calls = 0;
  const sender = new TelemetrySender({ enabled: false, baseUrl: "https://telemetry.test", flushIntervalMs: 60_000, batchSize: 2, timeoutMs: 100, maxRetries: 0, maxQueueSize: 1, queueFilePath }, {
    fetchImpl: async () => { calls += 1; return new Response("bad", { status: 500 }); },
  });
  sender.enqueue(event);
  assert.equal(sender.snapshot().queued, 0);
  sender.setEnabled(true);
  sender.enqueue(event);
  sender.enqueue({ ...event, eventId: "edge-2" });
  await sender.flush();
  assert.equal(sender.snapshot().dropped >= 1, true);
  assert.equal(sender.snapshot().sendFailures, 1);
  assert.equal(calls, 1);
  await sender.shutdown();
  assert.equal((await readFile(queueFilePath, "utf8")).trim(), "");
});

test("telemetry collector honors env parsing, toggles delivery and normalizes invalid metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-telemetry-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const collector = createTelemetryCollector({
    pilotHome: dir,
    env: {
      ANALYTICS_ENABLED: "on",
      ANALYTICS_BASE_URL: " https://telemetry.test/// ",
      ANALYTICS_FLUSH_INTERVAL_MS: "invalid",
      ANALYTICS_BATCH_SIZE: "0",
      ANALYTICS_TIMEOUT_MS: "-1",
      ANALYTICS_MAX_RETRIES: "-1",
      ANALYTICS_MAX_QUEUE_SIZE: "2",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(collector.getConfig().enabled, true);
  assert.equal(collector.getConfig().batchSize, 20);
  collector.trackFeatureLoopStage({ module: "router", ownerModule: "bad" as never, executionKind: "bad" as never, phase: "phase", loopStage: "bad" as never, outcome: "bad" as never, errorCategory: "bad" as never, sessionId: "s", metadata: { model: "m", provider: "p", providerBaseUrl: "not a url" } });
  collector.trackError("plain error", { module: "ui", ownerModule: "ui", code: "bad", loopStage: "bad" as never, errorCategory: "bad" as never, metadata: { provider: "p", model: "m", providerBaseUrl: "https://api.example.test/v1" } });
  await collector.flush();
  assert.equal(requests.length, 1);
  collector.setEnabled(false);
  collector.track("feature_used", { ok: true });
  await collector.flush();
  assert.equal(collector.snapshot().queueDepth, 0);
  await collector.shutdown();
});
