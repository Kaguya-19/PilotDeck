import fs from "node:fs";
import path from "node:path";

const root = process.env.PARITY_SOURCE_ROOT;
const scenario = JSON.parse(process.env.PARITY_SCENARIO_JSON);
const mock = process.env.PARITY_MOCK_BASE_URL;
const output = process.env.PARITY_TRACE_OUT;
const runKey = process.env.PARITY_RUN_KEY ?? "native-parity";
const sessionModule = path.join(root, "dist/src/agent/session/createAgentSession.js");
if (!fs.existsSync(sessionModule)) throw new Error(`PilotDeck baseline build is missing ${sessionModule}`);
const { createAgentSession } = await import(pathToUrl(sessionModule));
const { ToolRegistry } = await import(pathToUrl(path.join(root, "dist/src/tool/registry/ToolRegistry.js")));
const { createDefaultPermissionContext } = await import(pathToUrl(path.join(root, "dist/src/permission/protocol/types.js")));

let sequence = 0;
const trace = [];
const push = (kind, extra = {}) => trace.push({ kind, scenarioId: scenario.scenarioId, q: scenario.q, sequence: sequence++, ...extra });
const post = async (suffix, body) => (await fetch(`${mock}${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const registry = new ToolRegistry();
for (const name of scenario.tools ?? []) {
  registry.register({
    name, description: name, kind: "custom", inputSchema: { type: "object" },
    isReadOnly: () => !["restricted", "loop"].includes(name),
    isConcurrencySafe: () => ["lookup", "summarize"].includes(name),
    checkPermissions: async () => {
      const denied = scenario.permission?.deny?.includes(name) ?? false;
      push("permission.decision", { toolName: name, allowed: !denied });
      return denied
        ? { type: "deny", message: "Deterministic permission denial.", reason: { type: "tool", toolName: name, message: "denied" } }
        : { type: "allow", reason: { type: "tool", toolName: name, message: "allowed" } };
    },
    execute: async (input) => {
      push("tool.call", { name, arguments: input });
      const result = await post("/tools/execute", { scenarioId: scenario.scenarioId, q: scenario.q, name, arguments: input, permissionAllowed: !scenario.permission?.deny?.includes(name), runKey });
      push("tool.result", { result });
      if (result.type === "error") throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return { content: [{ type: "text", text: JSON.stringify(result.data) }], data: result.data };
    },
  });
}
const router = {
  decide: async () => ({ provider: "parity", model: "deterministic", scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
  materializeRequest: (_decision, request) => request,
  execute: async function* (_decision, request, signal) { yield* this.stream(request, signal); },
  stream: async function* (request) {
    push("model.request", { request });
    const result = await post("/v1/chat/completions", { scenarioId: scenario.scenarioId, q: scenario.q, messages: request.messages, delays: scenario.delays, runKey });
    const message = result.choices[0].message;
    push("model.response", { response: message });
    yield { type: "message_start", role: "assistant" };
    for (const call of message.tool_calls ?? []) yield { type: "tool_call_end", toolCall: { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) } };
    if (message.tool_calls?.length) yield { type: "message_end", finishReason: "tool_call" };
    else { yield { type: "text_delta", text: message.content ?? "" }; yield { type: "message_end", finishReason: "stop" }; }
  },
};
const permissionMode = scenario.permission?.mode ?? "default";
const permissionContext = createDefaultPermissionContext({ cwd: root, mode: permissionMode, rules: { deny: (scenario.permission?.deny ?? []).map((toolName) => ({ source: "user", behavior: "deny", toolName })) } });
const scenarioMessages = (scenario.messages ?? []).map(canonicalMessage);
const lastMessage = scenarioMessages.at(-1);
const hasCurrentUserMessage = lastMessage?.role === "user";
const historyMessages = hasCurrentUserMessage ? scenarioMessages.slice(0, -1) : scenarioMessages;
const initialState = historyMessages.length ? {
  sessionId: "session-parity",
  messages: historyMessages,
  usage: {},
  permissionDenials: [],
  status: "idle",
  abortController: new AbortController(),
} : undefined;
const session = createAgentSession({
  sessionId: "session-parity",
  config: { provider: "parity", model: "deterministic", cwd: root, systemPrompt: "Return the deterministic answer.", permissionMode, permissionContext, metadata: { scenarioId: scenario.scenarioId } },
  dependencies: { router, tools: { registry }, now: () => new Date("2026-01-01T00:00:00.000Z"), uuid: () => "parity-id" },
  initialState,
  seedState: scenario.seedState,
});
const currentContent = hasCurrentUserMessage ? lastMessage.content : [{ type: "text", text: scenario.q }];
const input = { type: "blocks", content: currentContent };
const limits = scenario.limits ?? {};
let cancelled = false;
let deadlineExceeded = false;
const cancelTimer = limits.cancelAfterMs ? setTimeout(() => { cancelled = true; session.abort("parity_cancel"); }, limits.cancelAfterMs) : undefined;
const deadlineTimer = limits.deadlineMs ? setTimeout(() => { deadlineExceeded = true; session.abort("deadline_exceeded"); }, limits.deadlineMs) : undefined;
try {
  for await (const event of session.submit(input, { turnId: "turn-parity", maxTurns: limits.maxTurns, permissionMode, permissionRules: permissionContext.rules })) {
    if (event.type === "turn_completed") push("terminal", { outcome: outcome(event.result.type, { cancelled, deadlineExceeded }), code: deadlineExceeded ? "DEADLINE_EXCEEDED" : event.result.errors?.[0]?.code, stopReason: event.result.stopReason, structuredResult: event.result.structuredOutput, output: textOf(event.result.finalMessage) });
  }
} catch (error) {
  push("terminal", { outcome: "failed", code: error.code ?? "ADAPTER_ERROR", error: String(error.message ?? error) });
} finally {
  if (cancelTimer) clearTimeout(cancelTimer);
  if (deadlineTimer) clearTimeout(deadlineTimer);
}
fs.writeFileSync(output, trace.map((item) => JSON.stringify(item)).join("\n") + "\n");
process.exit(trace.some((item) => item.kind === "terminal") ? 0 : 2);

function pathToUrl(file) { return new URL(`file://${file}`).href; }
function imageBlock(block) { const match = /^data:([^;]+);base64,(.+)$/.exec(block.image_url?.url ?? ""); return match ? { type: "image", source: "base64", mimeType: match[1], data: match[2] } : { type: "text", text: "[invalid image]" }; }
function canonicalMessage(message) {
  const content = Array.isArray(message.content)
    ? message.content.map((block) => block.type === "image_url" ? imageBlock(block) : block)
    : [{ type: "text", text: String(message.content ?? "") }];
  return { role: message.role, content };
}
function outcome(type, state) { if (state.deadlineExceeded) return "failed"; if (state.cancelled) return "cancelled"; return type === "success" ? "completed" : type === "aborted" ? "cancelled" : "failed"; }
function textOf(message) { return (message?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join(""); }
