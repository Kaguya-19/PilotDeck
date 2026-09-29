import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentHandle,
  AgentRegistry,
  isAgentTurnCapabilities,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
} from "../../../src/agent/index.js";
import { NativeSubagentContinuationHost } from "../../../src/agent/sub/NativeSubagentContinuationHost.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { snapshotSubagentDescriptor } from "../../../src/agent/sub/SubagentDescriptor.js";
import { createSubagentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import type { ProjectSessionStorageBackends, ProjectSessionStorageProvider } from "../../../src/session/storage/ProjectSessionStorageProvider.js";
import { InMemorySessionPersistence } from "../../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";

test("native continuation host persists child JSONL and cold-resumes it without provider lookup", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-native-continuation-host-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const parentConfig = createConfig(projectRoot);
  const parentDependencies = createDependencies();
  const parent = new AgentHandle({
    sessionId: "parent-session",
    async *submit() {},
    abort() {},
    snapshot() { return { sessionId: "parent-session" } as never; },
  } as never);
  const agents = new AgentRegistry({ name: "host-test-agents" });
  agents.register(parent.sessionId, parent);
  const host = new NativeSubagentContinuationHost();
  let factoryCalls = 0;
  const unbind = host.bindParent({
    parent,
    config: parentConfig,
    dependencies: parentDependencies,
    projectStorage: { projectRoot, pilotHome: projectRoot },
    agentLoopFactory: (input) => {
      factoryCalls += 1;
      assert.equal(isAgentTurnCapabilities(input.capabilities), true);
      assert.equal("dependencies" in (input as object), false);
      return createRunner();
    },
  });
  t.after(async () => {
    unbind();
    await parent.dispose("test_cleanup");
    await agents.dispose();
  });

  const descriptor = snapshotSubagentDescriptor({
    mode: "continuable",
    provider: "pilotdeck-native",
    definitionId: "explore",
    parentSessionId: parent.sessionId,
    label: "Explore",
    agentProvider: parentConfig.provider,
    agentModel: parentConfig.model,
  });
  const child = await host.create({
    childSessionId: "child-session",
    parent,
    definition: SUBAGENT_DEFINITIONS.explore,
    parentConfig,
    parentDependencies,
    provider: "pilotdeck-native",
    providerGeneration: 1,
    descriptor,
    spec: {},
  });
  await child.session.recordSubagentDescriptor("descriptor-turn", descriptor);
  const accepted = await child.followup({ type: "text", text: "Inspect the workspace." }, {
    itemId: "item-1",
    turnId: "turn-1",
  });
  assert.deepEqual(accepted, { itemId: "item-1", turnId: "turn-1" });
  await child.whenIdle();
  await child.dispose("test_cold_resume");

  const inspection = await host.inspect({ childSessionId: "child-session", parent });
  assert.ok(inspection.entries.some((entry) => entry.type === "subagent_descriptor"));
  assert.ok(inspection.entries.some((entry) => entry.type === "agent_turn_enqueued"));
  const childStorage = createSubagentProjectSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    parentSessionId: parent.sessionId,
    sessionId: "child-session",
  });
  assert.match(await readFile(childStorage.transcriptPath, "utf8"), /subagent_descriptor/);
  await childStorage.dispose();

  const resumed = await host.resume({ childSessionId: "child-session", parent, descriptor });
  const resumedAdmission = await resumed.followup({ type: "text", text: "Continue." }, {
    itemId: "item-2",
    turnId: "turn-2",
  });
  assert.deepEqual(resumedAdmission, { itemId: "item-2", turnId: "turn-2" });
  await resumed.dispose("test_done");
  assert.equal(factoryCalls, 2, "the official factory must serve materialized and resumed children");
});

test("continuation inspection reads child persistence without flushing a projection checkpoint", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-native-continuation-inspect-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  let checkpointSaves = 0;
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      let backend = backends.get(input.transcriptPath);
      if (!backend) {
        const checkpoint = new InMemorySessionProjectionCheckpointStore();
        backend = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: {
            load: (sessionId) => checkpoint.load(sessionId),
            save: async (envelope) => {
              checkpointSaves += 1;
              await checkpoint.save(envelope);
            },
          },
        };
        backends.set(input.transcriptPath, backend);
      }
      return backend;
    },
  };
  const parent = new AgentHandle({
    sessionId: "inspect-parent",
    async *submit() {},
    abort() {},
    snapshot() { return { sessionId: "inspect-parent" } as never; },
  } as never);
  const host = new NativeSubagentContinuationHost();
  const unbind = host.bindParent({
    parent,
    config: {} as AgentRuntimeConfig,
    dependencies: {} as AgentRuntimeDependencies,
    projectStorage: { projectRoot, pilotHome: projectRoot, storageProvider: provider },
  });
  t.after(async () => {
    unbind();
    await parent.dispose("test_cleanup");
  });

  const childStorage = createSubagentProjectSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    parentSessionId: parent.sessionId,
    sessionId: "inspect-child",
    storageProvider: provider,
  });
  await childStorage.events.append("inspect-child", "inspect-turn", {
    type: "session_metadata",
    metadata: { title: "Inspect me" },
  });
  await childStorage.dispose();
  checkpointSaves = 0;

  const inspection = await host.inspect({ childSessionId: "inspect-child", parent });

  assert.equal(inspection.entries.length, 1);
  assert.equal(inspection.entries[0]?.type, "session_metadata");
  assert.equal(checkpointSaves, 0);
});

function createConfig(cwd: string): AgentRuntimeConfig {
  return {
    provider: "test-provider",
    model: "test-model",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

function createDependencies(): AgentRuntimeDependencies {
  return {
    router: {
      async *stream() {},
      async decide({ request }: { request: { provider: string; model: string } }) {
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: true,
          orchestrating: false,
          resolvedFrom: "fallback",
          mutations: {},
        };
      },
      async execute() { return; },
    } as unknown as AgentRouterRuntime,
    tools: { registry: new ToolRegistry(), scheduler: {} as never },
  };
}

function createRunner() {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const finalMessage: CanonicalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      };
      const result: AgentLoopRunResult = {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          finalMessage,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        messages: [...input.messages, finalMessage],
      };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: result.result };
      return result;
    },
  };
}
