import assert from "node:assert/strict";
import test from "node:test";

import type { ModelConfig } from "../../../src/model/protocol/canonical.js";
import { classifyConfigChanges, diffConfigSnapshots } from "../../../src/pilot/config/classifyChanges.js";
import { sha256, stableStringify } from "../../../src/pilot/config/hash.js";
import { mergeConfigSources } from "../../../src/pilot/config/merge.js";
import { parseMemoryConfig } from "../../../src/pilot/config/parseMemoryConfig.js";
import { parseAdaptersConfig, parseGatewayConfig } from "../../../src/pilot/config/parseGatewayConfig.js";
import { redactConfig } from "../../../src/pilot/config/redact.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("config merge recursively overrides objects and replaces arrays", () => {
  assert.deepEqual(mergeConfigSources(
    { agent: { model: "openai/old" }, list: [1, 2] },
    undefined,
    { agent: { temperature: 0.2 }, list: [3] },
  ), {
    agent: { model: "openai/old", temperature: 0.2 },
    list: [3],
  });
  assert.deepEqual(mergeConfigSources({ keep: true }, "invalid", { replace: true }), { replace: true });
});

test("config hashing is deterministic across object insertion order and arrays", () => {
  assert.equal(stableStringify({ z: 1, a: { d: false, c: ["x", null] } }), '{"a":{"c":["x",null],"d":false},"z":1}');
  assert.equal(stableStringify(undefined), undefined);
  assert.equal(sha256("pilotdeck"), sha256("pilotdeck"));
  assert.notEqual(sha256("pilotdeck"), sha256("PilotDeck"));
});

test("config redaction removes nested credentials but preserves non-secret values", () => {
  assert.deepEqual(redactConfig({ apiKey: "secret", nested: { authorization: "Bearer token", value: 3 }, values: [{ token: "x" }, "plain"] }), {
    apiKey: "<redacted>",
    nested: { authorization: "<redacted>", value: 3 },
    values: [{ token: "<redacted>" }, "plain"],
  });
});

test("config diff and classification cover runtime, request and restart boundaries", () => {
  const changed = diffConfigSnapshots(
    { config: { agent: { model: "a" }, router: { scenarios: { default: "a" } }, extension: { includeHookEvents: false } } },
    { config: { agent: { model: "b" }, router: { scenarios: { default: "b" } }, extension: { includeHookEvents: true } } },
  );
  assert.deepEqual(changed, ["agent.model", "extension.includeHookEvents", "router.scenarios.default"]);
  assert.deepEqual(classifyConfigChanges([
    "agent.model",
    "model.providers",
    "extension.includeHookEvents",
    "extension.plugins",
    "router.scenarios.default",
    "router.tokenSaver.judge.model",
    "router.autoOrchestrate.skillExtensionId",
    "router.stats.enabled",
    "alwaysOn.enabled",
    "cron.schedule",
    "tools.webSearch",
    "proxy.url",
    "unknown.field",
  ]), ["next-request", "runtime-live", "next-runtime", "restart-required"]);
});

test("gateway and adapter parsers preserve defaults and emit compatibility diagnostics", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  assert.deepEqual(parseGatewayConfig({ tokenPath: "/tmp/old-token", port: 1234, maxPerSessionMcpInstances: 0 }, diagnostics), {
    port: 1234,
    bindAddress: "127.0.0.1",
    idleSessionTimeoutMinutes: 30,
    idleSweepIntervalSeconds: 60,
    memoryDiagnostics: false,
    staticAssetsPath: undefined,
    maxPerSessionMcpInstances: 1,
  });
  assert.equal(diagnostics.some((item) => item.code === "GATEWAY_TOKEN_PATH_REMOVED"), true);

  const adapters = parseAdaptersConfig({
    cli: { autoConnectServer: false },
    feishu: { enabled: true, connectionMode: "webhook", domainName: "lark" },
    qq: { enabled: true, allowGroups: ["g", 1], triggerPrefixes: ["/", false], maxMessageLength: 20 },
    telegram: { enabled: true, token: "token", extra: { region: "test" } },
  }, diagnostics);
  assert.equal(adapters?.cli?.autoConnectServer, false);
  assert.equal(adapters?.feishu?.connectionMode, "webhook");
  assert.deepEqual(adapters?.qq?.allowGroups, ["g"]);
  assert.equal(adapters?.telegram?.extra?.region, "test");
});

test("gateway parser rejects malformed and non-loopback configurations", () => {
  const malformed: PilotConfigDiagnostic[] = [];
  assert.equal(parseGatewayConfig("invalid", malformed), undefined);
  assert.deepEqual(malformed, [{
    code: "GATEWAY_CONFIG_INVALID",
    severity: "fatal",
    message: "gateway config must be an object.",
    path: "gateway",
    recoverable: false,
  }]);

  const diagnostics: PilotConfigDiagnostic[] = [];
  const parsed = parseGatewayConfig({
    bindAddress: "0.0.0.0",
    port: "bad",
    idleSessionTimeoutMinutes: Infinity,
    idleSweepIntervalSeconds: NaN,
    memoryDiagnostics: "yes",
    staticAssetsPath: 42,
    maxPerSessionMcpInstances: -3,
  }, diagnostics);
  assert.deepEqual(parsed, {
    port: 18789,
    bindAddress: "127.0.0.1",
    idleSessionTimeoutMinutes: 30,
    idleSweepIntervalSeconds: 60,
    memoryDiagnostics: false,
    staticAssetsPath: undefined,
    maxPerSessionMcpInstances: 1,
  });
  assert.deepEqual(diagnostics.map((item) => item.code), ["GATEWAY_BIND_ADDRESS_UNSUPPORTED"]);
});

test("adapter parser filters malformed platform values and normalizes supported fields", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  assert.equal(parseAdaptersConfig("invalid", diagnostics), undefined);
  assert.equal(diagnostics[0]?.code, "ADAPTERS_CONFIG_INVALID");

  const adapters = parseAdaptersConfig({
    cli: "invalid",
    tui: { autoConnectServer: "invalid" },
    feishu: { enabled: "yes", connectionMode: "poll", domainName: "other", defaultSessionLabel: 10 },
    weixin: { enabled: true },
    qq: { enabled: false, allowGroups: "group", triggerPrefixes: ["/", 1], maxMessageLength: Infinity },
    signal: { enabled: true, apiKey: 12, webhookUrl: "https://example.invalid", extra: [] },
    slack: null,
  }, diagnostics);

  assert.deepEqual(adapters?.cli, undefined);
  assert.deepEqual(adapters?.tui, { autoConnectServer: true });
  assert.deepEqual(adapters?.feishu, {
    enabled: false,
    appId: undefined,
    appSecret: undefined,
    encryptKey: undefined,
    verifyToken: undefined,
    defaultSessionLabel: "general",
    connectionMode: undefined,
    domainName: undefined,
  });
  assert.deepEqual(adapters?.weixin, { enabled: true });
  assert.deepEqual(adapters?.qq, {
    enabled: false,
    appId: undefined,
    clientSecret: undefined,
    allowGroups: undefined,
    triggerPrefixes: ["/"],
    maxMessageLength: undefined,
  });
  assert.deepEqual(adapters?.signal, {
    enabled: true,
    token: undefined,
    apiKey: undefined,
    webhookUrl: "https://example.invalid",
    extra: undefined,
  });
});

test("memory parser supports nested and legacy schedule fields and validates provider", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseMemoryConfig({
    enabled: true,
    captureStrategy: "full_session",
    includeAssistant: false,
    model: "openai/gpt",
    schedule: { reasoningMode: "accuracy_first", autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 10 },
    heartbeatBatchSize: 4.8,
    unknown: true,
  }, diagnostics, "/pilot/memory");
  assert.equal(config?.rootDir, "/pilot/memory");
  assert.equal(config?.captureStrategy, "full_session");
  assert.equal(config?.schedule?.reasoningMode, "accuracy_first");
  assert.equal(config?.heartbeatBatchSize, 4);
  assert.equal(diagnostics.some((item) => item.code === "CONFIG_MEMORY_UNKNOWN_FIELD"), true);

  const legacy = parseMemoryConfig({ enabled: false, reasoningMode: "answer_first", autoIndexIntervalMinutes: 5 }, [], "/memory");
  assert.deepEqual(legacy?.schedule, { reasoningMode: "answer_first", autoIndexIntervalMinutes: 5 });
  const invalidDiagnostics: PilotConfigDiagnostic[] = [];
  assert.equal(parseMemoryConfig({ provider: "other" }, invalidDiagnostics, "/memory"), undefined);
  assert.equal(invalidDiagnostics.some((item) => item.code === "CONFIG_MEMORY_PROVIDER_UNSUPPORTED" && item.severity === "fatal"), true);
});

test("memory parser reports malformed sections and validates scalar boundaries", () => {
  const missing: PilotConfigDiagnostic[] = [];
  assert.equal(parseMemoryConfig(undefined, missing, "/memory"), undefined);

  const malformed: PilotConfigDiagnostic[] = [];
  assert.equal(parseMemoryConfig("invalid", malformed, "/memory"), undefined);
  assert.equal(malformed[0]?.code, "CONFIG_MEMORY_INVALID");

  assert.throws(() => parseMemoryConfig({ schedule: [] }, [], "/memory"), /memory\.schedule must be an object/);
  assert.throws(() => parseMemoryConfig({ captureStrategy: "other" }, [], "/memory"), /captureStrategy/);
  assert.throws(() => parseMemoryConfig({ includeAssistant: "yes" }, [], "/memory"), /includeAssistant/);
  assert.throws(() => parseMemoryConfig({ rootDir: 1 }, [], "/memory"), /rootDir/);
  assert.throws(() => parseMemoryConfig({ maxMessageChars: 0 }, [], "/memory"), /maxMessageChars/);
  assert.throws(() => parseMemoryConfig({ retrievalTimeoutMs: 0 }, [], "/memory"), /retrievalTimeoutMs/);
  assert.throws(() => parseMemoryConfig({ heartbeatBatchSize: 0 }, [], "/memory"), /heartbeatBatchSize/);
  assert.throws(() => parseMemoryConfig({ apiType: "other" }, [], "/memory"), /apiType/);
  assert.throws(() => parseMemoryConfig({ schedule: { reasoningMode: "other" } }, [], "/memory"), /reasoningMode/);
  assert.throws(() => parseMemoryConfig({ schedule: { autoIndexIntervalMinutes: -1 } }, [], "/memory"), /autoIndexIntervalMinutes/);
  assert.equal(parseMemoryConfig({ schedule: { autoDreamIntervalMinutes: 1.2 } }, [], "/memory")?.schedule?.autoDreamIntervalMinutes, 1);
  assert.throws(() => parseMemoryConfig({ model: "missing-separator" }, [], "/memory"), /provider\/model/);
  assert.throws(() => parseMemoryConfig({ model: 1 }, [], "/memory"), /provider\/model/);
});

test("memory parser diagnoses model references against the configured provider catalog", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const modelConfig = {
    providers: {
      openai: { models: { known: {} } },
    },
  } as unknown as ModelConfig;

  assert.equal(parseMemoryConfig({ model: "missing/model" }, diagnostics, "/memory", modelConfig)?.model, "missing/model");
  assert.equal(diagnostics[0]?.code, "CONFIG_MEMORY_MODEL_PROVIDER_NOT_FOUND");

  diagnostics.length = 0;
  const config = parseMemoryConfig({ model: "openai/missing" }, diagnostics, "/memory", modelConfig);
  assert.equal(config?.model, "openai/missing");
  assert.equal(diagnostics[0]?.code, "CONFIG_MEMORY_MODEL_NOT_FOUND");

  diagnostics.length = 0;
  assert.equal(parseMemoryConfig({ model: "openai/known", apiType: "google" }, diagnostics, "/memory", modelConfig)?.apiType, "google");
  assert.deepEqual(diagnostics, []);
});
