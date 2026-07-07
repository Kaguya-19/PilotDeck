import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSubagentSystemPrompt, SUBAGENT_DEFINITIONS } from "../../src/agent/sub/builtinSubagentTypes.js";
import { buildAskModeAgentToolSchema, createAgentTool } from "../../src/tool/builtin/agent.js";

describe("agent tool guidance", () => {
  it("encourages read-only verification subagents for complex deliverables", () => {
    const tool = createAgentTool();

    assert.match(tool.description, /complex or high-risk deliverables/u);
    assert.match(tool.description, /`verify` subagent/u);
    assert.match(tool.description, /outputs, logs, key files, and unresolved errors/u);
    assert.match(tool.description, /should be read-only/u);
  });

  it("includes verification guidance in ask mode schema", () => {
    const schema = buildAskModeAgentToolSchema();

    assert.match(schema.description, /complex or high-risk deliverables/u);
    assert.match(schema.description, /`verify` subagent/u);
    assert.match(schema.description, /unresolved errors/u);
  });

  it("gives the verify subagent a general read-only validation checklist", () => {
    const prompt = buildSubagentSystemPrompt(SUBAGENT_DEFINITIONS.verify);

    assert.match(prompt, /You are read-only/u);
    assert.match(prompt, /Do not continue implementation for the parent/u);
    assert.match(prompt, /intermediate checkpoints/u);
    assert.match(prompt, /required outputs exist/u);
    assert.match(prompt, /unexpected extra artifacts or unsafe side effects/u);
    assert.match(prompt, /If evidence is missing/u);
  });
});
