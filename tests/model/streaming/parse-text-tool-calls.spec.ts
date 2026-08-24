import assert from "node:assert/strict";
import test from "node:test";

import { extractTextToolCalls, hasTextToolCallSyntax } from "../../../src/model/streaming/parseTextToolCalls.js";

test("extractTextToolCalls parses Hermes, Mistral and Llama formats", () => {
  const hermes = extractTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>');
  assert.equal(hermes.toolCalls[0]?.name, "read_file");
  assert.deepEqual(hermes.toolCalls[0]?.input, { path: "a" });
  assert.equal(hermes.detectedFormat, "hermes_json");

  const mistral = extractTextToolCalls('[TOOL_CALLS][{"name":"grep","arguments":{"pattern":"x"}}]');
  assert.equal(mistral.toolCalls[0]?.name, "grep");

  const llama = extractTextToolCalls('<|python_tag|>{"name":"glob","arguments":{"pattern":"*.ts"}}');
  assert.equal(llama.toolCalls[0]?.name, "glob");
});

test("extractTextToolCalls reports partial and malformed marked calls", () => {
  const partial = extractTextToolCalls("<tool_call>\n{not json}\n</tool_call>");
  assert.deepEqual(partial.toolCalls, []);
  assert.equal(partial.parseError, true);
  assert.equal(partial.partialToolCall?.format, "hermes_json");
  assert.equal(hasTextToolCallSyntax("<function=read_file>"), true);
  assert.equal(hasTextToolCallSyntax("plain answer"), false);
});

test("extractTextToolCalls covers DeepSeek DSML, Qwen fragments and trailing text", () => {
  const dsml = extractTextToolCalls(
    '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.txt</content></｜DSML｜invoke>\n</｜DSML｜tool_calls>',
  );
  assert.equal(dsml.toolCalls[0]?.name, "read_file");
  assert.deepEqual(dsml.toolCalls[0]?.input, { path: "a.txt" });
  assert.equal(dsml.detectedFormat, "deepseek_dsml");

  const qwen = extractTextToolCalls("answer\n<function=read_file><parameter=path>a.txt</parameter></function>\nBash/foo");
  assert.equal(qwen.toolCalls[0]?.name, "read_file");
  assert.equal(qwen.partialToolCall?.reason, "loose_tool_command_fragment_after_tool_xml");
  assert.match(qwen.remainingText, /answer/);
});

test("extractTextToolCalls distinguishes incomplete markers and malformed payloads", () => {
  const cases = [
    ["<function=read_file>", "qwen_xml"],
    ["<｜DSML｜tool_calls>", "deepseek_dsml"],
    ["[TOOL_CALLS]", "mistral"],
    ["<|python_tag|>", "llama"],
    ["</tool_call>", "hermes_json"],
  ] as const;
  for (const [text, format] of cases) {
    const result = extractTextToolCalls(text);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.partialToolCall?.format, format);
    assert.equal(result.parseError, true);
  }
  const invalidMistral = extractTextToolCalls("[TOOL_CALLS]{\"not\":\"array\"}");
  assert.equal(invalidMistral.partialToolCall?.reason, "tool_calls_marker_without_json_array");
  const invalidLlama = extractTextToolCalls("<|python_tag|>{not-json}");
  assert.equal(invalidLlama.partialToolCall?.reason, "invalid_json_after_python_tag");
});
