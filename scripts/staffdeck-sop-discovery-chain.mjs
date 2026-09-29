#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const { createAgentSession } = await import("../dist/src/agent/session/createAgentSession.js");
const { createDefaultPermissionContext } = await import("../dist/src/permission/index.js");
const { SopAgentLoop } = await import("../dist/src/sop/staffdeck/SopAgentLoop.js");
const { SopStateStore } = await import("../dist/src/sop/staffdeck/SopStateStore.js");

const defaultBundle = resolve(new URL("../fixtures/staffdeck-sop-discovery-bundle.json", import.meta.url).pathname);
const defaults = {
  staffdeckUrl: "http://127.0.0.1:16223",
  agentId: "agent_tenant_demo_overall",
  apiKeyEnv: "STAFFDECK_SOP_API_KEY",
  bundle: defaultBundle,
  stateRoot: "",
  output: "",
  purchaseMessage: "I need to purchase a laptop",
  compareMessage: "Please compare prices for two laptops",
  approvalMessage: "Please submit an expense over the approval limit for manager approval",
  ordinaryMessage: "Please answer this ordinary question",
};

function parseArgs(argv) {
  const values = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!(key in values)) throw new Error(`Unknown argument: ${token}`);
    values[key] = argv[++index];
  }
  return values;
}

function writeReport(output, report) {
  if (!output) return;
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
const apiKey = process.env[options.apiKeyEnv];
if (!apiKey) {
  const report = { status: "BLOCKED", reason: "missing_api_key", apiKeyEnv: options.apiKeyEnv };
  writeReport(options.output, report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2;
} else {
  const bundle = JSON.parse(readFileSync(resolve(options.bundle), "utf8"));
  const stateRoot = options.stateRoot ? resolve(options.stateRoot) : mkdtempSync(join(tmpdir(), "pilotdeck-sop-chain-"));
  const stateStore = new SopStateStore(join(stateRoot, "sessions"));
  const routeResponses = [];
  const lifecycle = [];
  const observations = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (String(url).includes("/sops:route")) routeResponses.push(await response.clone().json());
    return response;
  };

  const runtimeClient = {
    async prepare({ bundle: selectedBundle, state, context }) {
      const selected = selectedBundle.sops.find((item) => item.id === state.selected_skill_id);
      assert(selected, `selected SOP is absent from the supplied bundle: ${state.selected_skill_id}`);
      lifecycle.push({ kind: "prepare", sessionId: context?.sessionId, sopId: selected.id, version: selected.version });
      return {
        state: { ...state, status: "active" },
        step: {
          skillId: selected.id,
          skillName: selected.name,
          version: selected.version,
          nodeId: "start",
          node: {},
          instruction: selected.content.nodes[0]?.instruction ?? "",
          expectedUserInfo: [],
          knownSlots: {},
          allowedNextStepIds: [],
          requiredToolNames: [],
          allowedActions: [],
          isTerminal: false,
          declaresHandoff: false,
        },
      };
    },
    async submit({ state, proposal, context }) {
      lifecycle.push({ kind: "submit", sessionId: context?.sessionId, sopId: state.selected_skill_id, status: proposal.status });
      return {
        state: { ...state, status: proposal.status },
        result: { status: proposal.status, replyFragment: proposal.replyFragment, slotUpdates: {}, events: [] },
      };
    },
  };

  function makeSession(sessionId) {
    const profile = {
      provider: "staffdeck",
      endpoint: "unused",
      definitionsPath: join(stateRoot, "definitions.yaml"),
      defaultSopId: bundle.sops[0].id,
      stateRoot,
      discoveryEndpoint: `${options.staffdeckUrl.replace(/\/+$/u, "")}/api/v1`,
      discoveryAgentId: options.agentId,
      discoveryApiKey: apiKey,
    };
    return createAgentSession({
      sessionId,
      config: {
        provider: "validation",
        model: "validation",
        cwd: stateRoot,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd: stateRoot, mode: "bypassPermissions", canPrompt: false }),
        staffDeckSop: profile,
      },
      dependencies: {
        router: {},
        context: {
          async prepareForModel(input) {
            const systemPrompt = input.appendSystemPrompt ?? "";
            return {
              messages: input.messages,
              systemPrompt: systemPrompt || undefined,
              systemPromptParts: systemPrompt ? [systemPrompt] : [],
              tools: input.tools,
              boundaries: [],
              diagnostics: [],
            };
          },
        },
        ports: {
          model: {
            async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
            async *stream() { yield { type: "message_start", role: "assistant" }; },
          },
          tools: { list: () => [], async executeAll() { return []; } },
        },
        tools: { registry: { list: () => [] }, scheduler: { executeAll: async () => [] } },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle,
        client: runtimeClient,
        stateStore,
        runnerFactory: ({ capabilities }) => ({
          snapshotFileState: () => ({}),
          async *run(runInput) {
            const tools = capabilities.toolExecution.list().map((tool) => tool.name);
            const prepared = await capabilities.contextPreparation.prepareForModel({
              sessionId: runInput.sessionId,
              turnId: runInput.turnId,
              cwd: stateRoot,
              provider: "validation",
              model: "validation",
              permissionMode: "bypassPermissions",
              additionalWorkingDirectories: [],
              messages: runInput.messages,
              tools: [],
            });
            if (runInput.sessionId === "approval-session" && runInput.turnId === "approval-turn-1") {
              const [submitted] = await capabilities.toolExecution.executeAll(
                [{ id: "approval-submit", name: "submit_step_result", input: { status: "awaiting_user", replyFragment: "Approval request submitted; waiting for approval." } }],
                { sessionId: runInput.sessionId, turnId: runInput.turnId, cwd: stateRoot },
                { sessionId: runInput.sessionId, turnId: runInput.turnId, runId: "approval-run", operationId: "approval-submit" },
              );
              assert.equal(submitted?.type, "success");
            }
            observations.push({
              sessionId: runInput.sessionId,
              hasSopTool: tools.includes("submit_step_result"),
              hasSopPrompt: [prepared.systemPrompt ?? "", ...(prepared.systemPromptParts ?? [])].join("\n").includes("<staffdeck-sop>"),
            });
            const result = {
              type: "success",
              sessionId: runInput.sessionId,
              turnId: runInput.turnId,
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
            yield { type: "turn_completed", sessionId: runInput.sessionId, turnId: runInput.turnId, result };
            return { result, messages: runInput.messages };
          },
        }),
      }),
    });
  }

  async function submitTurn(session, sessionId, message, turnId) {
    for await (const event of session.submit({ type: "text", text: message }, { turnId })) {
      if (event.type === "turn_failed") throw new Error(event.error.message);
    }
  }

  async function submit(sessionId, message) {
    await submitTurn(makeSession(sessionId), sessionId, message, `${sessionId}-turn-1`);
  }

  try {
    await submit("purchase-session", options.purchaseMessage);
    await submit("compare-session", options.compareMessage);
    const approvalSession = makeSession("approval-session");
    await submitTurn(approvalSession, "approval-session", options.approvalMessage, "approval-turn-1");
    await submitTurn(approvalSession, "approval-session", "Continue the approval request", "approval-turn-2");
    await submit("ordinary-session", options.ordinaryMessage);
    assert.equal(routeResponses.some((item) => item.selected_sop_id === "skill_purchase_001"), true);
    assert.equal(routeResponses.some((item) => item.selected_sop_id === "skill_price_compare_001"), true);
    assert.equal(routeResponses.some((item) => item.selected_sop_id === "expense_over_limit_approval"), true);
    assert.equal(lifecycle.filter((item) => item.sessionId === "approval-session" && item.kind === "prepare").length, 2);
    assert.equal(lifecycle.filter((item) => item.sessionId === "approval-session" && item.kind === "submit").length, 1);
    assert.equal(observations.find((item) => item.sessionId === "ordinary-session")?.hasSopTool, false);
    assert.equal(observations.find((item) => item.sessionId === "ordinary-session")?.hasSopPrompt, false);
    const report = {
      status: "PASS",
      mode: "live-staffdeck-discovery",
      staffdeckUrl: options.staffdeckUrl,
      agentId: options.agentId,
      routeResponses: routeResponses.map((item) => ({
        decision: item.decision,
        selected_sop_id: item.selected_sop_id,
        target_step_id: item.target_step_id,
        candidate_sop_ids: item.candidate_sop_ids,
      })),
      lifecycle,
      observations,
      stateRoot,
    };
    writeReport(options.output, report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
