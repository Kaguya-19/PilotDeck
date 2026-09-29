import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import type { AgentTranscriptWriter } from "../../src/session/transcript/TranscriptWriter.js";
import { SopAgentLoop } from "../../src/sop/staffdeck/SopAgentLoop.js";
import { StaffDeckSopClientError } from "../../src/sop/staffdeck/StaffDeckSopClient.js";
import { SopStateStore } from "../../src/sop/staffdeck/SopStateStore.js";
import type { ModelInvokerPort, ToolPort } from "../../src/agent/modules/protocol.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult } from "../../src/tool/index.js";
import { toolError } from "../../src/tool/index.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopOperationContext,
  StaffDeckSopRuntimeClient,
  StaffDeckSopRuntimeConfig,
} from "../../src/sop/staffdeck/types.js";

const BUNDLE: StaffDeckSopBundle = {
  sops: [{
    id: "onboarding",
    name: "Onboarding",
    content: {
      start_node_id: "lookup",
      nodes: [{
        node_id: "lookup",
        instruction: "Look up the account before replying.",
        allowed_actions: ["call_tool:lookup_account"],
      }],
    },
  }],
};

test("SOP loop admits a completed step only after a PilotDeck tool result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-loop-"));
  try {
    const profile: StaffDeckSopRuntimeConfig = {
      provider: "staffdeck",
      endpoint: "http://unused.test",
      definitionsPath: join(root, "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: root,
    };
    let submittedSuccessfulTools: readonly string[] | undefined;
    const preparedContexts: StaffDeckSopOperationContext[] = [];
    let submittedContext: StaffDeckSopOperationContext | undefined;
    const client: StaffDeckSopRuntimeClient = {
      async prepare({ state, context }) {
        if (context) preparedContexts.push(context);
        return {
          state: { ...state, status: "active" },
          step: {
            skillId: "onboarding",
            skillName: "Onboarding",
            version: "1",
            nodeId: "lookup",
            node: {},
            instruction: "Look up the account before replying.",
            expectedUserInfo: [],
            knownSlots: {},
            allowedNextStepIds: [],
            requiredToolNames: ["lookup_account"],
            allowedActions: ["call_tool:lookup_account"],
            isTerminal: true,
            declaresHandoff: false,
          },
        };
      },
      async submit({ state, successfulToolNames, context }) {
        submittedSuccessfulTools = successfulToolNames;
        submittedContext = context;
        assert.deepEqual(successfulToolNames, ["lookup_account"]);
        return {
          state: { ...state, status: "completed", successful_tool_names: [] },
          result: {
            status: "completed",
            replyFragment: "Account onboarding is complete.",
            slotUpdates: {},
            events: [{ type: "sop_completed" }],
          },
        };
      },
    };
    const model = scriptedModel();
    const lookup = lookupTool();
    const session = createAgentSession({
      sessionId: "sop-session",
      config: {
        provider: "test",
        model: "test-model",
        cwd: root,
        permissionMode: "default",
        permissionContext: createDefaultPermissionContext({ cwd: root, canPrompt: false }),
        staffDeckSop: profile,
      },
      dependencies: {
        router: {} as never,
        ports: { model, tools: toolPort(lookup) },
        tools: { registry: { list: () => [lookup] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle: BUNDLE,
        client,
        stateStore: new SopStateStore(join(root, "sessions")),
      }),
    });

    const events = [];
    for await (const event of session.submit({ type: "text", text: "Start onboarding" }, { turnId: "sop-turn" })) {
      events.push(event);
    }

    assert.deepEqual(submittedSuccessfulTools, ["lookup_account"]);
    assert.equal(preparedContexts[0]?.sessionId, "sop-session");
    assert.equal(preparedContexts[0]?.turnId, "sop-turn");
    assert.equal(preparedContexts[0]?.expectedRevision, 1);
    assert.ok((preparedContexts.at(-1)?.expectedRevision ?? 0) > 1);
    assert.equal(submittedContext?.requestId, `sop.submit:${submittedContext?.idempotencyKey}`);
    assert.ok((submittedContext?.expectedRevision ?? 0) > 1);
    const firstRequest = model.requests[0];
    assert.ok(firstRequest);
    assert.equal(firstRequest.toolChoice, "required");
    assert.ok(firstRequest.tools?.some((tool) => tool.name === "submit_step_result"));
    const finalTextIndex = events.findIndex((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Account onboarding is complete.");
    const completedIndex = events.findIndex((event) => event.type === "turn_completed");
    assert.ok(finalTextIndex >= 0);
    assert.ok(completedIndex > finalTextIndex);
    const completed = events.find((event): event is Extract<AgentEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.equal(completed?.result.finalMessage?.content[0]?.type, "text");
    assert.equal(completed?.result.finalMessage?.content[0]?.type === "text" && completed.result.finalMessage.content[0].text, "Account onboarding is complete.");
    const persisted = JSON.parse(readFileSync(
      join(root, "sessions", `${Buffer.from("sop-session", "utf8").toString("base64url")}.json`),
      "utf8",
    ));
    assert.equal(persisted.state.status, "completed");
    assert.deepEqual(persisted.state.successful_tool_names, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one SOP turn continues completed nodes through required evidence to the declared handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-single-turn-"));
  try {
    const submitted: string[] = [];
    let modelCalls = 0;
    const model = modelFromStream(async function* (prepared) {
      const call = modelCalls++;
      const request = (prepared as { request: { toolChoice: unknown; systemPrompt: string } }).request;
      assert.deepEqual(request.toolChoice, [0, 1, 4, 5].includes(call)
        ? { type: "tool", name: "submit_step_result" } : "required");
      assert.equal(request.systemPrompt.includes("SOP_STEP_RESULT_REQUIRED"), [1, 5].includes(call));
      if (call === 0 || call === 4) { yield* yieldText("Approval will be requested."); return; }
      if (call === 2) { yield* yieldToolCall("evidence", "lookup_account", { accountId: "ada" }); return; }
      yield* yieldToolCall(`step-${call}`, "submit_step_result", {
        status: call === 5 ? "handoff" : "completed", replyFragment: `Step ${call} result`,
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const prepared = await base.prepare(input);
        const node = input.state.active_step_id ?? "collect";
        return { ...prepared, state: { ...prepared.state, active_step_id: node },
          step: { ...prepared.step, nodeId: node, node: { type: node === "approval" ? "handoff" : node === "collect" ? "collect" : "response" },
            requiredToolNames: node === "evidence" ? ["lookup_account"] : [],
            allowedNextStepIds: node === "approval" ? [] : [node === "collect" ? "evidence" : "approval"],
            declaresHandoff: node === "approval", isTerminal: false } };
      },
      async submit(input) {
        const node = input.state.active_step_id!;
        submitted.push(node);
        if (node === "evidence") assert.deepEqual(input.successfulToolNames, ["lookup_account"]);
        const next = node === "collect" ? "evidence" : node === "evidence" ? "approval" : undefined;
        return { state: { ...input.state, status: next ? "active" : "handoff",
          active_step_id: next ?? node, successful_tool_names: [] },
          result: { status: input.proposal.status, replyFragment: input.proposal.replyFragment,
            slotUpdates: {}, nextStepId: next, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "single-turn", model, client, context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Plan the project with all fields supplied", "single-turn-request");
    assert.deepEqual(submitted, ["collect", "evidence", "approval"]);
    assert.equal(modelCalls, 6);
    const evidenceReceipt = events.find((event) => event.type === "tool_result"
      && event.result.type === "success" && event.result.toolCallId === "step-3");
    assert.ok(evidenceReceipt && evidenceReceipt.type === "tool_result" && evidenceReceipt.result.type === "success");
    assert.deepEqual(evidenceReceipt.result.content[0], { type: "json", value: {
      submittedStepId: "evidence", status: "completed", resultStatus: "completed", activeStepId: "approval",
      sopStatus: "active", nextStepId: "approval", nextStepRequiresOwnSubmission: true,
    } });
    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    const store = new SopStateStore(join(root, "sessions"));
    assert.equal((await store.status("single-turn"))?.wait?.kind, "handoff");
    assert.equal(await store.replyDelivery("single-turn"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("text-only SOP responses get one protocol correction then fail without advancing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-bounded-correction-"));
  try {
    let calls = 0;
    const model = modelFromStream(async function* () { calls++; yield* yieldText("Please confirm."); });
    const session = createSopSession({ root, sessionId: "text-only", model, client: acceptingClient() });
    const events = await collectSessionTurn(session, "Start", "text-only-turn");
    assert.equal(calls, 2);
    assert.ok(events.some(event => event.type === "turn_failed"));
    assert.equal(events.filter(event => event.type === "turn_completed" && event.result.type === "success").length, 0);
    const status = await new SopStateStore(join(root, "sessions")).status("text-only");
    assert.equal(status?.state.status, "active");
    assert.equal(status?.wait, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("final SOP node offers only its submission and corrects a text draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-final-submit-"));
  try {
    let calls = 0;
    const requests: { tools?: { name: string }[]; toolChoice: unknown; systemPrompt: string }[] = [];
    const model = modelFromStream(async function* (prepared) {
      const request = (prepared as { request: { tools?: { name: string }[]; toolChoice: unknown; systemPrompt: string } }).request;
      requests.push(request);
      if (calls++ === 0) {
        yield* yieldText("Final checklist draft.");
        return;
      }
      yield* yieldToolCall("final-submit", "submit_step_result", {
        status: "completed", replyFragment: "Final checklist.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [], isTerminal: true } };
      },
    };
    const session = createSopSession({ root, sessionId: "final-submit", model, client, context: new DefaultContextRuntime() });
    await collectSessionTurn(session, "The owner approved the plan. Produce the final checklist.", "final-turn");
    assert.equal(calls, 2);
    assert.deepEqual(requests.map((request) => request.tools?.map((tool) => tool.name)), [
      ["submit_step_result"], ["submit_step_result"],
    ]);
    assert.deepEqual(requests[0]?.toolChoice, { type: "tool", name: "submit_step_result" });
    assert.match(requests[0]?.systemPrompt ?? "", /This is the active final SOP node/);
    assert.match(requests[1]?.systemPrompt ?? "", /previous assistant text was only a draft/);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("final-submit"))?.state.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery of a committed intermediate node continues instead of ending the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-active-recovery-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const persisted = await store.loadOrCreate("active-recovery", BUNDLE, "onboarding");
    await store.commitSubmission("active-recovery", BUNDLE, { ...persisted.state, status: "active", active_step_id: "lookup" },
      persisted.revision, "interrupted-turn", { status: "completed", nextStepId: "lookup",
        replyFragment: "Previous node persisted", slotUpdates: {}, events: [] });
    const model = scriptedModel();
    const session = createSopSession({ root, sessionId: "active-recovery", model, client: acceptingClient(), context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Recover the interrupted request", "recovery-turn");
    assert.equal(model.requests.length, 2);
    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    assert.equal((await store.status("active-recovery"))?.state.status, "completed");
    assert.equal(await store.replyDelivery("active-recovery"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP loop tells the model declared approval handoffs are resumable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-handoff-prompt-"));
  try {
    const model = scriptedModel();
    const session = createSopSession({
      root,
      sessionId: "handoff-prompt",
      model,
      client: acceptingClient(undefined, true),
      context: new DefaultContextRuntime(),
    });

    for await (const _event of session.submit({ type: "text", text: "Request approval" })) {
      // Consume the turn so the model request is assembled.
    }

    assert.match(
      JSON.stringify(model.requests),
      /This step declares a human handoff\. When approval is required, use status handoff to create the resumable approval wait; do not use awaiting_user\./,
    );
    assert.match(JSON.stringify(model.requests), /condition=approval_required, priority=10, label=Needs approval; target=Confirm approval; handoff; Ask the owner to confirm\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval node rejects awaiting_user and requires a real handoff submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-approval-boundary-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`approval-${calls}`, "submit_step_result", {
        status: calls === 1 ? "awaiting_user" : "handoff",
        replyFragment: "Please confirm the plan.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "handoff" }, requiredToolNames: [], allowedNextStepIds: ["finalize"],
          declaresHandoff: true, isTerminal: false } };
      },
      async submit(input) {
        submissions++;
        assert.equal(input.proposal.status, "handoff");
        return { state: { ...input.state, status: "handoff" }, result: {
          status: "handoff", replyFragment: input.proposal.replyFragment,
          slotUpdates: {}, events: [],
        } };
      },
    };
    const session = createSopSession({ root, sessionId: "approval-boundary", model, client });
    const events = await collectSessionTurn(session, "Please request owner approval.", "approval-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("HANDOFF_REQUIRED")));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("approval-boundary"))?.wait?.kind, "handoff");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evidence step without missing fields routes approval to its declared next node", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-evidence-prompt-"));
  try {
    const model = scriptedModel();
    const client = acceptingClient();
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "evidence-prompt", model,
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, step: { ...prepared.step, allowedNextStepIds: ["confirm"], isTerminal: false } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Assess the change before requesting approval." })) {}
    const request = JSON.stringify(model.requests);
    assert.match(request, /This step has no missing user fields/);
    assert.match(request, /Approval belongs to the declared handoff step/);
    assert.match(request, /Allowed next steps: confirm/);
    assert.match(request, /persist it with awaiting_user and no nextStepId/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "complete collect", type: "collect_info", fields: ["stage"], slots: { stage: "validation" }, actions: ["extract_slots"], reject: true },
  { name: "no-input decision", type: "decision", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "evidence approval", type: "knowledge_query", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "undeclared handoff", type: "knowledge_query", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "legal missing field", type: "collect_info", fields: ["stage"], slots: {}, actions: ["extract_slots"], reject: false },
  { name: "explicit question", type: "response", fields: [], slots: {}, actions: ["ask_user"], reject: false },
]) test(`SOP awaiting boundary: ${scenario.name}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-wait-boundary-"));
  try {
    let calls = 0, submissions = 0;
    const model = modelFromStream(async function* () {
      const index = calls++;
      if (scenario.type === "knowledge_query" && index === 1) {
        yield* yieldToolCall("knowledge-evidence", "knowledge_query", { query: "Project planning" }); return;
      }
      const status = index === 0 ? (scenario.name === "undeclared handoff" ? "handoff" : "awaiting_user")
        : scenario.name === "legal missing field" ? "awaiting_user" : "completed";
      yield* yieldToolCall(`boundary-${calls}`, "submit_step_result", { status, replyFragment: "Step result", slotUpdates: scenario.slots });
    });
    const client = acceptingClient(() => { submissions++; });
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "wait-boundary", model,
      tools: { ...toolPort(lookupTool()), list: () => [lookupTool(), { ...lookupTool(), name: "knowledge_query" }] },
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" },
          step: { ...prepared.step, node: { type: scenario.type }, expectedUserInfo: scenario.fields,
            allowedNextStepIds: ["confirm"], allowedActions: scenario.actions } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Plan this project." })) {}
    assert.equal(submissions, 1);
    assert.equal(calls, scenario.type === "knowledge_query" ? 3 : scenario.reject || scenario.name === "legal missing field" ? 2 : 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing fields require a persisted waiting result rather than a text-only question", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-missing-prompt-"));
  try {
    const model = scriptedModel();
    const client = acceptingClient();
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "missing-prompt", model,
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, step: { ...prepared.step, expectedUserInfo: ["current_stage"] } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Help plan my project." })) {}
    assert.match(JSON.stringify(model.requests), /your question MUST be the replyFragment of a submit_step_result call with status awaiting_user/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty first collect proposal gets one correction before a legal missing-field wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-collect-correction-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-${calls}`, "submit_step_result", {
        status: "awaiting_user",
        replyFragment: calls === 1 ? "What is the goal?" : "What is the stage?",
        slotUpdates: calls === 1 ? {} : { project_goal: "Complete SOP validation" },
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
          allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        assert.deepEqual(input.proposal.slotUpdates, { project_goal: "Complete SOP validation" });
        return { state: { ...input.state, status: "awaiting_user",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "collect-correction", model, client });
    const events = await collectSessionTurn(session, "Goal: Complete SOP validation", "collect-correction-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some(event => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("COLLECT_FIELDS_CHECK")));
    const status = await new SopStateStore(join(root, "sessions")).status("collect-correction");
    assert.equal(status?.state.status, "awaiting_user");
    assert.equal(status?.state.slots_json?.project_goal, "Complete SOP validation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a collect node with no supplied fields may wait after one bounded correction", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-empty-collect-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-${calls}`, "submit_step_result", {
        status: "awaiting_user", replyFragment: "Please provide the stage.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["current_stage"], allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        return { state: { ...input.state, status: "awaiting_user" },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "empty-collect", model, client });
    await collectSessionTurn(session, "Hello", "empty-collect-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("empty-collect"))?.state.status, "awaiting_user");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("follow-up collect wait reviews partial slot updates before accepting a repeated question", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-partial-fill-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("partial-fill", BUNDLE, "onboarding");
    await store.replace("partial-fill", BUNDLE, { selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "lookup", status: "awaiting_user", slots_json: { project_goal: "SOP delivery" } });
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`partial-fill-${calls}`, "submit_step_result", calls === 1
        ? { status: "awaiting_user", replyFragment: "What are the blockers?",
            slotUpdates: { project_goal: "SOP delivery", current_stage: "validation" } }
        : { status: "completed", replyFragment: "Collected the project status.",
            slotUpdates: { project_goal: "SOP delivery", current_stage: "validation", known_blockers: "none" } });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, status: "awaiting_user", active_step_id: "lookup" },
          step: { ...prepared.step, node: { type: "collect_info" },
            expectedUserInfo: ["project_goal", "current_stage", "known_blockers"],
            allowedNextStepIds: ["next"], requiredToolNames: [] } };
      },
      async submit(input) {
        submissions++;
        assert.equal(input.proposal.status, "completed");
        assert.equal(input.proposal.slotUpdates?.known_blockers, "none");
        return { state: { ...input.state, status: "completed",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "completed", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "partial-fill", model, client });
    const events = await collectSessionTurn(session,
      "Current stage: validation. Known blockers: none.", "partial-fill-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text"
      && event.result.content[0].text.includes("COLLECT_FIELDS_CHECK")));
    assert.equal((await store.status("partial-fill"))?.state.slots_json?.known_blockers, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collect wait uses only missing fields and rejects malformed known arguments without rejecting extras", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-collect-question-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-question-${calls}`, "submit_step_result", calls === 1
        ? { status: "awaiting_user", replyFragment: "What is the goal?", slotUpdates: "{}" }
        : { status: "awaiting_user", replyFragment: "What is the goal?", slotUpdates: { project_goal: "SOP delivery" }, modelNote: "extra" });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
          requiredToolNames: [], allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        assert.deepEqual(input.proposal.slotUpdates, { project_goal: "SOP delivery" });
        assert.equal(input.proposal.replyFragment, "请补充以下信息，以继续当前步骤：\n- current_stage");
        return { state: { ...input.state, status: "awaiting_user",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "collect-question", model, client });
    const events = await collectSessionTurn(session, "Goal: SOP delivery", "collect-question-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.code === "invalid_tool_input"));
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "请补充以下信息，以继续当前步骤：\n- current_stage"));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("collect-question"))?.state.slots_json?.project_goal, "SOP delivery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collect proposal cannot erase a persisted required slot while waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-slot-erasure-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("slot-erasure", BUNDLE, "onboarding");
    await store.replace("slot-erasure", BUNDLE, { selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "lookup", status: "active", slots_json: { project_goal: "SOP delivery" } });
    let calls = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`slot-erasure-${calls}`, "submit_step_result", {
        status: "awaiting_user", replyFragment: "What is the stage?",
        slotUpdates: { project_goal: calls === 1 ? "" : "SOP delivery" },
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
        requiredToolNames: [], allowedNextStepIds: ["next"] } };
    } };
    const session = createSopSession({ root, sessionId: "slot-erasure", model, client });
    const events = await collectSessionTurn(session, "Continue this project.", "slot-erasure-turn");
    assert.equal(calls, 2);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("REQUIRED_SLOT_ERASURE")));
    assert.equal((await store.status("slot-erasure"))?.state.slots_json?.project_goal, "SOP delivery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal response without missing fields cannot create an ordinary user wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-wait-"));
  try {
    let calls = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`terminal-${calls}`, "submit_step_result", {
        status: calls === 1 ? "awaiting_user" : "completed", replyFragment: "Final response.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [],
        expectedUserInfo: [], allowedActions: ["answer_user"], isTerminal: true } };
    } };
    const session = createSopSession({ root, sessionId: "terminal-wait", model, client });
    await collectSessionTurn(session, "Finish the plan.", "terminal-wait-turn");
    assert.equal(calls, 2);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("terminal-wait"))?.state.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal completion rejects stale waiting replies before they become durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-reply-"));
  try {
    const fragments = [
      "请提供以下信息，我才能生成最终答复。",
      "我目前被卡在 recognize_b 步骤，无法推进。请提供相关资料。",
      "I cannot proceed without more information. Please provide the documents.",
      "F64D：已完成 recognize_b 与 reply_b。先前提示“无法推进、请提供资料”已解除。",
    ];
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      const call = calls++;
      if (call === 0) {
        yield* yieldToolCall("final-reply-wait", "submit_step_result", {
          status: "awaiting_user", replyFragment: "请提供更多信息。", slotUpdates: {},
        });
        return;
      }
      const replyFragment = fragments[call - 1];
      assert.ok(replyFragment);
      yield* yieldToolCall(`final-reply-${calls}`, "submit_step_result", {
        status: "completed", replyFragment, slotUpdates: {},
      });
    });
    const base = acceptingClient(() => { submissions++; });
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "reply_b" }, step: { ...prepared.step,
        nodeId: "reply_b", node: { type: "response" }, instruction: "F64D: confirm both steps completed.",
        requiredToolNames: [], allowedNextStepIds: [], expectedUserInfo: [],
        allowedActions: ["answer_user"], isTerminal: true } };
    } };
    const session = createSopSession({ root, sessionId: "terminal-reply", model, client });
    const events = await collectSessionTurn(session, "Complete the SOP.", "terminal-reply-turn");
    const rejected = events.filter((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.message.includes("FINAL_REPLY_CONTRADICTS_COMPLETION"));
    assert.equal(rejected.length, 3);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.message.includes("STEP_MUST_ADVANCE")).length, 1);
    assert.equal(submissions, 1);
    assert.equal(calls, 5);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("terminal-reply"))?.state.status, "completed");
    const terminal = events.find((event) => event.type === "turn_completed");
    assert.equal(terminal?.result.type === "success"
      && (terminal.result.structuredOutput as { sop?: { replyFragment?: string } } | undefined)?.sop?.replyFragment,
    fragments[3]);
    assert.deepEqual(events.filter((event) => event.type === "assistant_message"
      && event.message.metadata?.purpose === "staffdeck_sop_reply")
      .map((event) => event.type === "assistant_message" && event.message.content[0]?.type === "text"
        ? event.message.content[0].text : ""), [fragments[3]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP session construction rejects definitions whose required PilotDeck tool is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-missing-tool-"));
  try {
    const noTools: ToolPort = {
      list: () => [],
      async executeAll() { return []; },
    };
    assert.throws(
      () => createSopSession({
        root,
        sessionId: "missing-tool",
        model: modelFromStream(async function* () { yield* yieldText("unreachable"); }),
        client: acceptingClient(),
        tools: noTools,
      }),
      (error: unknown) => (error as { code?: string; missingToolNames?: unknown }).code === "SOP_REQUIRED_TOOL_UNAVAILABLE"
        && JSON.stringify((error as { missingToolNames?: unknown }).missingToolNames) === JSON.stringify(["lookup_account"]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP glue decorates an externally supplied AgentLoop runner through sidecar ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-external-loop-"));
  try {
    const profile: StaffDeckSopRuntimeConfig = {
      provider: "staffdeck",
      endpoint: "http://unused.test",
      definitionsPath: join(root, "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: root,
    };
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [], isTerminal: true } };
    } };
    const session = createAgentSession({
      sessionId: "external-loop-session",
      config: {
        provider: "test",
        model: "test-model",
        cwd: root,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd: root, mode: "bypassPermissions", canPrompt: false }),
        staffDeckSop: profile,
      },
      dependencies: {
        router: {} as never,
        ports: { model: modelFromStream(async function* (prepared) {
          const request = (prepared as { request: { toolChoice?: unknown; tools?: { name: string }[] } }).request;
          assert.deepEqual(request.toolChoice, { type: "tool", name: "submit_step_result" });
          assert.deepEqual(request.tools?.map((tool) => tool.name), ["submit_step_result"]);
          yield* yieldText("unused");
        }), tools: toolPort(lookupTool()) },
        context: new DefaultContextRuntime(),
        tools: { registry: { list: () => [lookupTool()] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle: BUNDLE,
        client,
        stateStore: new SopStateStore(join(root, "sessions")),
        sidecarModules: input.sidecarModules,
        sidecarTransportContext: input.sidecarTransportContext,
        runnerFactory: (runnerInput) => {
          const modules = runnerInput.sidecarModules;
          assert.ok(modules, "external runner must receive the composed sidecar modules");
          return {
            snapshotFileState: () => ({}),
            async *run(runInput) {
              const tools = modules.capability.execution.list();
              assert.ok(tools.some((tool) => tool.name === "submit_step_result"));
              await modules.context?.execution.prepareForModel({
                sessionId: runInput.sessionId,
                turnId: runInput.turnId,
                cwd: root,
                provider: "test",
                model: "test-model",
                permissionMode: "bypassPermissions",
                additionalWorkingDirectories: [],
                messages: runInput.messages,
                tools: [],
              } as never);
              const modelContext = { sessionId: runInput.sessionId, turnId: runInput.turnId, runId: "external-run" };
              const offered = [
                { name: "lookup_account", description: "lookup", parameters: { type: "object" } },
                { name: "submit_step_result", description: "submit", parameters: { type: "object" } },
              ];
              const prepared = await modules.model.execution.prepare({ request: { provider: "test", model: "test-model", messages: [], tools: offered } as never, context: modelContext });
              assert.deepEqual(prepared.request.toolChoice, { type: "tool", name: "submit_step_result" });
              assert.deepEqual(prepared.request.tools?.map((tool) => tool.name), ["submit_step_result"]);
              // Even a runner's request remapping must preserve the active
              // SOP's protocol boundary at the host model execution port.
              for await (const _event of modules.model.execution.stream({
                prepared: { ...prepared, request: { ...prepared.request, toolChoice: undefined, tools: offered as never } }, context: modelContext,
              })) {}
              const [submitted] = await modules.capability.execution.executeAll(
                [{ id: "external-submit", name: "submit_step_result", input: { status: "completed", replyFragment: "External loop completed." } }],
                { sessionId: runInput.sessionId, turnId: runInput.turnId, cwd: root } as never,
                { sessionId: runInput.sessionId, turnId: runInput.turnId, runId: "external-run", operationId: "external-op" },
              );
              assert.equal(submitted?.type, "success");
              const result = {
                type: "success" as const,
                sessionId: runInput.sessionId,
                turnId: runInput.turnId,
                stopReason: "completed" as const,
                usage: {},
                permissionDenials: [],
                turns: 1,
                startedAt: "2026-09-18T00:00:00.000Z",
                completedAt: "2026-09-18T00:00:01.000Z",
              };
              yield { type: "turn_completed", sessionId: runInput.sessionId, turnId: runInput.turnId, result };
              return { result, messages: [] };
            },
          };
        },
      }),
    });

    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Run external SOP" }, { turnId: "external-turn" })) {
      events.push(event);
    }
    assert.equal(events.find((event) => event.type === "turn_failed")?.type, undefined, JSON.stringify(events));
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "External loop completed."));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("external-loop-session"))?.state.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store rejects a stale submission revision before replacing durable state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-revision-conflict-"));
  try {
    const store = new SopStateStore(root);
    const current = await store.loadOrCreate("revision-conflict", BUNDLE, "onboarding");
    await store.replace("revision-conflict", current.bundle, { ...current.state, status: "active" });
    await assert.rejects(
      () => store.commitSubmission(
        "revision-conflict",
        current.bundle,
        { ...current.state, status: "completed" },
        current.revision,
        "stale-turn",
        { status: "completed", replyFragment: "must not persist", slotUpdates: {}, events: [] },
      ),
      (error: unknown) => (error as { code?: string }).code === "SOP_REVISION_CONFLICT",
    );
    assert.equal((await store.status("revision-conflict"))?.revision, 2);
    assert.equal((await store.status("revision-conflict"))?.state.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP protocol rejection during prepare leaves the durable host state unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-prepare-protocol-rejection-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const before = await store.loadOrCreate("prepare-protocol", BUNDLE, "onboarding");
    const client: StaffDeckSopRuntimeClient = {
      async prepare() {
        throw new StaffDeckSopClientError(
          "SOP_RUNTIME_PROTOCOL",
          "StaffDeck SOP runtime returned an invalid prepare payload.",
          { field: "step.requiredToolNames" },
          "unsafe",
        );
      },
      async submit() {
        throw new Error("submit is unreachable after prepare rejection");
      },
    };
    const session = createSopSession({
      root,
      sessionId: "prepare-protocol",
      model: modelFromStream(async function* () { throw new Error("model must not run"); }),
      client,
    });

    const events = await collectSessionTurn(session, "Start", "prepare-protocol-turn");
    assert.ok(events.some((event) => event.type === "turn_failed"));
    assert.deepEqual(await store.status("prepare-protocol"), {
      sessionId: "prepare-protocol",
      revision: before.revision,
      state: before.state,
    });
    assert.equal(await store.replyDelivery("prepare-protocol"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP submit errors preserve owner diagnostics without advancing host state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-submit-error-projection-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const before = await store.loadOrCreate("submit-error", BUNDLE, "onboarding");
    const client: StaffDeckSopRuntimeClient = {
      ...acceptingClient(),
      async submit() {
        throw new StaffDeckSopClientError(
          "REQUIRED_CAPABILITY_NOT_INVOKED",
          "Required PilotDeck tool was not successful.",
          { missingToolNames: ["lookup_account"] },
          "unsafe",
        );
      },
    };
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield* yieldToolCall("rejected-submit", "submit_step_result", {
          status: "completed",
          replyFragment: "must not persist",
        });
        return;
      }
      yield* yieldText("The model received the SOP rejection and stopped.");
    });
    const session = createSopSession({ root, sessionId: "submit-error", model, client });
    const events = await collectSessionTurn(session, "Start", "submit-error-turn");
    const rejected = events.find((event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.result.toolCallId === "rejected-submit");
    assert.equal(rejected?.result.type, "error");
    assert.equal(rejected?.result.type === "error" && rejected.result.error.code, "tool_execution_failed");
    assert.match(rejected?.result.content[0]?.type === "text" ? rejected.result.content[0].text : "", /\[REQUIRED_CAPABILITY_NOT_INVOKED\]/u);
    assert.deepEqual(rejected?.result.type === "error" && rejected.result.error.details?.sopRuntime, {
      code: "REQUIRED_CAPABILITY_NOT_INVOKED",
      message: "Required PilotDeck tool was not successful.",
      retryability: "unsafe",
      details: { missingToolNames: ["lookup_account"] },
    });
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "The model received the SOP rejection and stopped."));
    assert.deepEqual(await store.status("submit-error"), {
      sessionId: "submit-error",
      // The ordinary prepare boundary runs once for each model turn. The
      // rejected submit itself must not add a commit or reply delivery.
      revision: before.revision + 2,
      state: { ...before.state, status: "active" },
    });
    assert.equal(await store.replyDelivery("submit-error"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP loop recovers in the same session after an ordinary PilotDeck tool failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-tool-recovery-"));
  try {
    let modelCall = 0;
    let toolCall = 0;
    let submittedSuccessfulTools: readonly string[] | undefined;
    const model = modelFromStream(async function* () {
      modelCall += 1;
      if (modelCall === 1 || modelCall === 3) {
        yield* yieldToolCall(modelCall === 1 ? "lookup-failed" : "lookup-retry", "lookup_account", { accountId: "ada" });
        return;
      }
      if (modelCall === 2) {
        yield* yieldText("The account lookup failed; retry is required.");
        return;
      }
      yield* yieldToolCall("submit-after-tool-retry", "submit_step_result", {
        status: "completed",
        replyFragment: "Account onboarding recovered.",
      });
    });
    const client = acceptingClient((successfulToolNames) => { submittedSuccessfulTools = successfulToolNames; });
    const session = createSopSession({
      root,
      sessionId: "tool-recovery",
      model,
      client,
      tools: toolPortWithResult(() => {
        toolCall += 1;
        if (toolCall === 1) {
          const now = new Date().toISOString();
          return {
            type: "error",
            toolCallId: "lookup-failed",
            toolName: "lookup_account",
            error: toolError("tool_execution_failed", "lookup unavailable"),
            content: [{ type: "text", text: "lookup unavailable" }],
            startedAt: now,
            completedAt: now,
          };
        }
        return successToolResult("lookup-retry", "lookup_account");
      }),
    });

    await collectSessionTurn(session, "Start onboarding", "tool-recovery-1");
    const failedState = await new SopStateStore(join(root, "sessions")).loadOrCreate("tool-recovery", BUNDLE, "onboarding");
    assert.deepEqual(failedState.state.successful_tool_names, []);
    assert.equal(failedState.state.status, "active");

    const recovered = await collectSessionTurn(session, "Retry onboarding", "tool-recovery-2");
    assert.deepEqual(submittedSuccessfulTools, ["lookup_account"]);
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Account onboarding recovered."));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("tool-recovery"))?.state.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted model output cannot submit or advance the SOP", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-stream-interruption-"));
  try {
    let submits = 0;
    const client = acceptingClient(() => { submits += 1; });
    const model = modelFromStream(async function* (_input, context) {
      if (context.abortSignal?.aborted) return;
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "partial-submit", name: "submit_step_result" };
      yield { type: "tool_call_delta", id: "partial-submit", delta: '{"status":"completed"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: { phase: "tool_call", activeToolCalls: [{ id: "partial-submit", name: "submit_step_result", argumentChars: 21 }] },
        },
      };
    });
    const session = createSopSession({ root, sessionId: "stream-interruption", model, client });
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Complete the SOP" }, { turnId: "stream-interruption-turn" })) {
      events.push(event);
      if (event.type === "turn_continued") session.abort("test_cancel_recovery");
    }

    assert.equal(submits, 0);
    assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "aborted");
    const state = await new SopStateStore(join(root, "sessions")).status("stream-interruption");
    assert.equal(state?.state.status, "active");
    assert.equal(await new SopStateStore(join(root, "sessions")).replyDelivery("stream-interruption"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling after a complete model tool call prevents SOP submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-cancel-"));
  try {
    let submits = 0;
    const client = acceptingClient(() => { submits += 1; });
    const model = modelFromStream(async function* () {
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "cancelled-submit", name: "submit_step_result" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "cancelled-submit",
          name: "submit_step_result",
          input: { status: "completed", replyFragment: "must not commit" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
    });
    const session = createSopSession({ root, sessionId: "cancel-before-submit", model, client });
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Complete the SOP" }, { turnId: "cancel-before-submit-turn" })) {
      events.push(event);
      if (event.type === "model_event" && event.event.type === "tool_call_end") session.abort("operator_cancelled");
    }

    assert.equal(submits, 0);
    assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "aborted");
    assert.equal((await new SopStateStore(join(root, "sessions")).status("cancel-before-submit"))?.state.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful tools survive a crash window before SOP submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-pre-submit-crash-"));
  try {
    let firstModelCall = 0;
    const firstModel = modelFromStream(async function* (_input, context) {
      firstModelCall += 1;
      if (firstModelCall === 1) {
        yield* yieldToolCall("lookup-before-crash", "lookup_account", { accountId: "ada" });
        return;
      }
      if (context.abortSignal?.aborted) return;
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "submit-before-crash", name: "submit_step_result" };
      yield { type: "tool_call_delta", id: "submit-before-crash", delta: '{"status":"completed"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "forced crash before SOP submission",
          retryable: true,
          streamInterruption: { phase: "tool_call", activeToolCalls: [{ id: "submit-before-crash", name: "submit_step_result", argumentChars: 21 }] },
        },
      };
    });
    const client = acceptingClient((successfulToolNames) => assert.deepEqual(successfulToolNames, ["lookup_account"]));
    const first = createSopSession({ root, sessionId: "pre-submit-crash", model: firstModel, client });
    for await (const event of first.submit({ type: "text", text: "Start" }, { turnId: "pre-submit-crash-1" })) {
      if (event.type === "turn_continued") first.abort("forced_process_exit");
    }
    assert.deepEqual(
      (await new SopStateStore(join(root, "sessions")).status("pre-submit-crash"))?.state.successful_tool_names,
      ["lookup_account"],
    );

    const retryModel = modelFromStream(async function* () {
      yield* yieldToolCall("submit-after-restart", "submit_step_result", {
        status: "completed",
        replyFragment: "Recovered after pre-submit crash.",
      });
    });
    const retry = createSopSession({ root, sessionId: "pre-submit-crash", model: retryModel, client });
    const events = await collectSessionTurn(retry, "Retry after restart", "pre-submit-crash-2");
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Recovered after pre-submit crash."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending SOP reply is recovered after state commit but before durable delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-pending-reply-"));
  try {
    const transcript = new FailOnceSopReplyTranscript();
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      yield* yieldToolCall("submit-pending-reply", "submit_step_result", {
        status: "completed",
        replyFragment: "Recovered pending SOP reply.",
      });
    });
    const client = acceptingClient();
    const first = createSopSession({ root, sessionId: "pending-reply", model, client, transcript });
    const failed = await collectSessionTurn(first, "Complete", "pending-reply-turn");
    assert.ok(failed.some((event) => event.type === "turn_failed"));
    assert.equal((await new SopStateStore(join(root, "sessions")).replyDelivery("pending-reply"))?.phase, "pending");

    const retry = createSopSession({ root, sessionId: "pending-reply", model, client, transcript });
    const recovered = await collectSessionTurn(retry, "Recover interrupted reply", "pending-reply-recovery-turn");
    assert.equal(modelCalls, 1, "reply recovery must not call the model again");
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Recovered pending SOP reply."));
    assert.equal(await new SopStateStore(join(root, "sessions")).replyDelivery("pending-reply"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable SOP reply is re-homed onto one completed recovery turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-recovery-"));
  try {
    const transcript = new InMemoryTranscriptWriter();
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      yield* yieldToolCall("submit-before-terminal-crash", "submit_step_result", {
        status: "completed",
        replyFragment: "Durable before terminal.",
      });
    });
    const client = acceptingClient();
    const first = createSopSession({ root, sessionId: "terminal-recovery", model, client, transcript });
    const interrupted = first.submit({ type: "text", text: "Complete" }, { turnId: "terminal-recovery-turn" });
    for await (const event of interrupted) {
      if (event.type === "assistant_message"
        && event.message.metadata?.purpose === "staffdeck_sop_reply") break;
    }
    assert.equal((await new SopStateStore(join(root, "sessions")).replyDelivery("terminal-recovery"))?.phase, "durable");
    const durableReplyCount = () => transcript.entries.filter((entry) =>
      (entry.type === "assistant_message" || entry.type === "durable_message")
      && entry.message.metadata?.purpose === "staffdeck_sop_reply").length;
    assert.equal(durableReplyCount(), 1);

    const retry = createSopSession({ root, sessionId: "terminal-recovery", model, client, transcript });
    const recovered = await collectSessionTurn(retry, "Recover interrupted terminal", "terminal-recovery-retry-turn");
    assert.equal(modelCalls, 1, "terminal recovery must not call the model again");
    assert.equal(durableReplyCount(), 2, "the completed recovery turn must own one durable copy of the reply");
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.metadata?.purpose === "staffdeck_sop_reply"));
    assert.equal(recovered.filter((event) => event.type === "turn_completed").length, 1);
    const visibleReplies = replayTranscriptEntries(transcript.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply");
    assert.equal(visibleReplies.length, 1);
    assert.equal(visibleReplies[0]?.content[0]?.type === "text" && visibleReplies[0].content[0].text, "Durable before terminal.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL after durable SOP reply persistence replays one visible reply without another model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-sigkill-recovery-"));
  try {
    const sessionId = "sigkill-recovery";
    const originalTurnId = "sigkill-original-turn";
    const transcriptPath = join(root, "transcript.jsonl");
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", killedReplyWriterSource({
      root,
      sessionId,
      turnId: originalTurnId,
      transcriptPath,
    })], { encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const stateStore = new SopStateStore(join(root, "sessions"));
    assert.equal((await stateStore.replyDelivery(sessionId))?.phase, "durable");
    const beforeRecovery = await readTranscript(transcriptPath);
    assert.equal(beforeRecovery.diagnostics.length, 0);
    assert.equal(replayTranscriptEntries(beforeRecovery.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply").length, 0,
    "an uncompleted turn must not become browser-visible before recovery");

    const transcript = new JsonlTranscriptWriter({ path: transcriptPath });
    const lastEntry = beforeRecovery.entries.at(-1);
    transcript.restoreState(lastEntry?.sequence ?? 0, lastEntry?.entryId ?? null);
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      throw new Error("recovery must not invoke the model");
    });
    const session = createSopSession({
      root,
      sessionId,
      model,
      client: acceptingClient(),
      transcript,
    });
    const events = await collectSessionTurn(session, "Recover durable reply", "sigkill-recovery-turn");
    await transcript.close();

    assert.equal(modelCalls, 0);
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
    assert.equal(await stateStore.replyDelivery(sessionId), undefined);
    const restored = await readTranscript(transcriptPath);
    assert.equal(restored.diagnostics.length, 0);
    const visibleReplies = replayTranscriptEntries(restored.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply");
    assert.equal(visibleReplies.length, 1);
    assert.equal(visibleReplies[0]?.content[0]?.type === "text" && visibleReplies[0].content[0].text, "Durable SIGKILL reply.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state snapshots keep distinct session ids that transcript paths coalesce", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("a/b", BUNDLE, "onboarding");
    await store.loadOrCreate("a-b", BUNDLE, "onboarding");
    const names = readdirSync(root).filter((name) => name.endsWith(".json"));
    assert.equal(names.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store migrates v1 and v2 waits and pending replies without losing session state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-migration-"));
  try {
    for (const schemaVersion of [1, 2] as const) {
      const sessionId = `legacy-${schemaVersion}`;
      const file = join(root, `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`);
      writeFileSync(file, JSON.stringify({
        schemaVersion,
        sessionId,
        bundle: BUNDLE,
        state: {
          version: 1,
          selected_skill_id: "onboarding",
          active_skill_id: "onboarding",
          active_step_id: "lookup",
          status: "handoff",
          slots_json: { account: "Ada" },
          skill_stack_json: [],
          successful_tool_names: [],
        },
        revision: 7,
        wait: { id: `wait-${schemaVersion}`, kind: "handoff", createdAt: "2026-01-01T00:00:00.000Z" },
        replyDelivery: {
          turnId: `turn-${schemaVersion}`,
          phase: "pending",
          result: { status: "handoff", replyFragment: "Need approval", slotUpdates: {}, events: [] },
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      }));
      const store = new SopStateStore(root);
      const status = await store.status(sessionId);
      assert.equal(status?.revision, 7);
      assert.equal(status?.wait?.id, `wait-${schemaVersion}`);
      assert.deepEqual(status?.state.slots_json, { account: "Ada" });
      assert.equal((await store.replyDelivery(sessionId))?.turnId, `turn-${schemaVersion}`);

      await store.replace(sessionId, BUNDLE, status!.state);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 3);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store rejects unreadable state without silently replacing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-invalid-"));
  try {
    const sessionId = "invalid-state";
    const file = join(root, `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`);
    writeFileSync(file, "{ definitely-not-json");
    const store = new SopStateStore(root);
    await assert.rejects(
      () => store.loadOrCreate(sessionId, BUNDLE, "onboarding"),
      /invalid JSON/,
    );
    assert.equal(readFileSync(file, "utf8"), "{ definitely-not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state records simultaneous successful tools without losing either result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-race-"));
  try {
    const store = new SopStateStore(root);
    await Promise.all([
      store.recordSuccessfulTools("same-session", BUNDLE, "onboarding", ["lookup_account"]),
      store.recordSuccessfulTools("same-session", BUNDLE, "onboarding", ["verify_account"]),
    ]);
    const persisted = await store.loadOrCreate("same-session", BUNDLE, "onboarding");
    assert.deepEqual(persisted.state.successful_tool_names, ["lookup_account", "verify_account"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state keeps the session definition snapshot after a deployment definition changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-definition-snapshot-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("snapshot-session", BUNDLE, "onboarding");
    const changedBundle: StaffDeckSopBundle = {
      sops: [{ id: "onboarding", version: "2", name: "Changed deployment definition", content: { nodes: [{ node_id: "new-step" }] } }],
    };
    const restored = await store.loadOrCreate("snapshot-session", changedBundle, "onboarding");
    assert.equal(restored.bundle.sops[0]?.name, "Onboarding");
    const fresh = await store.loadOrCreate("fresh-session", changedBundle, "onboarding");
    assert.equal(fresh.bundle.sops[0]?.name, "Changed deployment definition");
    assert.equal(fresh.bundle.sops[0]?.version, "2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP host control resumes handoff once and deduplicates the request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-resume-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("resume-session", BUNDLE, "onboarding");
    await store.replace("resume-session", BUNDLE, {
      selected_skill_id: "onboarding",
      active_skill_id: "onboarding",
      active_step_id: "lookup",
      status: "handoff",
      slots_json: { account: "Ada" },
      awaiting_input_json: { kind: "handoff" },
    });
    const waiting = await store.status("resume-session");
    assert.equal(waiting?.wait?.kind, "handoff");

    const resumed = await store.resume({
      sessionId: "resume-session",
      requestId: "human-reply-1",
      waitId: waiting!.wait!.id,
      source: "human",
      message: "Approved by the account owner.",
      expectedRevision: waiting!.revision,
      slotUpdates: { approved: true },
    });
    assert.equal(resumed.duplicate, false);
    const duplicate = await store.resume({
      sessionId: "resume-session",
      requestId: "human-reply-1",
      waitId: waiting!.wait!.id,
      source: "human",
      message: "Approved by the account owner.",
      slotUpdates: { approved: true },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, resumed.revision);
    await assert.rejects(() => store.resume({
      sessionId: "resume-session", requestId: "human-reply-1", waitId: "another-wait",
      source: "human", message: "Approved by the account owner.", slotUpdates: { approved: true },
    }), (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_REQUEST_CONFLICT");
    await assert.rejects(() => store.resume({
      sessionId: "resume-session", requestId: "human-reply-1", waitId: waiting!.wait!.id,
      source: "human", message: "Different answer", slotUpdates: { approved: true },
    }), (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_REQUEST_CONFLICT");

    const status = await store.status("resume-session");
    assert.equal(status?.state.status, "active");
    assert.equal(status?.wait, undefined);
    assert.deepEqual(status?.state.slots_json, { account: "Ada", approved: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff wait identity is stable on reload but belongs to one active node", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-wait-owner-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("wait-owner", BUNDLE, "onboarding");
    const approval = { version: 1, selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "approval", status: "handoff", slots_json: {}, skill_stack_json: [] };
    await store.replace("wait-owner", BUNDLE, approval);
    const first = (await store.status("wait-owner"))?.wait;
    assert.ok(first?.id);
    await store.replace("wait-owner", BUNDLE, approval);
    assert.equal((await store.status("wait-owner"))?.wait?.id, first.id);
    await store.replace("wait-owner", BUNDLE, { ...approval, active_step_id: "second_approval" });
    assert.notEqual((await store.status("wait-owner"))?.wait?.id, first.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP host control rejects stale and mismatched external resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-resume-reject-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("external-session", BUNDLE, "onboarding");
    await store.replace("external-session", BUNDLE, {
      selected_skill_id: "onboarding",
      active_skill_id: "onboarding",
      active_step_id: "lookup",
      status: "waiting_external_task",
      slots_json: {},
    });
    const waiting = await store.status("external-session");
    await assert.rejects(
      () => store.resume({
        sessionId: "external-session",
        requestId: "wrong-source",
        waitId: waiting!.wait!.id,
        source: "human",
        message: "wrong",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_SOURCE_INVALID",
    );
    await assert.rejects(
      () => store.resume({
        sessionId: "external-session",
        requestId: "stale-wait",
        waitId: "old-wait-id",
        source: "external_task",
        message: "completed",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_WAIT_STALE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function scriptedModel(): ModelInvokerPort & { requests: import("../../src/model/index.js").CanonicalModelRequest[] } {
  let call = 0;
  const requests: import("../../src/model/index.js").CanonicalModelRequest[] = [];
  return {
    requests,
    async prepare({ request }) {
      requests.push(request);
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      call += 1;
      const toolCall = call === 1
        ? { id: "lookup-call", name: "lookup_account", input: { accountId: "ada" } }
        : {
            id: "submit-call",
            name: "submit_step_result",
            input: { status: "completed", replyFragment: "Account onboarding is complete." },
          };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_end", toolCall };
      yield { type: "message_end", finishReason: "tool_call" };
    },
  };
}

function lookupTool(): PilotDeckToolDefinition {
  return {
    name: "lookup_account",
    description: "Look up an account.",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "found" }] }),
  };
}

function toolPort(tool: PilotDeckToolDefinition): ToolPort {
  return {
    list: () => [tool],
    async executeAll(calls): Promise<PilotDeckToolResult[]> {
      const now = new Date().toISOString();
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "found" }],
        startedAt: now,
        completedAt: now,
      }));
    },
  };
}

function createSopSession(input: {
  root: string;
  sessionId: string;
  model: ModelInvokerPort;
  client: StaffDeckSopRuntimeClient;
  tools?: ToolPort;
  context?: import("../../src/context/ContextRuntime.js").AgentContextRuntime;
  transcript?: AgentTranscriptWriter;
}) {
  const profile: StaffDeckSopRuntimeConfig = {
    provider: "staffdeck",
    endpoint: "http://unused.test",
    definitionsPath: join(input.root, "definitions.yaml"),
    defaultSopId: "onboarding",
    stateRoot: input.root,
  };
  const lookup = lookupTool();
  return createAgentSession({
    sessionId: input.sessionId,
    config: {
      provider: "test",
      model: "test-model",
      cwd: input.root,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd: input.root, mode: "bypassPermissions", canPrompt: false }),
      staffDeckSop: profile,
    },
    dependencies: {
      router: {} as never,
      ports: { model: input.model, tools: input.tools ?? toolPort(lookup) },
      ...(input.context ? { context: input.context } : {}),
      tools: { registry: { list: () => [lookup] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript: input.transcript,
    agentLoopFactory: (factoryInput) => new SopAgentLoop(factoryInput.config, factoryInput.capabilities, factoryInput.seedState, {
      profile,
      bundle: BUNDLE,
      client: input.client,
      stateStore: new SopStateStore(join(input.root, "sessions")),
    }),
  });
}

function acceptingClient(onSubmit?: (successfulToolNames: readonly string[]) => void, declaresHandoff = false): StaffDeckSopRuntimeClient {
  return {
    async prepare({ state }) {
      return {
        state: { ...state, status: "active" },
        step: {
          skillId: "onboarding",
          skillName: "Onboarding",
          version: "1",
          nodeId: "lookup",
          node: {},
          instruction: "Look up the account before replying.",
          expectedUserInfo: [],
          knownSlots: {},
          allowedNextStepIds: [],
          transitions: [{
            nextStepId: "confirm",
            condition: "approval_required",
            priority: 10,
            label: "Needs approval",
            targetStep: { name: "Confirm approval", type: "handoff", instruction: "Ask the owner to confirm." },
          }],
          requiredToolNames: ["lookup_account"],
          allowedActions: ["call_tool:lookup_account"],
          isTerminal: true,
          declaresHandoff,
        },
      };
    },
    async submit({ state, successfulToolNames, proposal }) {
      onSubmit?.(successfulToolNames);
      return {
        state: { ...state, status: proposal.status, successful_tool_names: [] },
        result: {
          status: proposal.status,
          replyFragment: proposal.replyFragment,
          slotUpdates: proposal.slotUpdates ?? {},
          events: [{ type: "sop_completed" }],
        },
      };
    },
  };
}

function modelFromStream(
  stream: (input: unknown, context: import("../../src/agent/modules/protocol.js").ModelExecutionContext) => AsyncIterable<CanonicalModelEvent>,
): ModelInvokerPort {
  return {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    stream({ prepared, context }) {
      return stream(prepared, context);
    },
  };
}

async function* yieldToolCall(id: string, name: string, input: Record<string, unknown>): AsyncIterable<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "tool_call_start", id, name };
  yield { type: "tool_call_end", toolCall: { id, name, input } };
  yield { type: "message_end", finishReason: "tool_call" };
}

async function* yieldText(text: string): AsyncIterable<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "text_delta", text };
  yield { type: "message_end", finishReason: "stop" };
}

function toolPortWithResult(result: (call: number) => PilotDeckToolResult): ToolPort {
  let call = 0;
  return {
    list: () => [lookupTool()],
    async executeAll() {
      call += 1;
      return [result(call)];
    },
  };
}

function successToolResult(toolCallId: string, toolName: string): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "success",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "found" }],
    startedAt: now,
    completedAt: now,
  };
}

async function collectSessionTurn(
  session: ReturnType<typeof createSopSession>,
  text: string,
  turnId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.submit({ type: "text", text }, { turnId })) events.push(event);
  return events;
}

class FailOnceSopReplyTranscript extends InMemoryTranscriptWriter {
  private failed = false;

  override recordDurableMessage(...args: Parameters<InMemoryTranscriptWriter["recordDurableMessage"]>) {
    const message = args[2];
    if (!this.failed && message.metadata?.purpose === "staffdeck_sop_reply") {
      this.failed = true;
      throw new Error("forced crash before SOP reply durability");
    }
    return super.recordDurableMessage(...args);
  }
}

function killedReplyWriterSource(input: {
  root: string;
  sessionId: string;
  turnId: string;
  transcriptPath: string;
}): string {
  const stateStoreUrl = pathToFileURL(join(process.cwd(), "dist/src/sop/staffdeck/SopStateStore.js")).href;
  const transcriptWriterUrl = pathToFileURL(join(process.cwd(), "dist/src/session/transcript/JsonlTranscriptWriter.js")).href;
  return `
    import { SopStateStore } from ${JSON.stringify(stateStoreUrl)};
    import { JsonlTranscriptWriter } from ${JSON.stringify(transcriptWriterUrl)};
    const bundle = ${JSON.stringify(BUNDLE)};
    const root = ${JSON.stringify(input.root)};
    const sessionId = ${JSON.stringify(input.sessionId)};
    const turnId = ${JSON.stringify(input.turnId)};
    const stateStore = new SopStateStore(root + "/sessions");
    const current = await stateStore.loadOrCreate(sessionId, bundle, "onboarding");
    const result = {
      status: "completed",
      replyFragment: "Durable SIGKILL reply.",
      slotUpdates: {},
      events: [{ type: "sop_completed" }],
    };
    await stateStore.commitSubmission(sessionId, current.bundle, {
      ...current.state,
      status: "completed",
      successful_tool_names: [],
    }, current.revision, turnId, result);
    const transcript = new JsonlTranscriptWriter({ path: ${JSON.stringify(input.transcriptPath)} });
    await transcript.recordDurableMessage(sessionId, turnId, {
      role: "assistant",
      content: [{ type: "text", text: result.replyFragment }],
      metadata: { purpose: "staffdeck_sop_reply", sopStatus: result.status, sopEvents: result.events },
    });
    await stateStore.markReplyDurable(sessionId, turnId);
    process.kill(process.pid, "SIGKILL");
  `;
}
