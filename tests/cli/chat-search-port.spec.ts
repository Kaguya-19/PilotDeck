import assert from "node:assert/strict";
import test from "node:test";

import { runChatSearch, runChatSearchFormatted } from "../../src/cli/commands/chatSearch.js";
import type { SessionSearchInput, SessionSearchPort } from "../../src/session/search/SessionSearchPort.js";

function createSearchPort(seen: SessionSearchInput[]): SessionSearchPort {
  return {
    async search(input) {
      seen.push(input);
      return {
        query: input.query,
        matches: [{
          sessionId: "session-123456789",
          sessionTitle: "Search result",
          role: "assistant",
          text: "needle result",
          snippet: "needle result",
          createdAt: "2026-09-10T00:00:00.000Z",
          lineNumber: 3,
        }],
        truncated: false,
        sessionsScanned: 2,
      };
    },
  };
}

test("runChatSearch maps shared command syntax onto its injected search port", async () => {
  const seen: SessionSearchInput[] = [];
  const result = await runChatSearch({
    sessionSearch: createSearchPort(seen),
    pilotHome: "/pilot-home",
    projectRoot: "/project-root",
    arg: "needle --all --limit 7 --regex --case-sensitive --role assistant --session s-1",
  });

  assert.equal(result.query, "needle");
  assert.deepEqual(seen, [{
    pilotHome: "/pilot-home",
    projectRoot: undefined,
    query: "needle",
    limit: 7,
    regex: true,
    caseSensitive: true,
    role: "assistant",
    sessionId: "s-1",
  }]);
});

test("runChatSearchFormatted keeps formatting separate from the provider", async () => {
  const seen: SessionSearchInput[] = [];
  const { text } = await runChatSearchFormatted({
    sessionSearch: createSearchPort(seen),
    pilotHome: "/pilot-home",
    projectRoot: "/project-root",
    arg: "needle",
    locale: "en",
  });

  assert.match(text, /Search result/);
  assert.equal(seen[0]?.projectRoot, "/project-root");
});
