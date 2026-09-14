import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectSessionRuntimeBundle,
  type ProjectSessionRuntimeBundleOptions,
} from "../../src/cli/ProjectSessionRuntimeBundle.js";

test("project session runtime bundle releases exact leases when plugin refresh prevents composition", async () => {
  const lifecycle: string[] = [];
  const bundle = new ProjectSessionRuntimeBundle({
    context: { sessionKey: "session-failure", projectKey: "/workspace", channelKey: "test" },
    runtime: {
      pluginRuntime: {
        async refresh() {
          lifecycle.push("plugin.refresh");
          throw new Error("plugin refresh failed");
        },
        acquireSessionContributions() {
          throw new Error("must not acquire a contribution snapshot after refresh failure");
        },
      },
    },
    acquireRuntimeLease: () => {
      lifecycle.push("project.acquire");
      return async () => { lifecycle.push("project.release"); };
    },
    acquirePermissionRuleSet: () => {
      lifecycle.push("permission.acquire");
      return {
        rules: { allow: [] },
        release() { lifecycle.push("permission.release"); },
      };
    },
  } as unknown as ProjectSessionRuntimeBundleOptions);

  await assert.rejects(bundle.compose(), /plugin refresh failed/);
  assert.deepEqual(lifecycle, [
    "project.acquire",
    "permission.acquire",
    "plugin.refresh",
    "permission.release",
    "project.release",
  ]);
});
