import assert from "node:assert/strict";
import test from "node:test";

import { CRON_SCHEDULE_SCHEMA } from "../../../src/cron/tool/CronSchemas.js";
import { buildModelRequest } from "../../../src/model/index.js";
import type {
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "../../../src/model/index.js";
import { normalizeOpenAISchema } from "../../../src/model/providers/openai/schema.js";

test("openai schema normalization adds explicit types to cron literal variants", () => {
  const normalized = normalizeOpenAISchema({
    type: "object",
    required: ["schedule"],
    additionalProperties: false,
    properties: {
      schedule: CRON_SCHEDULE_SCHEMA,
    },
  });

  const properties = normalized.properties as Record<string, Record<string, unknown>>;
  const schedule = properties.schedule;
  const variants = schedule.anyOf as Array<Record<string, unknown>>;

  const onceProperties = variants[0]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(onceProperties.type.type, "string");
  assert.equal(onceProperties.type.const, "once");

  const cronProperties = variants[1]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(cronProperties.type.type, "string");
  assert.equal(cronProperties.type.const, "cron");

  const delayProperties = variants[2]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(delayProperties.type.type, "string");
  assert.equal(delayProperties.type.const, "delay");
  assert.equal(delayProperties.unit.type, "string");
  assert.deepEqual(delayProperties.unit.enum, ["second", "minute", "hour", "day"]);
});

test("openai schema normalization preserves array item fallback", () => {
  const normalized = normalizeOpenAISchema({
    type: "object",
    additionalProperties: false,
    properties: {
      value: {
        type: ["string", "array"],
      },
    },
  });

  const properties = normalized.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.value.items, {});
});

test("openai response_format schemas get literal types normalized", () => {
  const body = buildModelRequest(outputSchemaRequest("openai"), modelConfig("openai")) as {
    response_format?: { json_schema: { schema: Record<string, unknown> } };
  };

  const schema = body.response_format?.json_schema.schema;
  assert.ok(schema);
  assertLiteralTypes(schema);
});

test("openai responses output schemas get literal types normalized", () => {
  const body = buildModelRequest(outputSchemaRequest("openai-responses"), modelConfig("openai-responses")) as {
    text?: { format: { schema: Record<string, unknown> } };
  };

  const schema = body.text?.format.schema;
  assert.ok(schema);
  assertLiteralTypes(schema);
});

function outputSchemaRequest(provider: string): CanonicalModelRequest {
  return {
    provider,
    model: "test-model",
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    outputSchema: {
      name: "result",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "kind"],
        properties: {
          status: { enum: ["ok", "failed"] },
          kind: { const: "report" },
        },
      },
    },
  };
}

function assertLiteralTypes(schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.status.type, "string");
  assert.deepEqual(properties.status.enum, ["ok", "failed"]);
  assert.equal(properties.kind.type, "string");
  assert.equal(properties.kind.const, "report");
}

function modelConfig(protocol: ModelProtocol): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const models: Record<string, ModelDefinition> = {
    "test-model": {
      id: "test-model",
      capabilities,
      multimodal: { input: ["text"] },
    },
  };
  const provider: ProviderConfig = {
    id: protocol,
    protocol,
    url: "https://example.invalid/v1",
    apiKey: "test",
    headers: {},
    models,
  };
  return { providers: { [protocol]: provider } };
}
