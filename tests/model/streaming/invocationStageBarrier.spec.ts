import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { complete, streamModel } from "../../../src/model/streaming/streamModel.js";
import { JsonlInvocationLogSink } from "../../../src/storage/legalDataStorage.js";

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

function assertRequestWasStaged(root: string, body: BodyInit | null | undefined): void {
  const pendingDir = join(root, "workspaces", "workspace", "sessions", "session", "llm", ".pending");
  const pendingFiles = readdirSync(pendingDir);
  assert.equal(pendingFiles.length, 1);
  const staged = JSON.parse(readFileSync(join(pendingDir, pendingFiles[0]!), "utf8")) as {
    requestBody: string;
  };
  assert.equal(staged.requestBody, String(body));
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
