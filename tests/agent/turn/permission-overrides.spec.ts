import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import { applyAgentPermissionOverrides } from "../../../src/agent/turn/permissionOverrides.js";

test("turn permission overrides replace only user-owned rules", () => {
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace",
      rules: {
        allow: [
          { source: "project", behavior: "allow", toolName: "project_read" },
          { source: "user", behavior: "allow", toolName: "old_user_read" },
        ],
        deny: [{ source: "policy", behavior: "deny", toolName: "protected_write" }],
        ask: [{ source: "cli", behavior: "ask", toolName: "shell" }],
      },
    }),
  };

  applyAgentPermissionOverrides(config, {
    permissionRules: {
      allow: [
        { source: "user", behavior: "allow", toolName: "new_user_read" },
        { source: "policy", behavior: "allow", toolName: "forged_policy_rule" },
      ],
      deny: [{ source: "session", behavior: "deny", toolName: "forged_session_rule" }],
    },
  });

  assert.deepEqual(config.permissionContext.rules, {
    allow: [
      { source: "project", behavior: "allow", toolName: "project_read" },
      { source: "user", behavior: "allow", toolName: "new_user_read" },
    ],
    deny: [{ source: "policy", behavior: "deny", toolName: "protected_write" }],
    ask: [{ source: "cli", behavior: "ask", toolName: "shell" }],
  });
});
