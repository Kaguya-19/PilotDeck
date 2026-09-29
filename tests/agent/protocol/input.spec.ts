import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_MODES,
  parseAgentRunMode,
} from "../../../src/agent/protocol/input.js";

test("agent input definition owns the run-mode vocabulary without choosing a fallback", () => {
  assert.deepEqual(AGENT_RUN_MODES, ["agent", "plan", "ask"]);
  assert.equal(parseAgentRunMode("agent"), "agent");
  assert.equal(parseAgentRunMode("ask"), "ask");
  assert.equal(parseAgentRunMode("unsupported"), undefined);
  assert.equal(parseAgentRunMode(undefined), undefined);
});
