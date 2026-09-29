import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentFollowupOptions,
  AgentHandle,
} from "../../../src/agent/scope/AgentHandle.js";
import type { AgentInput } from "../../../src/agent/protocol/input.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";
import {
  SUBAGENT_DEFINITIONS,
  SubagentContinuationManager,
  SubagentProviderRegistry,
  type ContinuableSubagentMaterializeRequest,
  type SubagentContinuationAgentDirectory,
  type SubagentContinuationHost,
} from "../../../src/agent/sub/index.js";

const DEFAULT_PARENT = fakeParent("parent-1");
const DEFAULT_AGENTS = agentDirectory(DEFAULT_PARENT);

test("continuation manager materializes through a detached provider spec and admits through AgentHandle", async () => {
  const providers = providerRegistry([{ type: "seed" } as never]);
  const handle = fakeHandle();
  let materialized: ContinuableSubagentMaterializeRequest | undefined;
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: idSequence(),
    host: hostWithHandle(handle.value, {
      create: async (request) => {
        materialized = request;
        return handle.value;
      },
    }),
  });

  const started = await manager.start({ ...startRequest(), provider: "  continuable  " });
  assert.deepEqual(started, {
    childSessionId: "child-1",
    itemId: "item-1",
    turnId: "turn-1",
  });
  assert.equal(materialized?.childSessionId, "child-1");
  assert.equal(materialized?.parent, DEFAULT_PARENT);
  assert.equal(materialized?.provider, "continuable");
  assert.deepEqual(materialized?.descriptor, {
    version: 2,
    mode: "continuable",
    provider: "continuable",
    definitionId: "explore",
    parentSessionId: "parent-1",
    label: "Inspect the runtime",
    agentProvider: "parent-provider",
    agentModel: "parent-model",
  });
  assert.deepEqual(materialized?.spec, { seedEntries: [{ type: "seed" }] });
  assert.deepEqual(handle.order, ["descriptor:turn-1", "followup:turn-1"]);
  assert.deepEqual(handle.followups, [{ text: "initial", itemId: "item-1", turnId: "turn-1" }]);
  assert.deepEqual(manager.snapshot(), [{
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    provider: "continuable",
    providerGeneration: 1,
    state: "active",
  }]);

  const followed = await manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "later" },
  });
  assert.equal(followed.itemId, "item-2");
  assert.equal(followed.turnId, "turn-2");
  assert.deepEqual(handle.followups.map((call) => call.text), ["initial", "later"]);

  await manager.dispose();
  assert.deepEqual(handle.disposals, ["subagent_continuation_manager_disposed"]);
  await providers.dispose();
});

test("continuation manager serializes followups per child without owning another turn queue", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  const manager = managerWithHandle(providers, handle.value);
  await manager.start(startRequest());
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  handle.beforeAccept = async (text) => {
    if (text === "first") await firstGate;
  };

  const first = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "first" },
  });
  await Promise.resolve();
  const second = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "second" },
  });
  await Promise.resolve();
  assert.deepEqual(handle.followups.map((call) => call.text), ["initial", "first"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(handle.followups.map((call) => call.text), ["initial", "first", "second"]);
  await manager.dispose();
  await providers.dispose();
});

test("provider replacement cannot orphan or reclaim a manager-owned child handle", async () => {
  const providers = new SubagentProviderRegistry();
  let oldProviderDisposed = 0;
  providers.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => ({}),
    dispose: () => { oldProviderDisposed += 1; },
  });
  const handle = fakeHandle();
  const manager = managerWithHandle(providers, handle.value);
  await manager.start(startRequest());

  const replacement = providers.replace("continuable", {
    name: "continuable",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
  });
  await replacement.previousDisposed;
  assert.equal(oldProviderDisposed, 1);
  assert.equal(manager.has("child-1"), true);
  assert.deepEqual(handle.disposals, []);

  await manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "after replacement" },
  });
  assert.deepEqual(handle.followups.map((call) => call.text), ["initial", "after replacement"]);

  await manager.dispose();
  assert.deepEqual(handle.disposals, ["subagent_continuation_manager_disposed"]);
  await providers.dispose();
});

test("continuation manager rolls back a materialized handle when initial admission fails", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  handle.beforeAccept = async () => { throw new Error("inbox unavailable"); };
  const manager = managerWithHandle(providers, handle.value);

  await assert.rejects(manager.start(startRequest()), /inbox unavailable/);
  assert.equal(manager.size, 0);
  assert.deepEqual(handle.order, ["descriptor:turn-1", "followup:turn-1"]);
  assert.equal(handle.descriptors.length, 1);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  await manager.dispose();
  await providers.dispose();
});

test("continuation manager rejects a different live parent and releases a child exactly once", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  const otherParent = fakeParent("parent-2");
  const manager = managerWithHandle(
    providers,
    handle.value,
    agentDirectory(DEFAULT_PARENT, otherParent),
  );
  await manager.start(startRequest());

  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: otherParent,
    input: { type: "text", text: "unauthorized" },
  }), /belongs to another live parent agent/);
  assert.equal(await manager.disposeChild("child-1", "explicit_release"), true);
  assert.equal(await manager.disposeChild("child-1", "duplicate_release"), false);
  assert.deepEqual(handle.disposals, ["explicit_release"]);
  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "late" },
  }), /not resumable/);

  await manager.dispose();
  await providers.dispose();
});

test("start rejects an unregistered parent before provider preparation", async () => {
  const providers = new SubagentProviderRegistry();
  let prepareCalls = 0;
  providers.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => {
      prepareCalls += 1;
      return {};
    },
  });
  const manager = new SubagentContinuationManager({
    providers,
    agents: agentDirectory(),
    host: hostWithHandle(fakeHandle().value),
  });

  await assert.rejects(manager.start(startRequest()), /requires the exact live parent agent/);
  assert.equal(prepareCalls, 0);

  await manager.dispose();
  await providers.dispose();
});

test("start rejects a replaced parent handle even when the session id is unchanged", async () => {
  const providers = providerRegistry();
  const agents = agentDirectory(DEFAULT_PARENT);
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    host: hostWithHandle(fakeHandle().value),
  });

  await assert.rejects(manager.start(startRequest()), /requires the exact live parent agent/);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("parent replacement during provider preparation prevents child materialization", async () => {
  const providers = new SubagentProviderRegistry();
  let releasePrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let observePrepare!: () => void;
  const prepareStarted = new Promise<void>((resolve) => { observePrepare = resolve; });
  providers.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => {
      observePrepare();
      await prepareGate;
      return {};
    },
  });
  const agents = agentDirectory(DEFAULT_PARENT);
  let createCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    uuid: idSequence(),
    host: hostWithHandle(fakeHandle().value, {
      create: async () => {
        createCalls += 1;
        return fakeHandle().value;
      },
    }),
  });

  const starting = manager.start(startRequest());
  await prepareStarted;
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  releasePrepare();

  await assert.rejects(starting, /requires the exact live parent agent/);
  assert.equal(createCalls, 0);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("parent replacement during host creation rolls back the unpublished child", async () => {
  const providers = providerRegistry();
  const agents = agentDirectory(DEFAULT_PARENT);
  const handle = fakeHandle();
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let observeCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { observeCreate = resolve; });
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    uuid: idSequence(),
    host: hostWithHandle(handle.value, {
      create: async () => {
        observeCreate();
        await createGate;
        return handle.value;
      },
    }),
  });

  const starting = manager.start(startRequest());
  await createStarted;
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  releaseCreate();

  await assert.rejects(starting, /requires the exact live parent agent/);
  assert.deepEqual(handle.accepted, []);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("manager drain waits for admitted materialization and rolls back before publication", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let observeCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { observeCreate = resolve; });
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: idSequence(),
    host: hostWithHandle(handle.value, {
      create: async () => {
        observeCreate();
        await createGate;
        return handle.value;
      },
    }),
  });

  const starting = manager.start(startRequest());
  await createStarted;
  const disposal = manager.dispose("manager_shutdown");
  assert.equal(manager.state, "draining");
  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "late" },
  }), /manager is draining/);

  releaseCreate();
  await assert.rejects(starting, /manager is draining/);
  await disposal;
  assert.equal(manager.state, "disposed");
  assert.equal(manager.size, 0);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  await providers.dispose();
});

test("caller abort during materialization rolls back the unpublished child handle", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  const controller = new AbortController();
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let observeCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { observeCreate = resolve; });
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: idSequence(),
    host: hostWithHandle(handle.value, {
      create: async () => {
        observeCreate();
        await createGate;
        return handle.value;
      },
    }),
  });

  const starting = manager.start({ ...startRequest(), abortSignal: controller.signal });
  await createStarted;
  controller.abort("caller stopped");
  releaseCreate();

  await assert.rejects(starting, /continuable subagent start aborted: caller stopped/);
  assert.equal(manager.size, 0);
  assert.deepEqual(handle.followups, []);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  await manager.dispose();
  await providers.dispose();
});

test("followup cold-resumes from the child-owned durable descriptor without consulting providers", async () => {
  const providers = providerRegistry();
  await providers.dispose();
  const handle = fakeHandle();
  const hostOrder: string[] = [];
  let resumed: Parameters<SubagentContinuationHost["resume"]>[0] | undefined;
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: valueSequence("resume-item", "resume-turn"),
    host: {
      create: async () => { throw new Error("fresh create must not run"); },
      inspect: async ({ childSessionId }) => {
        hostOrder.push(`inspect:${childSessionId}`);
        return {
          entries: [descriptorEntry("ancestor", "one-shot", 1), descriptorEntry("child-1", "continuable", 2)],
        };
      },
      resume: async (request) => {
        resumed = request;
        hostOrder.push(`resume:${request.childSessionId}`);
        return handle.value;
      },
    },
  });

  const admitted = await manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "resume work" },
  });

  assert.deepEqual(admitted, {
    childSessionId: "child-1",
    itemId: "resume-item",
    turnId: "resume-turn",
  });
  assert.deepEqual(hostOrder, ["inspect:child-1", "resume:child-1"]);
  assert.deepEqual(resumed?.descriptor, continuableDescriptor());
  assert.equal(resumed?.parent, DEFAULT_PARENT);
  assert.deepEqual(handle.followups, [{
    text: "resume work",
    itemId: "resume-item",
    turnId: "resume-turn",
  }]);
  assert.deepEqual(manager.snapshot(), [{
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    provider: "retired-provider",
    state: "active",
  }]);

  await manager.dispose();
});

test("cold resume authorizes the durable parent before materializing", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  const otherParent = fakeParent("another-parent");
  let resumeCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents: agentDirectory(DEFAULT_PARENT, otherParent),
    host: hostWithHandle(handle.value, {
      inspect: async () => ({
        entries: [descriptorEntry("child-1", "continuable", 1)],
      }),
      resume: async () => {
        resumeCalls += 1;
        return handle.value;
      },
    }),
  });

  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: otherParent,
    input: { type: "text", text: "unauthorized" },
  }), /belongs to another parent session/);
  assert.equal(resumeCalls, 0);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("parent replacement during durable inspection prevents cold materialization", async () => {
  const providers = providerRegistry();
  const agents = agentDirectory(DEFAULT_PARENT);
  const handle = fakeHandle();
  let releaseInspect!: () => void;
  const inspectGate = new Promise<void>((resolve) => { releaseInspect = resolve; });
  let observeInspect!: () => void;
  const inspectStarted = new Promise<void>((resolve) => { observeInspect = resolve; });
  let resumeCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    host: hostWithHandle(handle.value, {
      inspect: async () => {
        observeInspect();
        await inspectGate;
        return { entries: [descriptorEntry("child-1", "continuable", 1)] };
      },
      resume: async () => {
        resumeCalls += 1;
        return handle.value;
      },
    }),
  });

  const resuming = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "resume work" },
  });
  await inspectStarted;
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  releaseInspect();

  await assert.rejects(resuming, /requires the exact live parent agent/);
  assert.equal(resumeCalls, 0);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("parent replacement during host resume rolls back the unpublished child", async () => {
  const providers = providerRegistry();
  const agents = agentDirectory(DEFAULT_PARENT);
  const handle = fakeHandle();
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  let observeResume!: () => void;
  const resumeStarted = new Promise<void>((resolve) => { observeResume = resolve; });
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    host: hostWithHandle(handle.value, {
      inspect: async () => ({
        entries: [descriptorEntry("child-1", "continuable", 1)],
      }),
      resume: async () => {
        observeResume();
        await resumeGate;
        return handle.value;
      },
    }),
  });

  const resuming = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "resume work" },
  });
  await resumeStarted;
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  releaseResume();

  await assert.rejects(resuming, /requires the exact live parent agent/);
  assert.deepEqual(handle.accepted, []);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("cold resume rejects unsupported or ambiguous durable state", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  let inspection = {
    entries: [descriptorEntry("child-1", "one-shot", 1)],
  };
  let resumeCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    host: hostWithHandle(handle.value, {
      inspect: async () => inspection,
      resume: async () => {
        resumeCalls += 1;
        return handle.value;
      },
    }),
  });

  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "one-shot" },
  }), /not resumable/);

  inspection = {
    entries: [{
      ...descriptorEntry("child-1", "continuable", 1),
      descriptor: { ...continuableDescriptor(), provider: "" },
    } as AgentTranscriptEntry],
  };
  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "invalid seed" },
  }), /invalid durable state/);
  assert.equal(resumeCalls, 0);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("cold-resume admission failure disposes the unpublished activation", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  handle.beforeAccept = async () => { throw new Error("resume inbox unavailable"); };
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: valueSequence("resume-item", "resume-turn"),
    host: hostWithHandle(handle.value, {
      inspect: async () => ({
        entries: [descriptorEntry("child-1", "continuable", 1)],
      }),
    }),
  });

  await assert.rejects(manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "resume work" },
  }), /resume inbox unavailable/);
  assert.equal(manager.size, 0);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);

  await manager.dispose();
  await providers.dispose();
});

test("concurrent cold-resume followups materialize one activation and retain FIFO admission order", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  let inspectCalls = 0;
  let resumeCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: valueSequence("item-1", "turn-1", "item-2", "turn-2"),
    host: hostWithHandle(handle.value, {
      inspect: async () => {
        inspectCalls += 1;
        return {
          entries: [descriptorEntry("child-1", "continuable", 1)],
        };
      },
      resume: async () => {
        resumeCalls += 1;
        return handle.value;
      },
    }),
  });

  const first = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "first" },
  });
  const second = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "second" },
  });

  assert.deepEqual(await Promise.all([first, second]), [
    { childSessionId: "child-1", itemId: "item-1", turnId: "turn-1" },
    { childSessionId: "child-1", itemId: "item-2", turnId: "turn-2" },
  ]);
  assert.equal(inspectCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.deepEqual(handle.followups.map((call) => call.text), ["first", "second"]);

  await manager.dispose();
  await providers.dispose();
});

test("followup that loses the final-disposal race waits, then cold-resumes instead of using the releasing handle", async () => {
  const providers = providerRegistry();
  const warm = gatedSettlingHandle("child-1");
  const cold = fakeHandle("child-1");
  let inspectCalls = 0;
  let resumeCalls = 0;
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: valueSequence("child-1", "item-1", "turn-1", "item-2", "turn-2"),
    host: hostWithHandle(warm.value, {
      inspect: async () => {
        inspectCalls += 1;
        return { entries: [descriptorEntry("child-1", "continuable", 1)] };
      },
      resume: async () => {
        resumeCalls += 1;
        return cold.value;
      },
    }),
  });

  await manager.start(startRequest());
  warm.settle();
  const delivery = warm.value.whenIdle().then(() => manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "raced" },
  }));

  await warm.disposalStarted;
  await Promise.resolve();
  assert.equal(resumeCalls, 0);
  assert.deepEqual(cold.followups, []);

  warm.releaseDisposal();
  assert.deepEqual(await delivery, {
    childSessionId: "child-1",
    itemId: "item-2",
    turnId: "turn-2",
  });
  assert.equal(inspectCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.deepEqual(cold.followups, [{ text: "raced", itemId: "item-2", turnId: "turn-2" }]);
  assert.deepEqual(warm.disposals, ["continuable_subagent_settled"]);

  await manager.dispose();
  await providers.dispose();
});

test("live followup rejects a parent replaced inside the child admission tail", async () => {
  const providers = providerRegistry();
  const agents = agentDirectory(DEFAULT_PARENT);
  const handle = fakeHandle();
  const manager = managerWithHandle(providers, handle.value, agents);
  await manager.start(startRequest());
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let observeAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { observeAdmission = resolve; });
  handle.beforeAccept = async (text) => {
    if (text !== "stale followup") return;
    observeAdmission();
    await admissionGate;
  };

  const following = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "stale followup" },
  });
  await admissionStarted;
  agents.set(fakeParent(DEFAULT_PARENT.sessionId));
  releaseAdmission();

  await assert.rejects(following, /requires the exact live parent agent/);
  assert.deepEqual(handle.accepted.map((call) => call.text), ["initial"]);

  await manager.dispose();
  await providers.dispose();
});

test("caller abort during cold materialization rolls back before inbox admission", async () => {
  const providers = providerRegistry();
  const handle = fakeHandle();
  const controller = new AbortController();
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  let observeResume!: () => void;
  const resumeStarted = new Promise<void>((resolve) => { observeResume = resolve; });
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    host: hostWithHandle(handle.value, {
      inspect: async () => ({
        entries: [descriptorEntry("child-1", "continuable", 1)],
      }),
      resume: async () => {
        observeResume();
        await resumeGate;
        return handle.value;
      },
    }),
  });

  const resuming = manager.followup({
    childSessionId: "child-1",
    parent: DEFAULT_PARENT,
    input: { type: "text", text: "resume work" },
    abortSignal: controller.signal,
  });
  await resumeStarted;
  controller.abort("caller stopped");
  releaseResume();

  await assert.rejects(resuming, /continuable subagent cold resume aborted: caller stopped/);
  assert.deepEqual(handle.followups, []);
  assert.deepEqual(handle.disposals, ["continuable_subagent_admission_rollback"]);
  assert.equal(manager.size, 0);

  await manager.dispose();
  await providers.dispose();
});

test("parent descendant drain disposes a nested continuation tree child-first", async () => {
  const providers = providerRegistry();
  const root = fakeParent("root");
  const first = fakeHandle("child-1");
  const second = fakeHandle("child-2");
  const agents = agentDirectory(root);
  const order: string[] = [];
  first.value.dispose = async (reason?: string) => {
    order.push(`child-1:${reason}`);
  };
  second.value.dispose = async (reason?: string) => {
    order.push(`child-2:${reason}`);
  };
  const manager = new SubagentContinuationManager({
    providers,
    agents,
    uuid: valueSequence("child-1", "item-1", "turn-1", "child-2", "item-2", "turn-2"),
    host: {
      create: async ({ childSessionId }) => childSessionId === "child-1" ? first.value : second.value,
      inspect: async () => { throw new Error("not used"); },
      resume: async () => { throw new Error("not used"); },
    },
  });

  await manager.start({ ...startRequest(), parent: root });
  agents.set(first.value);
  await manager.start({
    ...startRequest(),
    parent: first.value,
    childSessionId: "child-2",
    input: { type: "text", text: "nested initial" },
  });
  assert.equal(manager.activationState("child-1"), "waiting");

  await manager.drainDescendants(root, "root_closed");
  assert.deepEqual(order, [
    "child-2:parent_root_closed",
    "child-1:root_closed",
  ]);
  assert.equal(manager.size, 0);
  await providers.dispose();
});

test("settlement waits for a running child and clears it only after quiescence", async () => {
  const providers = providerRegistry();
  const handle = settlingHandle("child-1");
  const manager = new SubagentContinuationManager({
    providers,
    agents: DEFAULT_AGENTS,
    uuid: idSequence(),
    host: hostWithHandle(handle.value),
  });

  await manager.start(startRequest());
  assert.equal(manager.activationState("child-1"), "running");
  assert.equal(manager.size, 1);
  handle.settle();
  await waitFor(() => manager.size === 0);
  assert.deepEqual(handle.disposals, ["continuable_subagent_settled"]);
  await providers.dispose();
});

test("settlement reports failed and aborted children without mapping either to success", async () => {
  for (const status of ["failed", "aborted"] as const) {
    const providers = providerRegistry();
    const parent = notifyingParent(`parent-${status}`);
    const handle = settlingHandle(`child-${status}`, status);
    const manager = new SubagentContinuationManager({
      providers,
      agents: agentDirectory(parent.value),
      uuid: idSequence(),
      host: hostWithHandle(handle.value),
    });
    await manager.start({ ...startRequest(), parent: parent.value, childSessionId: `child-${status}` });
    handle.settle();
    await waitFor(() => parent.notices.length === 1);
    assert.match(parent.notices[0]!, new RegExp(`settled: ${status}`));
    assert.doesNotMatch(parent.notices[0]!, /settled: completed/);
    await providers.dispose();
  }
});

test("same-id parent replacement cannot receive a prior child's settlement notice", async () => {
  const providers = providerRegistry();
  const parent = notifyingParent("parent-1");
  const agents = agentDirectory(parent.value);
  const child = fakeHandle();
  const manager = managerWithHandle(providers, child.value, agents);
  await manager.start({ ...startRequest(), parent: parent.value });
  agents.set(notifyingParent("parent-1").value);

  await manager.disposeChild("child-1", "explicit_release");
  assert.deepEqual(parent.notices, []);
  await providers.dispose();
});

function providerRegistry(seedEntries: never[] = []): SubagentProviderRegistry {
  const providers = new SubagentProviderRegistry();
  providers.register("continuable", {
    name: "continuable",
    capabilities: { continuation: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => ({ seedEntries }),
  });
  return providers;
}

function managerWithHandle(
  providers: SubagentProviderRegistry,
  handle: AgentHandle,
  agents: SubagentContinuationAgentDirectory = DEFAULT_AGENTS,
): SubagentContinuationManager {
  return new SubagentContinuationManager({
    providers,
    agents,
    uuid: idSequence(),
    host: hostWithHandle(handle),
  });
}

function startRequest() {
  return {
    provider: "continuable",
    label: "Inspect the runtime",
    parent: DEFAULT_PARENT,
    definition: SUBAGENT_DEFINITIONS.explore,
    parentConfig: {
      provider: "parent-provider",
      model: "parent-model",
    } as never,
    parentDependencies: {} as never,
    input: { type: "text" as const, text: "initial" },
  };
}

function fakeHandle(sessionId = "child-1") {
  const followups: Array<{ text: string; itemId: string; turnId: string }> = [];
  const accepted: Array<{ text: string; itemId: string; turnId: string }> = [];
  const descriptors: Array<{ turnId: string; descriptor: unknown }> = [];
  const disposals: string[] = [];
  const order: string[] = [];
  const control: {
    beforeAccept?: (text: string) => Promise<void>;
    value: AgentHandle;
    followups: Array<{ text: string; itemId: string; turnId: string }>;
    accepted: Array<{ text: string; itemId: string; turnId: string }>;
    descriptors: Array<{ turnId: string; descriptor: unknown }>;
    disposals: string[];
    order: string[];
  } = {
    followups,
    accepted,
    descriptors,
    disposals,
    order,
    value: {
      sessionId,
      state: "active",
      session: {
        sessionId,
        recordSubagentDescriptor: async (turnId: string, descriptor: unknown) => {
          descriptors.push({ turnId, descriptor });
          order.push(`descriptor:${turnId}`);
        },
      },
      followup: async (input: AgentInput, options: AgentFollowupOptions = {}) => {
        const text = input.type === "text" ? input.text : "blocks";
        const itemId = options.itemId ?? "missing-item-id";
        const turnId = options.turnId ?? "missing-turn-id";
        followups.push({ text, itemId, turnId });
        order.push(`followup:${turnId}`);
        options.authorizeAdmission?.();
        await control.beforeAccept?.(text);
        options.authorizeAdmission?.();
        accepted.push({ text, itemId, turnId });
        return { itemId, turnId };
      },
      dispose: async (reason?: string) => {
        disposals.push(reason ?? "disposed");
      },
    } as AgentHandle,
  };
  return control;
}

function fakeParent(sessionId: string): AgentHandle {
  return {
    sessionId,
    state: "active",
  } as AgentHandle;
}

function notifyingParent(sessionId: string): {
  value: AgentHandle;
  notices: string[];
} {
  const notices: string[] = [];
  return {
    notices,
    value: {
      sessionId,
      state: "active",
      followup: async (input: AgentInput) => {
        if (input.type === "text") notices.push(input.text);
        return { itemId: "notice-item", turnId: "notice-turn" };
      },
    } as unknown as AgentHandle,
  };
}

function settlingHandle(
  sessionId: string,
  terminalStatus: "idle" | "failed" | "aborted" = "idle",
): {
  value: AgentHandle;
  settle(): void;
  disposals: string[];
} {
  let inFlight = 1;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  const disposals: string[] = [];
  return {
    disposals,
    settle: () => {
      inFlight = 0;
      resolveIdle();
    },
    value: {
      sessionId,
      state: "active",
      get inFlight() { return inFlight; },
      pendingTurns: () => [],
      whenIdle: () => inFlight === 0 ? Promise.resolve() : idle,
      session: {
        sessionId,
        recordSubagentDescriptor: async () => undefined,
        snapshot: () => ({ status: terminalStatus }),
      },
      followup: async (_input: AgentInput, options: AgentFollowupOptions = {}) => ({
        itemId: options.itemId ?? "missing-item-id",
        turnId: options.turnId ?? "missing-turn-id",
      }),
      dispose: async (reason?: string) => {
        disposals.push(reason ?? "disposed");
      },
    } as unknown as AgentHandle,
  };
}

function gatedSettlingHandle(sessionId: string): {
  value: AgentHandle;
  followups: Array<{ text: string; itemId: string; turnId: string }>;
  settle(): void;
  disposalStarted: Promise<void>;
  releaseDisposal(): void;
  disposals: string[];
} {
  let inFlight = 1;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  let resolveDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => { resolveDisposalStarted = resolve; });
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
  const followups: Array<{ text: string; itemId: string; turnId: string }> = [];
  const disposals: string[] = [];
  return {
    disposals,
    followups,
    settle: () => {
      inFlight = 0;
      resolveIdle();
    },
    disposalStarted,
    releaseDisposal,
    value: {
      sessionId,
      state: "active",
      get inFlight() { return inFlight; },
      pendingTurns: () => [],
      whenIdle: () => inFlight === 0 ? Promise.resolve() : idle,
      session: {
        sessionId,
        recordSubagentDescriptor: async () => undefined,
        snapshot: () => ({ status: "idle" }),
      },
      followup: async (input: AgentInput, options: AgentFollowupOptions = {}) => {
        const itemId = options.itemId ?? "missing-item-id";
        const turnId = options.turnId ?? "missing-turn-id";
        followups.push({
          text: input.type === "text" ? input.text : "blocks",
          itemId,
          turnId,
        });
        return { itemId, turnId };
      },
      dispose: async (reason?: string) => {
        disposals.push(reason ?? "disposed");
        resolveDisposalStarted();
        await disposalGate;
      },
    } as unknown as AgentHandle,
  };
}

async function waitFor(predicate: () => boolean, turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

function agentDirectory(...handles: AgentHandle[]): SubagentContinuationAgentDirectory & {
  set(handle: AgentHandle): void;
  delete(sessionId: string): void;
} {
  const entries = new Map(handles.map((handle) => [handle.sessionId, handle]));
  return {
    get: (sessionId) => entries.get(sessionId),
    set: (handle) => { entries.set(handle.sessionId, handle); },
    delete: (sessionId) => { entries.delete(sessionId); },
  };
}

function idSequence(): () => string {
  const ids = ["child-1", "item-1", "turn-1", "item-2", "turn-2"];
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function valueSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function continuableDescriptor() {
  return {
    version: 2 as const,
    mode: "continuable" as const,
    provider: "retired-provider",
    definitionId: "explore",
    parentSessionId: "parent-1",
    label: "Inspect the runtime",
    agentProvider: "child-provider",
    agentModel: "child-model",
  };
}

function descriptorEntry(
  sessionId: string,
  mode: "one-shot" | "continuable",
  sequence: number,
): AgentTranscriptEntry {
  return {
    type: "subagent_descriptor",
    sessionId,
    turnId: `turn-${sequence}`,
    sequence,
    createdAt: "2026-09-08T00:00:00.000Z",
    entryId: `entry-${sequence}`,
    parentEntryId: sequence === 1 ? null : `entry-${sequence - 1}`,
    descriptor: mode === "continuable"
      ? continuableDescriptor()
      : {
          version: 1,
          mode: "one-shot",
          provider: "ancestor-provider",
          definitionId: "plan",
        },
  };
}

function hostWithHandle(
  handle: AgentHandle,
  overrides: Partial<SubagentContinuationHost> = {},
): SubagentContinuationHost {
  return {
    create: async () => handle,
    inspect: async () => { throw new Error("child session unavailable"); },
    resume: async () => handle,
    ...overrides,
  };
}
