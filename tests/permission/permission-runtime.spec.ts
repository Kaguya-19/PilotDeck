import test from "node:test";
import assert from "node:assert/strict";
import { PermissionRuntime } from "../../src/permission/index.js";
import { createDefaultPermissionContext } from "../../src/permission/protocol/types.js";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";

function tool(name: string, readOnly: boolean, checkPermissions?: (input: unknown) => unknown) {
  return { name, kind: name === "bash" ? "shell" : "filesystem", isReadOnly: () => readOnly, checkPermissions } as never;
}

type ContextOptions = Omit<Parameters<typeof createDefaultPermissionContext>[0], "cwd"> & { cwd?: string };

function context(options: ContextOptions = {}) {
  return createDefaultPermissionContext({ cwd: "/workspace", canPrompt: true, bypassAvailable: true, ...options });
}

function runtimeContext(options: ContextOptions = {}) {
  const permissionContext = context(options);
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: permissionContext.cwd,
    permissionMode: permissionContext.mode,
    permissionContext,
  };
}

test("PermissionRuntime applies deny before allow and preserves tool identity", async () => {
  const decision = await new PermissionRuntime().decide(
    tool("bash", false),
    { command: "rm -rf /" },
    runtimeContext({ rules: { allow: [{ source: "user", behavior: "allow", toolName: "bash" }], deny: [{ source: "policy", behavior: "deny", toolName: "bash", pattern: "rm*" }] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  assert.equal(decision.reason.type, "rule");
});

test("PermissionRuntime handles default, plan and bypass modes", async () => {
  const runtime = new PermissionRuntime();
  assert.equal((await runtime.decide(tool("read_file", true), { file_path: "a.txt" }, runtimeContext(), "read")).type, "allow");
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: "a.txt" }, runtimeContext(), "write")).type, "ask");
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: "a.txt" }, runtimeContext({ mode: "plan" }), "plan")).type, "deny");
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: "a.txt" }, runtimeContext({ mode: "bypassPermissions" }), "bypass")).type, "allow");
});

test("PermissionRuntime allows plan files but not writes outside the plan directory", async () => {
  const runtime = new PermissionRuntime();
  const planContext = runtimeContext({ mode: "plan", planDirectoryPath: "/workspace/.pilotdeck/plans" });
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: ".pilotdeck/plans/plan.md" }, planContext, "plan-file")).type, "allow");
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: ".pilotdeck/plans/plan.txt" }, planContext, "bad-ext")).type, "deny");
  assert.equal((await runtime.decide(tool("write_file", false), { file_path: ".pilotdeck/plans/../secret.md" }, planContext, "escape")).type, "deny");
});

test("PermissionRuntime finalizes ask according to prompt availability", async () => {
  const runtime = new PermissionRuntime();
  const askingTool = tool("web_search", false, () => ({ type: "ask", reason: { type: "tool", toolName: "web_search", message: "confirm" } }));
  const ask = await runtime.decide(askingTool, { query: "test" }, runtimeContext(), "ask-1");
  assert.equal(ask.type, "ask");
  assert.equal(ask.request.toolCallId, "ask-1");
  const denied = await runtime.decide(askingTool, {}, runtimeContext({ canPrompt: false }), "ask-2");
  assert.equal(denied.type, "deny");
});

test("permission rule matching handles workspace and wildcard paths", () => {
  const permissionContext = context({ additionalWorkingDirectories: ["/shared"] });
  assert.equal(matchPermissionRule({ source: "user", behavior: "allow", toolName: "read_file", pattern: "*.ts" }, "read_file", { file_path: "src/a.ts" }, permissionContext), true);
  assert.equal(matchPermissionRule({ source: "user", behavior: "allow", toolName: "bash", pattern: "git:*" }, "bash", { command: "git status" }, permissionContext), true);
  assert.equal(matchPermissionRule({ source: "user", behavior: "allow", toolName: "write_file" }, "write_file", { file_path: "/outside/a.txt" }, permissionContext), false);
  assert.equal(matchPermissionRule({ source: "user", behavior: "allow", toolName: "tool_*" }, "tool_name"), true);
});

test("PermissionRuntime preserves session allow precedence and normalizes tool decisions", async () => {
  const runtime = new PermissionRuntime();
  const sessionAllow = { source: "session" as const, behavior: "allow" as const, toolName: "danger" };
  const userDeny = { source: "user" as const, behavior: "deny" as const, toolName: "danger" };
  const deniedByTool = tool("danger", false, () => ({
    type: "deny",
    reason: { type: "safety", message: "blocked" },
    message: "blocked",
  }));
  const sessionDecision = await runtime.decide(
    deniedByTool,
    { value: 1 },
    runtimeContext({ rules: { allow: [sessionAllow], deny: [userDeny] } }),
    "session-deny",
  );
  assert.equal(sessionDecision.type, "deny");

  const askTool = tool("remember", false, () => ({
    type: "ask",
    reason: { type: "tool", toolName: "remember", message: "confirm" },
    request: { toolCallId: "old", toolName: "old", inputSummary: "x", reason: { type: "tool", toolName: "remember", message: "confirm" }, options: [] },
  }));
  const allowed = await runtime.decide(
    askTool,
    { value: 2 },
    runtimeContext({ rules: { allow: [{ ...sessionAllow, toolName: "remember" }] } }),
    "session-ask",
  );
  assert.equal(allowed.type, "allow");

  const passthrough = tool("passthrough", false, () => ({ type: "passthrough" }));
  assert.equal((await runtime.decide(passthrough, {}, runtimeContext({ mode: "bypassPermissions" }), "pass")).type, "allow");
  const cancelled = tool("cancelled", false, () => ({
    type: "cancel",
    reason: { type: "runtime", message: "cancelled" },
    message: "cancelled",
  }));
  assert.equal((await runtime.decide(cancelled, {}, runtimeContext(), "cancel")).type, "cancel");
  const unknown = tool("unknown", false, () => ({ type: "unknown" }));
  assert.equal((await runtime.decide(unknown, {}, runtimeContext(), "unknown")).type, "ask");
});

test("PermissionRuntime handles ask rules, plan allow fallthrough and safe summaries", async () => {
  const runtime = new PermissionRuntime();
  const askRule = { source: "user" as const, behavior: "ask" as const, toolName: "write_file" };
  const asked = await runtime.decide(
    tool("write_file", false),
    { file_path: "x.md" },
    runtimeContext({ rules: { ask: [askRule] }, canPrompt: false }),
    "ask-rule",
  );
  assert.equal(asked.type, "deny");

  const allowRule = { source: "user" as const, behavior: "allow" as const, toolName: "write_file" };
  const planDenied = await runtime.decide(
    tool("write_file", false),
    { file_path: "outside.md" },
    runtimeContext({ mode: "plan", planDirectoryPath: "/workspace/.pilotdeck/plans", rules: { allow: [allowRule] } }),
    "plan-allow",
  );
  assert.equal(planDenied.type, "deny");
  assert.match(planDenied.message, /plan/i);

  const planBash = await runtime.decide(
    tool("bash", false),
    { command: "git push origin main" },
    runtimeContext({ mode: "plan" }),
    "plan-bash",
  );
  assert.equal(planBash.type, "deny");
  assert.match(planBash.message, /git push|plan/i);

  const long = "x".repeat(700);
  const request = await runtime.decide(tool("write_file", false), { value: long }, runtimeContext(), "long");
  assert.equal(request.type, "ask");
  if (request.type === "ask") assert.match(request.request.inputSummary, /\.\.\.$/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const circularDecision = await runtime.decide(tool("write_file", false), circular, runtimeContext(), "circular");
  assert.equal(circularDecision.type, "ask");
  if (circularDecision.type === "ask") assert.equal(circularDecision.request.inputSummary, "[unserializable input]");
});
