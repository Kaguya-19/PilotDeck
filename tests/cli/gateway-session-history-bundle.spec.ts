import assert from "node:assert/strict";
import test from "node:test";

import { GatewaySessionHistoryBundle } from "../../src/cli/GatewaySessionHistoryBundle.js";
import type { SessionCatalogPort } from "../../src/session/catalog/SessionCatalogPort.js";
import type { ProjectSessionStorageProvider } from "../../src/session/storage/ProjectSessionStorageProvider.js";
import type {
  GatewayRecordAgentStatusMessageInput,
  WebFinalizeLastTurnReplacementResult,
  WebForkSessionResult,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesResult,
  WebReplaceLastTurnResult,
} from "../../src/gateway/protocol/types.js";

test("gateway session history bundle maps Gateway requests onto the existing session data-plane owners", async () => {
  const calls: string[] = [];
  const statusWrites: GatewayRecordAgentStatusMessageInput[] = [];
  const storageProvider = {} as ProjectSessionStorageProvider;
  let statusStorageProvider: ProjectSessionStorageProvider | undefined;
  let statusStorageDisposals = 0;
  const sessionCatalog: SessionCatalogPort = { async list() { return []; } };
  const bundle = new GatewaySessionHistoryBundle({
    fallbackProjectRoot: "/fallback",
    pilotHome: "/pilot-home",
    sessionCatalog,
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    maxContextTokens: 16_000,
    maxOutputTokens: 2_000,
    transactionOwner: { instanceId: "gateway", pid: 42 },
    storageProvider,
    providers: {
      readSessionMessages: async (_input, options) => {
        assert.equal(options.sessionCatalog, sessionCatalog);
        assert.equal(options.storageProvider, storageProvider);
        calls.push(`read:${options.projectRoot}:${options.maxContextTokens}:${options.maxOutputTokens}`);
        return { messages: [], total: 0, session: { sessionId: "s", sessionKey: "s", summary: "s", lastModified: 0 } } as WebReadSessionMessagesResult;
      },
      readSubagentMessages: async (_input, options) => {
        assert.equal(options.sessionCatalog, sessionCatalog);
        assert.equal(options.storageProvider, storageProvider);
        calls.push(`subagent:${options.projectRoot}`);
        return { messages: [], total: 0 } as WebReadSubagentMessagesResult;
      },
      forkSession: async (_input, options) => {
        assert.equal(options.storageProvider, storageProvider);
        calls.push(`fork:${options.projectRoot}`);
        return { newSessionKey: "fork", prefillText: "", carriedMessageCount: 0 } as WebForkSessionResult;
      },
      replaceLastTurn: async (_input, options) => {
        assert.equal(options.storageProvider, storageProvider);
        calls.push(`replace:${options.projectRoot}:${options.transactionOwner?.instanceId}`);
        return { sessionKey: "s", replacedTurnId: "turn", removedEntryCount: 1, transactionId: "tx" } as WebReplaceLastTurnResult;
      },
      finalizeLastTurnReplacement: async (_input, options) => {
        assert.equal(options.storageProvider, storageProvider);
        calls.push(`finalize:${options.projectRoot}`);
        return { sessionKey: "s", transactionId: "tx", action: "commit" } as WebFinalizeLastTurnReplacementResult;
      },
      createStorage: (input) => {
        statusStorageProvider = input.storageProvider;
        return {
          transcript: {
            recordAgentStatusMessage: async (sessionKey, turnId, status) => {
              calls.push(`status:${input.projectRoot}`);
              statusWrites.push({ sessionKey, turnId, status });
            },
          },
          restore: async () => {
            calls.push(`restore:${input.projectRoot}`);
            return { entries: [], diagnostics: [] };
          },
          dispose: async () => {
            statusStorageDisposals += 1;
          },
        };
      },
    },
  });

  await bundle.readSessionMessages({ sessionKey: "s" });
  await bundle.readSubagentMessages({ sessionKey: "child", subagentId: "child" });
  await bundle.forkSession({ projectKey: "/project", sessionKey: "s", fromEntryId: "entry" });
  await bundle.replaceLastTurn({ projectKey: "/project", sessionKey: "s", expectedTurnId: "turn", replacementTurnId: "new" });
  await bundle.finalizeLastTurnReplacement({ projectKey: "/project", sessionKey: "s", transactionId: "tx", action: "commit" });
  const status = { event: "working", kind: "status" as const, text: "Working" };
  await bundle.recordAgentStatusMessage({ projectKey: "/project", sessionKey: "s", turnId: "turn", status });

  assert.deepEqual(calls, [
    "read:/fallback:16000:2000",
    "subagent:/fallback",
    "fork:/project",
    "replace:/project:gateway",
    "finalize:/project",
    "restore:/project",
    "status:/project",
  ]);
  assert.deepEqual(statusWrites, [{ sessionKey: "s", turnId: "turn", status }]);
  assert.equal(statusStorageProvider, storageProvider);
  assert.equal(statusStorageDisposals, 1);
});
