import assert from "node:assert/strict";
import test from "node:test";

import { createMissingToolResult, ensureToolResultPairing } from "../../../src/agent/loop/ensureToolResultPairing.js";
import { SUBAGENT_DEFINITIONS, buildSubagentSystemPrompt, getSubagentDefinition, listSubagentDefinitionIds } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { filterIncompleteToolCalls } from "../../../src/agent/sub/filterIncompleteToolCalls.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

test("subagent definitions expose stable ids, prompt boundaries and read-only policies", () => {
  assert.deepEqual(listSubagentDefinitionIds(), ["general-purpose", "explore", "plan", "verify"]);
  for (const id of listSubagentDefinitionIds()) {
    const definition = getSubagentDefinition(id);
    assert.equal(definition, SUBAGENT_DEFINITIONS[id]);
    assert.match(buildSubagentSystemPrompt(definition!), /Scope:/);
    assert.ok(definition!.systemPromptSuffix.length > 0);
  }
  assert.equal(getSubagentDefinition("missing"), undefined);
  assert.equal(SUBAGENT_DEFINITIONS.explore.isReadOnly, true);
  assert.deepEqual(SUBAGENT_DEFINITIONS.plan.allowedTools, ["read_file", "grep", "glob"]);
});

test("filterIncompleteToolCalls keeps paired calls and removes empty assistant messages", () => {
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [
      { type: "text", text: "before" },
      { type: "tool_call", id: "done", name: "read_file", input: {} },
      { type: "tool_call", id: "missing", name: "bash", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result_reference", toolCallId: "done", path: "/tmp/result", originalBytes: 1, preview: "ok", hasMore: false }] },
    { role: "assistant", content: [{ type: "tool_call", id: "only-missing", name: "grep", input: {} }] },
  ];
  assert.deepEqual(filterIncompleteToolCalls(messages), [
    { role: "assistant", content: [
      { type: "text", text: "before" },
      { type: "tool_call", id: "done", name: "read_file", input: {} },
    ] },
    messages[1],
  ]);
});

test("ensureToolResultPairing handles empty and default recovery paths", () => {
  assert.deepEqual(ensureToolResultPairing([], []), []);
  const call = { id: "call-default", name: "read_file", input: {} };
  const result = createMissingToolResult(call);
  assert.equal(result.error.code, "tool_execution_failed");
  assert.equal(result.toolCallId, "call-default");
  const paired = ensureToolResultPairing([call], []);
  assert.equal(paired[0]?.type, "error");
});
