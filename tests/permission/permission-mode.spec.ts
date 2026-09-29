import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  createDefaultPermissionContext,
  isPermissionMode,
} from "../../src/permission/index.js";

test("permission definition owns its mode vocabulary and default context policy", () => {
  assert.deepEqual(PERMISSION_MODES, ["default", "plan", "bypassPermissions"]);
  assert.equal(DEFAULT_PERMISSION_MODE, "default");
  assert.equal(isPermissionMode("plan"), true);
  assert.equal(isPermissionMode("unsupported"), false);
  assert.equal(createDefaultPermissionContext({ cwd: "/workspace" }).mode, DEFAULT_PERMISSION_MODE);
});
