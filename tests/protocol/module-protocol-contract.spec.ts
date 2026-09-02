import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("Module Protocol v2 schema and SOP are shipped together", () => {
  const schemaPath = path.join(root, "docs", "pilotdeck-module-protocol-v2.schema.json");
  const sopPath = path.join(root, "docs", "pilotdeck-module-communication-sop.zh.md");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    $id?: string;
    $defs?: Record<string, { required?: string[] }>;
  };
  const sop = fs.readFileSync(sopPath, "utf8");
  assert.equal(schema.$id, "https://pilotdeck.dev/schema/module-protocol-2.0.json");
  assert.deepEqual(schema.$defs?.executeRequest?.required, ["kind", "messageId", "method", "runId", "operationId", "requestId", "payload"]);
  assert.deepEqual(schema.$defs?.moduleCallRequest?.required, ["kind", "messageId", "method", "runId", "operationId", "requestId", "module", "payload"]);
  assert.equal(schema.$defs?.event?.required?.includes("attemptId"), false);
  assert.match(sop, /Module Protocol v2\.0/);
  assert.match(sop, /流事件按 `\(streamId, sequence\)` 去重/);
});
