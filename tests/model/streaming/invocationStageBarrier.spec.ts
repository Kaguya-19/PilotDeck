import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import type { ProviderConfig } from "../../../src/model/protocol/canonical.js";
import type { GoogleClientFactory } from "../../../src/model/providers/google/client.js";
import { complete, streamModel } from "../../../src/model/streaming/streamModel.js";
import {
  JsonlInvocationLogSink,
  type InvocationLogRecord,
  type ModelInvocationLogSink,
} from "../../../src/storage/legalDataStorage.js";

const config = parseModelConfig({
  providers: {
    test: {
      protocol: "openai",
      url: "https://example.test/v1",
      apiKey: "test-key",
      retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
      models: { "test-model": {} },
    },
  },
});

const request: CanonicalModelRequest = {
  provider: "test",
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const googleConfig = parseModelConfig({
  providers: {
    google: {
      protocol: "google",
      url: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "test-key",
      retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
      models: { "test-model": {} },
    },
  },
});

const googleRequest: CanonicalModelRequest = {
  ...request,
  provider: "google",
};

function assertRequestWasStaged(root: string, body: BodyInit | null | undefined): void {
  const pendingDir = join(root, "workspaces", "workspace", "sessions", "session", "llm", ".pending");
  const pendingFiles = readdirSync(pendingDir);
  assert.equal(pendingFiles.length, 1);
  const staged = JSON.parse(readFileSync(join(pendingDir, pendingFiles[0]!), "utf8")) as {
    requestBody: string;
  };
  assert.equal(staged.requestBody, String(body));
}

function splitUtf8Response(payload: string, character: string): Response {
  const bytes = Buffer.from(payload, "utf8");
  const characterBytes = Buffer.from(character, "utf8");
  const characterOffset = bytes.indexOf(characterBytes);
  assert.notEqual(characterOffset, -1);
  const splitOffset = characterOffset + characterBytes.byteLength - 1;

  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, splitOffset));
      controller.enqueue(bytes.subarray(splitOffset));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function captureInvocationRecords(): {
  records: InvocationLogRecord[];
  sink: ModelInvocationLogSink;
} {
  const records: InvocationLogRecord[] = [];
  return {
    records,
    sink: {
      stage: () => {},
      append: async (record) => { records.push(record); },
    },
  };
}

function invocationContext() {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    runId: "turn",
    logicalCallId: "call",
    caller: "agent" as const,
  };
}

async function waitForPersistedInvocation(
  root: string,
  sessionId: string,
): Promise<{ line: string; record: InvocationLogRecord }> {
  const path = join(root, "workspaces", "workspace", "sessions", sessionId, "llm", "invocations.jsonl");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = await readFile(path, "utf8");
      const line = content.split("\n").find(Boolean);
      if (line) {
        return { line, record: JSON.parse(line) as InvocationLogRecord };
      }
    } catch {
      // Invocation persistence is asynchronous; retry until the file is visible.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for invocation log: ${path}`);
}

test("complete synchronously stages the invocation before sending HTTP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-stage-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  await complete(request, config, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: new JsonlInvocationLogSink({ root }),
    },
    fetch: async (_input, init) => {
      fetchCalls++;
      assertRequestWasStaged(root, init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), { status: 200 });
    },
  });

  assert.equal(fetchCalls, 1);
});

test("streamModel synchronously stages the invocation before sending HTTP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-stage-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fetchCalls = 0;
  const stream = streamModel(request, config, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: new JsonlInvocationLogSink({ root }),
    },
    fetch: async (_input, init) => {
      fetchCalls++;
      assertRequestWasStaged(root, init?.body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const iterator = stream[Symbol.asyncIterator]();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.value?.type, "request_started");
  await iterator.next();
  while (!(await iterator.next()).done) {
    // Drain the stream so the invocation is finalized.
  }
  assert.equal(fetchCalls, 1);
});

test("streamModel preserves UTF-8 response bytes split across chunks", async () => {
  const payload = 'data: {"choices":[{"delta":{"content":"中"}}]}\n\ndata: [DONE]\n\n';
  const { records, sink } = captureInvocationRecords();
  const events = [];

  for await (const event of streamModel(request, config, {
    invocation: { context: invocationContext(), sink },
    fetch: async () => splitUtf8Response(payload, "中"),
  })) {
    events.push(event);
  }

  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "中"), true);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.responseBody, payload);
  assert.equal(records[0]?.responseBody?.includes("\uFFFD"), false);
  assert.equal(records[0]?.responseBytes, Buffer.byteLength(payload));
  assert.equal(records[0]?.outcome, "success");
  assert.equal(records[0]?.responseComplete, true);
});

test("streamModel preserves completed UTF-8 characters in an interrupted response", async () => {
  const payload = 'data: {"choices":[{"delta":{"content":"中"}}]}\n\n';
  const { records, sink } = captureInvocationRecords();

  for await (const _event of streamModel(request, config, {
    invocation: { context: invocationContext(), sink },
    fetch: async () => splitUtf8Response(payload, "中"),
  })) {
    // Drain the incomplete stream so the invocation is finalized.
  }

  assert.equal(records.length, 1);
  assert.equal(records[0]?.responseBody, payload);
  assert.equal(records[0]?.responseBody?.includes("\uFFFD"), false);
  assert.equal(records[0]?.responseBytes, Buffer.byteLength(payload));
  assert.equal(records[0]?.outcome, "incomplete");
  assert.equal(records[0]?.responseComplete, false);
});

test("JsonlInvocationLogSink round-trips split UTF-8 and provider unicode escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-utf8-jsonl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sink = new JsonlInvocationLogSink({ root });
  const cases = [
    {
      sessionId: "literal-utf8",
      payload: 'data: {"choices":[{"delta":{"content":"中"}}]}\n\ndata: [DONE]\n\n',
      splitMarker: "中",
      serializedMarker: "中",
    },
    {
      sessionId: "provider-unicode-escape",
      payload: 'data: {"choices":[{"delta":{"content":"\\u4e2d"}}]}\n\ndata: [DONE]\n\n',
      splitMarker: "\\u4e2d",
      serializedMarker: "\\\\u4e2d",
    },
  ];

  for (const item of cases) {
    for await (const _event of streamModel(request, config, {
      invocation: {
        context: { ...invocationContext(), sessionId: item.sessionId },
        sink,
      },
      fetch: async () => splitUtf8Response(item.payload, item.splitMarker),
    })) {
      // Drain the stream so the invocation is persisted.
    }

    const { line, record } = await waitForPersistedInvocation(root, item.sessionId);
    assert.equal(line.includes(item.serializedMarker), true);
    assert.equal(record.responseBody, item.payload);
    assert.equal(Buffer.from(record.responseBody ?? "").equals(Buffer.from(item.payload)), true);
    assert.equal(record.responseBody?.includes("\uFFFD"), false);
    assert.equal(record.responseBytes, Buffer.byteLength(item.payload));
  }
});

test("does not send HTTP when synchronous invocation staging fails", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    complete(request, config, {
      invocation: {
        context: {
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          runId: "turn",
          logicalCallId: "call",
          caller: "agent",
        },
        sink: {
          stage: () => { throw new Error("storage unavailable"); },
          append: async () => {},
        },
      },
      fetch: async () => {
        fetchCalls++;
        throw new Error("HTTP must not be sent");
      },
    }),
    /storage unavailable/,
  );
  assert.equal(fetchCalls, 0);
});

test("Google complete stages synchronously before invoking the SDK", async () => {
  const order: string[] = [];
  const googleClientFactory: GoogleClientFactory = (_provider: ProviderConfig) => ({
    models: {
      generateContent: async () => {
        order.push("sdk");
        return { candidates: [{ content: { parts: [{ text: "ok" }] } }] } as never;
      },
      generateContentStream: async () => (async function* () {})(),
    },
  });

  await complete(googleRequest, googleConfig, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: {
        stage: () => { order.push("stage"); },
        append: async () => {},
      },
    },
    googleClientFactory,
  });

  assert.deepEqual(order, ["stage", "sdk"]);
});

test("Google streaming stages synchronously before invoking the SDK", async () => {
  const order: string[] = [];
  const googleClientFactory: GoogleClientFactory = (_provider: ProviderConfig) => ({
    models: {
      generateContent: async () => ({} as never),
      generateContentStream: async () => {
        order.push("sdk");
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "ok" }] } }] } as never;
          yield { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } as never;
        })();
      },
    },
  });

  const iterator = streamModel(googleRequest, googleConfig, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: {
        stage: () => { order.push("stage"); },
        append: async () => {},
      },
    },
    googleClientFactory,
  })[Symbol.asyncIterator]();

  while (!(await iterator.next()).done) {
    // Drain the SDK stream.
  }
  assert.deepEqual(order, ["stage", "sdk"]);
});
