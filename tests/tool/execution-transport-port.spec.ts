import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createNodeExecutionTransportPort,
  setExecuteCodeTransportOverrideForTests,
} from "../../src/tool/execution-world/ExecutionTransportPort.js";

test("native execution transport owns UDS path cleanup", async () => {
  setExecuteCodeTransportOverrideForTests("uds");
  const provider = createNodeExecutionTransportPort();
  const transport = provider.create();
  try {
    assert.equal(transport.kind, "uds");
    await writeFile(transport.socketPath, "stale socket placeholder");
    await provider.cleanup(transport);
    await assert.rejects(access(transport.socketPath));
  } finally {
    setExecuteCodeTransportOverrideForTests(undefined);
  }
});
