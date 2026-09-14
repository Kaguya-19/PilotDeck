import assert from "node:assert/strict";
import test from "node:test";

import { executeChannelCommand } from "../../src/adapters/channel/protocol/ChannelCommandRegistry.js";
import type { Gateway } from "../../src/gateway/index.js";
import type { SessionSearchInput, SessionSearchPort } from "../../src/session/search/SessionSearchPort.js";

test("channel search command consumes the injected search port", async () => {
  const seen: SessionSearchInput[] = [];
  const replies: string[] = [];
  const sessionSearch: SessionSearchPort = {
    async search(input) {
      seen.push(input);
      return { query: input.query, matches: [], truncated: false, sessionsScanned: 3 };
    },
  };

  const handled = await executeChannelCommand("/search incident --limit 4 --role user", {
    gateway: {} as Gateway,
    chatId: "chat-1",
    channelKey: "test",
    getProject: () => "/workspace/project-a",
    pilotHome: "/pilot-home",
    sessionSearch,
    reply: async (text) => { replies.push(text); },
  });

  assert.equal(handled, true);
  assert.deepEqual(seen, [{
    pilotHome: "/pilot-home",
    projectRoot: "/workspace/project-a",
    query: "incident",
    limit: 4,
    regex: false,
    caseSensitive: false,
    role: "user",
    sessionId: undefined,
  }]);
  assert.match(replies[0] ?? "", /已扫描 3 个会话/);
});

test("channel search command fails clearly when the application omitted the capability", async () => {
  const replies: string[] = [];
  const handled = await executeChannelCommand("/search incident", {
    gateway: {} as Gateway,
    chatId: "chat-1",
    channelKey: "test",
    reply: async (text) => { replies.push(text); },
  });

  assert.equal(handled, true);
  assert.deepEqual(replies, ["聊天记录搜索当前不可用。"]);
});
