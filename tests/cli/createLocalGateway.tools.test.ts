import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelSupportsPlanModeTools,
  filterPlanModeToolsForChannel,
} from "../../src/cli/createLocalGateway.js";
import { createBuiltinRegistry } from "../../src/tool/index.js";

test("plan mode tools are hidden from IM channels", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.has("enter_plan_mode"), true);
  assert.equal(registry.has("exit_plan_mode"), true);

  for (const channelKey of ["feishu", "slack", "discord", "telegram", "wecom"]) {
    const filtered = filterPlanModeToolsForChannel(registry, channelKey);
    assert.equal(channelSupportsPlanModeTools(channelKey), false);
    assert.equal(filtered.has("enter_plan_mode"), false);
    assert.equal(filtered.has("exit_plan_mode"), false);
  }

  assert.equal(registry.has("enter_plan_mode"), true);
  assert.equal(registry.has("exit_plan_mode"), true);
});

test("plan mode tools remain available to the web channel", () => {
  const registry = createBuiltinRegistry();
  const filtered = filterPlanModeToolsForChannel(registry, "web");

  assert.equal(channelSupportsPlanModeTools("web"), true);
  assert.equal(filtered.has("enter_plan_mode"), true);
  assert.equal(filtered.has("exit_plan_mode"), true);
});
