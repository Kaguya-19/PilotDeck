import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpModuleClient } from "../../src/composition/HttpModuleClient.js";
import { createKnowledgeQueryTool } from "../../src/composition/domainPorts.js";
import type { ExternalModuleBinding } from "../../src/composition/types.js";

const binding = (endpoint: string): ExternalModuleBinding => ({
  enabled: true, implementationId: "staffdeck.knowledge", contract: "staffdeck.knowledge/v1",
  transport: "module-http-v2", endpoint,
  manifestPath: "/api/v1/knowledge-module/module-manifest",
  callPath: "/api/v1/agents/target/knowledge-module/v2/module/call",
  credentialEnv: "TEST_SD_KNOWLEDGE_READ_KEY", methods: ["query"], agentId: "target",
});

test("normal module transport sends account credential server-side and no caller actor", async t => {
  const calls: Array<{ authorization: string | undefined; input: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ protocolVersion: "2.0", implementationId: "staffdeck.knowledge",
        contract: "staffdeck.knowledge/v1", transport: "module-http-v2", methods: ["query"] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messageId: string; requestId: string; payload: { input: Record<string, unknown> } };
    calls.push({ authorization: request.headers.authorization, input: body.payload.input });
    response.end(JSON.stringify({ kind: "response", messageId: "response", inReplyTo: body.messageId,
      requestId: body.requestId, ok: true, payload: { result: { chunks: [{ id: "source" }] } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  const scope = binding(`http://127.0.0.1:${address.port}`);
  process.env.TEST_SD_KNOWLEDGE_READ_KEY = "account-public-key";
  t.after(() => { delete process.env.TEST_SD_KNOWLEDGE_READ_KEY; });
  const client = new HttpModuleClient(scope);
  const response = await client.call({ runId: "r", operationId: "o", requestId: "req",
    module: "knowledge", payload: { operation: "query", input: { query: "unique" } } });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ authorization: "Bearer account-public-key", input: { query: "unique" } }]);
  delete process.env.TEST_SD_KNOWLEDGE_READ_KEY;
  await assert.rejects(client.call({ runId: "r", operationId: "o", requestId: "second",
    module: "knowledge", payload: { operation: "query", input: { query: "unique" } } }),
    /account credential is not configured/);
  assert.equal(calls.length, 1);
  const tool = createKnowledgeQueryTool({ call: async (_operation, input) => {
    assert.deepEqual(input, { query: "unique" });
    return { chunks: [] };
  } }, scope);
  await tool.execute({ query: "unique" } as never, {} as never);
  await assert.rejects(tool.execute({ query: "unique", actorUserId: "forged" } as never, {} as never),
    /cannot supply identity/);
});
