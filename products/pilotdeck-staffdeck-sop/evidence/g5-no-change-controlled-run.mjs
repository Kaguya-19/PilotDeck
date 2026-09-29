import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession } from "../../../dist/src/agent/session/createAgentSession.js";
import { createDefaultPermissionContext } from "../../../dist/src/permission/index.js";
import { SopAgentLoop } from "../../../dist/src/sop/staffdeck/SopAgentLoop.js";
import { SopStateStore } from "../../../dist/src/sop/staffdeck/SopStateStore.js";

const outputPath = process.env.G5_NO_CHANGE_OUTPUT ?? "products/pilotdeck-staffdeck-sop/evidence/g5-no-change-controlled-20260923.json";
const root = await mkdtemp(join(tmpdir(), "pilotdeck-no-change-sop-"));
const bundle = {
  sops: [{
    id: "project_delivery_plan",
    name: "Project delivery plan",
    version: "1.0.1",
    content: {
      start_node_id: "build_plan",
      nodes: [
        { node_id: "build_plan", type: "plan" },
        { node_id: "finalize_plan", type: "terminal" },
      ],
      edges: [{ source: "build_plan", target: "finalize_plan", condition: "no_scope_change", priority: 10 }],
      terminal_node_ids: ["finalize_plan"],
    },
  }],
};
const selectedTransitions = [];
let modelCall = 0;
const model = {
  async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
  async *stream() {
    modelCall += 1;
    const proposal = modelCall === 1
      ? { status: "completed", replyFragment: "计划草案已生成。", slotUpdates: { project_goal: "交付 SOP", current_stage: "验证", known_blockers: "无" }, nextStepId: "finalize_plan" }
      : { status: "completed", replyFragment: "最终计划已完成。", slotUpdates: {} };
    yield { type: "message_start", role: "assistant" };
    yield { type: "tool_call_start", id: `no-change-${modelCall}`, name: "submit_step_result" };
    yield { type: "tool_call_end", toolCall: { id: `no-change-${modelCall}`, name: "submit_step_result", input: proposal } };
    yield { type: "message_end", finishReason: "tool_call" };
  },
};
const client = {
  async prepare({ state }) {
    const nodeId = state.active_step_id ?? "build_plan";
    return {
      state: { ...state, status: "active", active_step_id: nodeId },
      step: {
        skillId: "project_delivery_plan",
        skillName: "Project delivery plan",
        version: "1.0.1",
        nodeId,
        node: { node_id: nodeId },
        instruction: "Submit the step result and choose the applicable transition.",
        expectedUserInfo: [],
        knownSlots: state.slots_json ?? {},
        allowedNextStepIds: nodeId === "build_plan" ? ["finalize_plan"] : [],
        transitions: nodeId === "build_plan" ? [{ nextStepId: "finalize_plan", condition: "no_scope_change", priority: 10, label: "No scope change", targetStep: { name: "Finalize plan", type: "terminal" } }] : [],
        requiredToolNames: [],
        allowedActions: [],
        isTerminal: nodeId === "finalize_plan",
        declaresHandoff: false,
      },
    };
  },
  async submit({ state, proposal }) {
    const nextStepId = proposal.nextStepId;
    if (nextStepId === "finalize_plan") selectedTransitions.push("no_scope_change");
    return {
      state: {
        ...state,
        status: proposal.status,
        active_step_id: nextStepId ?? state.active_step_id,
        slots_json: { ...(state.slots_json ?? {}), ...(proposal.slotUpdates ?? {}) },
        successful_tool_names: [],
      },
      result: { status: proposal.status, replyFragment: proposal.replyFragment, slotUpdates: proposal.slotUpdates ?? {}, events: [] },
    };
  },
};
const stateStore = new SopStateStore(join(root, "sessions"));
const noopTool = { name: "noop", description: "No-op", kind: "custom", inputSchema: { type: "object", additionalProperties: true }, isReadOnly: () => true, isConcurrencySafe: () => true, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };
const session = createAgentSession({
  sessionId: "no-change-controlled-session",
  config: {
    provider: "test",
    model: "test-model",
    cwd: root,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd: root, mode: "bypassPermissions", canPrompt: false }),
    staffDeckSop: { provider: "staffdeck", endpoint: "http://unused.test", definitionsPath: join(root, "definitions.json"), defaultSopId: "project_delivery_plan", stateRoot: join(root, "sessions") },
  },
  dependencies: {
    router: {},
    ports: { model, tools: { list: () => [noopTool], executeAll: async () => [] } },
    tools: { registry: { list: () => [noopTool] }, scheduler: { executeAll: async () => [] } },
  },
  agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, { profile: input.config.staffDeckSop, bundle, client, stateStore }),
});
const events = [];
try {
  for await (const event of session.submit({ type: "text", text: "请生成项目推进计划，当前没有范围变化。" }, { turnId: "no-change-controlled-turn" })) events.push(event.type === "error" ? { type: event.type, code: event.code, message: event.message } : event.type === "turn_failed" ? event : event.type);
  const status = await stateStore.status("no-change-controlled-session");
  const result = {
    status: status?.state?.status === "completed" ? "passed" : "partial",
    mode: "controlled-scripted-model",
    naturalEntry: false,
    nativeStaffDeck: false,
    graph: { from: "build_plan", condition: "no_scope_change", to: "finalize_plan" },
    selectedTransitions,
    modelCalls: modelCall,
    terminal: { status: status?.state?.status ?? null, activeStep: status?.state?.active_step_id ?? null },
    eventTypes: events,
  };
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result));
} finally {
  await session.dispose();
  await rm(root, { recursive: true, force: true });
}
