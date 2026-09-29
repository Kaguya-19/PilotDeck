import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { createNodeExecutionWorkspacePort } from "../../src/tool/execution-world/NodeExecutionWorkspacePort.js";

test("native execution workspace writes only below its private root and cleans up idempotently", async () => {
  const workspace = await createNodeExecutionWorkspacePort().create({ prefix: "pilotdeck-workspace-port-" });
  try {
    const scriptPath = await workspace.writeText("script.py", "print('ok')\n");
    assert.equal(scriptPath, join(workspace.root, "script.py"));
    assert.equal(await readFile(scriptPath, "utf8"), "print('ok')\n");
    await assert.rejects(workspace.writeText("../escape.py", "bad"), /escapes its root/);
  } finally {
    await workspace.cleanup();
  }

  await assert.rejects(access(workspace.root));
  await workspace.cleanup();
});
