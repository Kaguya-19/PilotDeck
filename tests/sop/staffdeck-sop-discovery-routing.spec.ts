import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { SopAgentLoop } from "../../src/sop/staffdeck/SopAgentLoop.js";
import { SopStateStore } from "../../src/sop/staffdeck/SopStateStore.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopRuntimeClient,
  StaffDeckSopRuntimeConfig,
} from "../../src/sop/staffdeck/types.js";

const BUNDLE: StaffDeckSopBundle = {
  sops: [
    { id: "purchase", name: "Purchase", content: { nodes: [{ node_id: "start" }] } },
    { id: "compare", name: "Compare", content: { nodes: [{ node_id: "start" }] } },
  ],
};

test("native discovery routes two SOPs, leaves no-match ordinary, rejects invisible selection, and pins an existing session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-discovery-routing-"));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ session_id: string; message: string }> = [];
  try {
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { session_id: string; message: string };
      calls.push(body);
      const selected = body.message.includes("purchase")
        ? "purchase"
        : body.message.includes("compare")
          ? "compare"
          : body.message.includes("hidden") ? "hidden" : undefined;
      return new Response(JSON.stringify({
        decision: selected ? "start_new_task" : "answer_only",
        selected_sop_id: selected ?? null,
        target_step_id: selected ? "start" : null,
        candidate_sop_ids: ["purchase", "compare"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client: StaffDeckSopRuntimeClient = {
      async prepare({ state }) {
        const selected = String(state.selected_skill_id ?? "");
        return {
          state: { ...state, status: "active" },
          step: {
            skillId: selected,
            skillName: selected,
            version: "1.0.0",
            nodeId: "start",
            node: {},
            instruction: `${selected} instruction`,
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
      async submit({ state, proposal }) {
        return {
          state: { ...state, status: proposal.status },
          result: {
            status: proposal.status,
            replyFragment: proposal.replyFragment,
            slotUpdates: proposal.slotUpdates ?? {},
            events: [],
          },
        };
      },
    };

    const profile: StaffDeckSopRuntimeConfig = {
      provider: "staffdeck",
      endpoint: "http://unused.test",
      definitionsPath: join(root, "definitions.yaml"),
      defaultSopId: "purchase",
      stateRoot: root,
      discoveryEndpoint: "http://discovery.test/api/v1",
      discoveryAgentId: "agent-1",
      discoveryApiKey: "sd_live_test",
    };
    const observations: Array<{ sessionId: string; tools: string[]; prompt: string }> = [];
    const makeSession = (sessionId: string) => createAgentSession({
      sessionId,
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
            async *stream() { yield { type: "message_start", role: "assistant" } as never; },
          },
          tools: { list: () => [], async executeAll() { return []; } },
        },
        tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle: BUNDLE,
        client,
        stateStore: new SopStateStore(join(root, "sessions")),
        runnerFactory: ({ capabilities }) => ({
          snapshotFileState: () => ({}),
          async *run(runInput) {
            const tools = capabilities.toolExecution.list().map((tool) => tool.name);
            const prepared = await capabilities.contextPreparation.prepareForModel({
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
            const prompt = [
              prepared.systemPrompt ?? "",
              ...(prepared.systemPromptParts ?? []),
            ].join("\n");
            observations.push({ sessionId: runInput.sessionId, tools, prompt });
            const result = {
              type: "success" as const,
              sessionId: runInput.sessionId,
              turnId: runInput.turnId,
              stopReason: "completed" as const,
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-22T00:00:00.000Z",
              completedAt: "2026-09-22T00:00:01.000Z",
            };
            yield { type: "turn_completed", sessionId: runInput.sessionId, turnId: runInput.turnId, result };
            return { result, messages: runInput.messages };
          },
        }),
      }),
    });
    const run = async (sessionId: string, message: string, turnId: string) => {
      const session = makeSession(sessionId);
      for await (const event of session.submit({ type: "text", text: message }, { turnId })) {
        if (event.type === "turn_failed") {
          throw Object.assign(new Error(event.error.message), { code: event.error.code });
        }
      }
    };

    await run("purchase-session", "please purchase this", "purchase-1");
    await run("compare-session", "please compare prices", "compare-1");
    await run("ordinary-session", "ordinary conversation", "ordinary-1");
    assert.deepEqual(calls.map((call) => call.session_id), ["purchase-session", "compare-session", "ordinary-session"]);
    assert.equal(observations[0]?.tools.includes("submit_step_result"), true);
    assert.equal(observations[1]?.tools.includes("submit_step_result"), true);
    assert.equal(observations[2]?.tools.includes("submit_step_result"), false);
    assert.match(observations[0]?.prompt ?? "", /<staffdeck-sop>/);
    assert.doesNotMatch(observations[2]?.prompt ?? "", /<staffdeck-sop>/);

    const existing = makeSession("existing-session");
    for await (const _event of existing.submit({ type: "text", text: "please purchase this" }, { turnId: "existing-1" })) { /* consume */ }
    for await (const _event of existing.submit({ type: "text", text: "please compare prices" }, { turnId: "existing-2" })) { /* consume */ }
    assert.deepEqual(calls.filter((call) => call.session_id === "existing-session").map((call) => call.message), ["please purchase this"]);
    assert.equal(observations.at(-1)?.tools.includes("submit_step_result"), true);

    await assert.rejects(
      async () => { await run("hidden-session", "select hidden SOP", "hidden-1"); },
      (error: unknown) => (error as Error).message.includes("did not expose it as a candidate"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
