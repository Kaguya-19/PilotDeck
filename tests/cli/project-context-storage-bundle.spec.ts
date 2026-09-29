import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectContextStorageBundle } from "../../src/cli/ProjectContextStorageBundle.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type {
  CompactionPort,
  InstructionStoragePort,
  PromptCacheCoordinatorPort,
  ToolResultSpillPort,
} from "../../src/context/index.js";
import {
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type ModelRuntime,
  type MultimodalConstraints,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { SessionTitlePort } from "../../src/session/index.js";

test("project context storage bundle preserves application-selected providers", async () => {
  const instructionStorage: InstructionStoragePort = {
    async readText(path) { return `instruction:${path}`; },
    async readDirectory() { return []; },
  };
  const writes: string[] = [];
  const toolResultSpill: ToolResultSpillPort = {
    async writeTextIfAbsent(path, content) {
      writes.push(`${path}:${content}`);
      return { created: true };
    },
    async copyFileIfAbsent() { return { created: true }; },
  };

  const resources = new ProjectContextStorageBundle({
    instructionStorage,
    toolResultSpill,
  }).stage();

  assert.equal(resources.instructionStorage, instructionStorage);
  assert.equal(resources.toolResultSpill, toolResultSpill);
  assert.equal(await resources.instructionStorage.readText("/project/PILOTDECK.md"), "instruction:/project/PILOTDECK.md");
  await resources.toolResultSpill.writeTextIfAbsent("/project/result.txt", "result");
  assert.deepEqual(writes, ["/project/result.txt:result"]);
});

test("local gateway carries selected context storage into the session context runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-context-storage-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  const reads: string[] = [];
  const instructionStorage: InstructionStoragePort = {
    async readText(path) {
      reads.push(path);
      if (path === join(root, "PILOTDECK.md")) return "Use the selected project instruction provider.";
      throw new Error("missing instruction");
    },
    async readDirectory() { return []; },
  };
  const model = new PromptInspectingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    __testModelFactory: () => model,
    contextStorage: {
      instructionStorage,
      toolResultSpill: {
        async writeTextIfAbsent() { return { created: true }; },
        async copyFileIfAbsent() { return { created: true }; },
      },
    },
  });
  t.after(() => local.dispose());

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "context-storage-session",
    channelKey: "test",
    projectKey: root,
    message: "Use the project instruction.",
  })) {
    // Consuming the stream drives the real AgentSession and context preparation.
  }

  assert.ok(reads.includes(join(root, "PILOTDECK.md")));
  assert.equal(model.requests.length, 1);
  assert.match(model.requests[0]?.systemPrompt ?? "", /selected project instruction provider/);
});

test("local gateway carries selected compaction provider into a real session turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-compaction-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  let created = 0;
  const calls: Array<{ sessionId?: string; turnId?: string }> = [];
  const compaction: CompactionPort = {
    async autoCompact(input) {
      calls.push({ sessionId: input.sessionId, turnId: input.turnId });
      return {
        type: "skipped",
        snapshot: {
          tokens: 0,
          maxContextTokens: input.maxContextTokens ?? 8_192,
          warningRatio: 0,
          blockingRatio: 0,
          state: "ok",
          ratio: 0,
        },
      };
    },
    buildPostCompactMessages: () => [],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };
  let cachePlans = 0;
  let compactionDisposals = 0;
  const promptCacheCoordinator: PromptCacheCoordinatorPort = {
    createPlan(sessionId) {
      cachePlans += 1;
      assert.equal(sessionId, "compaction-session");
      return undefined;
    },
    reset() {},
    release() {},
  };
  compaction.dispose = () => {
    compactionDisposals += 1;
  };
  const model = new PromptInspectingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    __testModelFactory: () => model,
    compactionProviderFactory: () => {
      created += 1;
      return compaction;
    },
    promptCacheCoordinatorFactory: () => promptCacheCoordinator,
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "compaction-session",
      channelKey: "test",
      projectKey: root,
      message: "Use the selected compaction provider.",
    })) {
      // Consuming the stream drives the real AgentSession and context preparation.
    }

    assert.equal(created, 1);
    assert.ok(calls.length > 0, "the real turn must consume the selected compaction provider");
    assert.equal(calls[0]?.sessionId, "compaction-session");
    assert.ok(cachePlans > 0, "the real turn must consume the selected prompt-cache provider");
  } finally {
    await local.dispose();
  }
  assert.equal(compactionDisposals, 1);
});

test("local gateway carries selected session-title provider into a real session turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-title-provider-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  const calls: Array<{ sessionId: string; turnId: string; text: string }> = [];
  let disposals = 0;
  const provider: SessionTitlePort = {
    providerId: "test-title-provider",
    async generate(input) {
      calls.push({ sessionId: input.sessionId, turnId: input.turnId, text: input.text });
      return "Provider-selected title";
    },
    dispose() {
      disposals += 1;
    },
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    __testModelFactory: () => new PromptInspectingModel(),
    sessionTitleProviderFactory: ({ modelRuntime, snapshot }) => {
      assert.ok(modelRuntime);
      assert.equal(snapshot.config.agent.model.provider, "test");
      return provider;
    },
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "title-provider-session",
      channelKey: "test",
      projectKey: root,
      message: "Use the selected title provider.",
    })) {
      // Exhaust the real AgentSession turn so title generation is finalized.
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.sessionId, "title-provider-session");
    assert.equal(calls[0]?.text, "Use the selected title provider.");
  } finally {
    await local.dispose();
  }
  assert.equal(disposals, 1);
});

class PromptInspectingModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "context storage used" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 128_000, maxOutputTokens: 8_192 };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}
