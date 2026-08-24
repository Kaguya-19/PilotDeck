import test from "node:test";
import assert from "node:assert/strict";
import { LifecycleRuntime, NullLifecycleRuntime } from "../../src/lifecycle/index.js";
import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import { matchHookMatcher } from "../../src/extension/hooks/config/matchHook.js";
import { matchHookCondition } from "../../src/extension/hooks/config/matchHookCondition.js";
import { parseHookOutput } from "../../src/extension/hooks/execution/parseHookOutput.js";

const baseInput = { sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp" };

test("lifecycle runtime turns callback hook context into model messages", async () => {
  const hooks = new HookRuntime({ PreModelRequest: [{ matcher: "chat", hooks: [{ type: "callback", name: "context" }] }] });
  hooks.getCallbackExecutor().register("context", () => ({ type: "sync", specific: { hookEventName: "PreModelRequest", additionalContext: "use the fixture" } }));
  const runtime = new LifecycleRuntime(hooks);
  const result = await runtime.dispatch({ event: "PreModelRequest", baseInput, matchQuery: "chat" });
  assert.equal(result.blockingErrors.length, 0);
  assert.equal((result.messages[0]?.content[0] as { text?: string })?.text, '<hook_context source="callback">\nuse the fixture\n</hook_context>');
  assert.deepEqual(result.events.map((event) => (event as { type: string }).type), ["started", "response"]);
});

test("lifecycle runtime reports blocking and non-blocking hook outcomes", async () => {
  const hooks = new HookRuntime({
    PreToolUse: [{ hooks: [
      { type: "callback", name: "block" },
      { type: "callback", name: "fail" },
    ] }],
  });
  hooks.getCallbackExecutor().register("block", () => ({ type: "sync", continue: false, reason: "unsafe" }));
  hooks.getCallbackExecutor().register("fail", () => { throw new Error("callback failed"); });
  const result = await new LifecycleRuntime(hooks).dispatch({
    event: "PreToolUse",
    baseInput,
    payload: { toolName: "bash", toolInput: { command: "rm -rf /" } },
  });
  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.nonBlockingErrors.length, 1);
  assert.ok(result.effects.some((effect) => effect.type === "block"));
});

test("NullLifecycleRuntime is an explicit no-op", async () => {
  assert.deepEqual(await new NullLifecycleRuntime().dispatch(), {
    effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
  });
});

test("hook matching supports alternatives, regex and normalized conditions", () => {
  assert.equal(matchHookMatcher("bash|write_file", "write_file"), true);
  assert.equal(matchHookMatcher("/^git-/", "git-status"), true);
  assert.equal(matchHookMatcher("/[/", "x"), false);
  assert.equal(matchHookMatcher("bash", undefined), false);
  assert.equal(matchHookCondition("write-file(rm)", { toolName: "write_file", toolInput: { command: "rm -rf" } }), true);
  assert.equal(matchHookCondition("bash(rm)", { toolName: "bash", toolInput: { command: "echo" } }), false);
  assert.equal(matchHookCondition("bad condition", { toolName: "bash" }), false);
});

test("hook output parser rejects malformed lines and preserves structured fields", () => {
  assert.deepEqual(parseHookOutput("plain output"), { type: "sync" });
  assert.deepEqual(parseHookOutput('{"async":true}'), { type: "async", raw: { async: true } });
  const parsed = parseHookOutput('log\n{"hookSpecificOutput":{"hookEventName":"PreToolUse","watchPaths":["a",1],"permissionDecision":"deny","decision":{"behavior":"deny","message":"no"},"retry":true}}');
  assert.equal(parsed.type, "sync");
  assert.equal(parsed.specific?.permissionDecision, "deny");
  assert.deepEqual(parsed.specific?.watchPaths, ["a"]);
  assert.deepEqual(parsed.specific?.decision, { behavior: "deny", message: "no", interrupt: undefined });
  assert.equal(parsed.specific?.retry, true);
});
