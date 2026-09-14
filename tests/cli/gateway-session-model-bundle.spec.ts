import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewaySessionModelBundle } from "../../src/cli/GatewaySessionModelBundle.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type {
  ExplicitModelSelection,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelSelection,
} from "../../src/gateway/protocol/types.js";
import type {
  SessionModelSelectionPolicy,
  SessionModelSelectionPort,
} from "../../src/model/session/SessionModelSelectionPort.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";
import type {
  ProjectSessionStorageBackends,
  ProjectSessionStorageProvider,
  ProjectSessionStorageProviderInput,
} from "../../src/session/storage/ProjectSessionStorageProvider.js";

test("gateway session model bundle keeps model policy, transcript state, and router ownership separate", async () => {
  const stored = new Map<string, SessionModelSelection>();
  const calls: string[] = [];
  const selectionPort: SessionModelSelectionPort = {
    async read(input) {
      calls.push(`read:${input.projectKey}:${input.sessionKey}`);
      return stored.get(input.sessionKey);
    },
    async write(input) {
      calls.push(`write:${input.projectKey}:${input.sessionKey}:${input.selection.mode}`);
      stored.set(input.sessionKey, input.selection);
    },
    async clear(input) {
      calls.push(`clear:${input.projectKey}:${input.sessionKey}`);
      stored.delete(input.sessionKey);
    },
  };
  const policy: SessionModelSelectionPolicy = {
    listCatalog(input: ModelCatalogListInput): ModelCatalogListResult {
      calls.push(`catalog:${input.projectKey}`);
      return { items: [], router: { enabled: true, autoAvailable: true } };
    },
    validateSelection(projectKey, selection) {
      calls.push(`validate:${projectKey}:${selection.mode}`);
    },
    validateExplicit(projectKey, selection) {
      calls.push(`validate-explicit:${projectKey}:${selection.provider}/${selection.model}`);
    },
    resolveDefault(projectKey) {
      calls.push(`default:${projectKey}`);
      return { provider: "router-provider", model: "router-model", source: "router" };
    },
  };
  const closed: string[] = [];
  const bundle = new GatewaySessionModelBundle({
    fallbackProjectKey: "/fallback",
    resolveProjectKey: async (projectKey) => projectKey === "alias" ? "/resolved" : projectKey,
    router: {
      hasActiveTurn: (sessionKey) => sessionKey === "busy",
      close: async (sessionKey) => { closed.push(sessionKey); },
    },
    selectionPort,
    policy,
  });

  const saved: ExplicitModelSelection = {
    mode: "model",
    provider: "session-provider",
    model: "session-model",
    reasoning: 0.6,
  };
  assert.deepEqual(await bundle.modelCatalogList({ projectKey: "alias" }), {
    items: [],
    router: { enabled: true, autoAvailable: true },
  });
  const set = await bundle.sessionModelSet({
    projectKey: "alias",
    sessionKey: "session",
    selection: saved,
  });
  assert.deepEqual(set, {
    projectKey: "/resolved",
    sessionKey: "session",
    saved,
    effective: {
      provider: "session-provider",
      model: "session-model",
      source: "session",
      reasoning: 0.6,
      temperature: undefined,
      speed: undefined,
    },
  });
  assert.deepEqual(closed, ["session"]);

  assert.deepEqual(await bundle.resolveTurnModelSelection({
    projectKey: "alias",
    sessionKey: "session",
  }), { selection: saved, source: "session" });
  const turn: ExplicitModelSelection = { mode: "model", provider: "turn-provider", model: "turn-model" };
  assert.deepEqual(await bundle.resolveTurnModelSelection({
    sessionKey: "session",
    modelOverride: turn,
  }), { selection: turn, source: "turn" });

  await bundle.sessionModelClear({ projectKey: "alias", sessionKey: "session" });
  assert.deepEqual(await bundle.resolveTurnModelSelection({ sessionKey: "session" }), { source: "router" });
  await assert.rejects(
    bundle.sessionModelSet({ projectKey: "alias", sessionKey: "busy", selection: saved }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_BUSY",
  );
  assert.ok(calls.includes("validate:/resolved:model"));
  assert.ok(calls.includes("validate-explicit:/fallback:turn-provider/turn-model"));
  assert.ok(calls.includes("clear:/resolved:session"));
  assert.ok(calls.includes("catalog:/resolved"));
});

test("local gateway wires the transcript-backed session model bundle", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-model-selection-"));
  t.after(async () => {
    await rm(pilotHome, { recursive: true, force: true });
  });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: custom/default-model
model:
  providers:
    custom:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        default-model: {}
`, "utf8");

  const local = createLocalGateway({
    projectRoot: pilotHome,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome },
  });
  t.after(async () => {
    await local.dispose();
  });
  const input = { projectKey: pilotHome, sessionKey: "web:model-bundle" };
  const selected = { mode: "model" as const, provider: "custom", model: "default-model" };

  const catalog = await local.gateway.modelCatalogList!({ projectKey: pilotHome });
  assert.ok(catalog.items.some((item) => item.id === "custom/default-model"));

  const written = await local.gateway.sessionModelSet!(
    { ...input, selection: selected },
  );
  assert.deepEqual(written.saved, selected);
  assert.equal(written.effective.source, "session");
  assert.deepEqual((await local.gateway.sessionModelGet!(input)).saved, selected);

  await local.gateway.sessionModelClear!(input);
  const cleared = await local.gateway.sessionModelGet!(input);
  assert.equal(cleared.saved, undefined);
  assert.deepEqual(cleared.effective, {
    provider: "custom",
    model: "default-model",
    source: "default",
  });
});

test("local gateway shares one storage writer coordinator between session model selection and status writes", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-model-selection-provider-"));
  t.after(async () => {
    await rm(pilotHome, { recursive: true, force: true });
  });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: custom/default-model
model:
  providers:
    custom:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        default-model: {}
`, "utf8");

  const calls: ProjectSessionStorageProviderInput[] = [];
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      calls.push({ ...input });
      let backend = backends.get(input.transcriptPath);
      if (!backend) {
        backend = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
        backends.set(input.transcriptPath, backend);
      }
      return backend;
    },
  };
  const local = createLocalGateway({
    projectRoot: pilotHome,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome },
    storageProvider: provider,
  });
  t.after(async () => {
    await local.dispose();
  });
  const input = { projectKey: pilotHome, sessionKey: "web:model-bundle-provider" };
  const selected = { mode: "model" as const, provider: "custom", model: "default-model" };

  await local.gateway.sessionModelSet!({ ...input, selection: selected });
  assert.deepEqual((await local.gateway.sessionModelGet!(input)).saved, selected);
  await local.gateway.sessionModelClear!(input);
  assert.equal((await local.gateway.sessionModelGet!(input)).saved, undefined);

  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.kind === "agent"));
  const entries = (await backends.get(calls[0]!.transcriptPath)!.persistence.load()).entries;
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);

  await Promise.all([
    local.gateway.sessionModelSet!({ ...input, selection: selected }),
    local.gateway.recordAgentStatusMessage!({
      ...input,
      turnId: "background-status",
      status: { event: "working", kind: "status", text: "Working" },
    }),
  ]);
  const concurrentEntries = (await backends.get(calls[0]!.transcriptPath)!.persistence.load()).entries;
  assert.deepEqual(concurrentEntries.map((entry) => entry.sequence), [1, 2, 3, 4]);
});
