import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  HOST_CAPABILITY_MODULE_METHODS,
  HOST_BUDGET_MODULE_METHODS,
  HOST_CONTEXT_MODULE_METHODS,
  HOST_EVENT_MODULE_METHODS,
  HOST_LIFECYCLE_MODULE_METHODS,
  HOST_MODEL_MODULE_METHODS,
  HOST_PERMISSION_MODULE_METHODS,
  HOST_TURN_MODULE_METHODS,
} from "../../src/agent/modules/protocol.js";

const root = process.cwd();

test("Module Protocol v2 schema and SOP are shipped together", () => {
  const schemaPath = path.join(root, "docs", "pilotdeck-module-protocol-v2.schema.json");
  const sopPath = path.join(root, "docs", "pilotdeck-module-communication-sop.zh.md");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    $id?: string;
    $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  const sop = fs.readFileSync(sopPath, "utf8");
  assert.equal(schema.$id, "https://pilotdeck.dev/schema/module-protocol-2.0.json");
  assert.deepEqual(schema.$defs?.executeRequest?.required, ["kind", "messageId", "method", "runId", "operationId", "requestId", "payload"]);
  assert.deepEqual(schema.$defs?.moduleCallRequest?.required, ["kind", "messageId", "method", "runId", "operationId", "requestId", "module", "payload"]);
  assert.equal(schema.$defs?.event?.required?.includes("attemptId"), false);
  assert.ok(schema.$defs?.hostModules);
  assert.ok(schema.$defs?.interactionCapabilities);
  assert.match(JSON.stringify(schema.$defs?.moduleCallRequest), /context/);
  assert.match(JSON.stringify(schema.$defs?.moduleCallRequest), /budget/);
  assert.match(JSON.stringify(schema.$defs?.moduleCallRequest), /turn/);
  assert.ok(schema.$defs?.moduleCallRequest?.properties?.idempotencyKey);
  assert.ok(schema.$defs?.event?.properties?.code);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /permission/);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /decide/);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /lifecycle/);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /dispatch/);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /"event"/);
  assert.match(JSON.stringify(schema.$defs?.hostModules), /emit/);
  assert.deepEqual(hostModuleMethodEnum(schema, "context"), HOST_CONTEXT_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "model"), HOST_MODEL_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "budget"), HOST_BUDGET_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "turn"), HOST_TURN_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "capability"), HOST_CAPABILITY_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "permission"), HOST_PERMISSION_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "lifecycle"), HOST_LIFECYCLE_MODULE_METHODS);
  assert.deepEqual(hostModuleMethodEnum(schema, "event"), HOST_EVENT_MODULE_METHODS);
  assert.match(sop, /Module Protocol v2\.0/);
  assert.match(sop, /流事件按 `\(streamId, sequence\)` 去重/);
  assert.match(sop, /execute_batch/);
  assert.match(sop, /lifecycle\.dispatch/);
});

function hostModuleMethodEnum(
  schema: { $defs?: Record<string, unknown> },
  module: "model" | "budget" | "turn" | "context" | "capability" | "permission" | "lifecycle" | "event",
): string[] | undefined {
  const hostModules = schema.$defs?.hostModules as {
    properties?: Record<string, { properties?: Record<string, { items?: { enum?: string[] } }> }>;
  } | undefined;
  return hostModules?.properties?.[module]?.properties?.methods?.items?.enum;
}
