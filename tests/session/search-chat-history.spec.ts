import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { formatChatHistorySearchResults } from "../../src/session/search/formatChatHistorySearch.js";
import {
  parseChatSearchArgs,
  searchChatHistory,
} from "../../src/session/search/searchChatHistory.js";

const createdAt = "2026-08-20T12:00:00.000Z";

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify({ sequence: 1, createdAt, ...entry })}\n`;
}

async function writeSession(
  pilotHome: string,
  projectRoot: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, `${sessionId}.jsonl`), content, "utf8");
}

test("parseChatSearchArgs parses aliases, bounds and preserves query text", () => {
  assert.deepEqual(parseChatSearchArgs("--all -E --case-sensitive -n 999 -r assistant -s web:s1 deploy docker"), {
    query: "deploy docker",
    allProjects: true,
    limit: 100,
    regex: true,
    caseSensitive: true,
    role: "assistant",
    sessionId: "web:s1",
  });
  assert.deepEqual(parseChatSearchArgs("-n invalid --role unknown --session"), {
    query: "invalid unknown",
    allProjects: false,
    limit: undefined,
    regex: false,
    caseSensitive: false,
    role: undefined,
    sessionId: undefined,
  });
});

test("searchChatHistory filters roles, supports regex and skips malformed/internal entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-search-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const pilotHome = join(root, "home");
  const session = "web:search-session";
  await writeSession(
    pilotHome,
    project,
    session,
    line({
      type: "session_metadata",
      sessionId: session,
      metadata: { title: "Deploy session" },
    })
      + line({
        type: "accepted_input",
        sessionId: session,
        messages: [{ role: "user", content: [{ type: "text", text: "Deploy the API" }] }],
      })
      + line({
        type: "assistant_message",
        sessionId: session,
        message: { role: "assistant", content: [{ type: "text", text: "Deployment complete" }] },
      })
      + "not-json\n"
      + line({ type: "control_boundary", sessionId: session }),
  );
  await writeSession(
    pilotHome,
    project,
    "always-on-discovery:internal",
    line({
      type: "assistant_message",
      sessionId: "always-on-discovery:internal",
      message: { role: "assistant", content: [{ type: "text", text: "Deploy hidden" }] },
    }),
  );

  const userOnly = await searchChatHistory({
    pilotHome,
    projectRoot: project,
    query: "deploy",
    role: "user",
  });
  assert.equal(userOnly.matches.length, 1);
  assert.equal(userOnly.matches[0]?.text, "Deploy the API");
  assert.equal(userOnly.matches[0]?.sessionTitle, "Deploy session");

  const assistantRegex = await searchChatHistory({
    pilotHome,
    projectRoot: project,
    query: "^deployment",
    regex: true,
    role: "assistant",
  });
  assert.equal(assistantRegex.matches.length, 1);
  assert.match(assistantRegex.matches[0]?.snippet ?? "", /Deployment/);

  const hidden = await searchChatHistory({ pilotHome, projectRoot: project, query: "hidden" });
  assert.equal(hidden.matches.length, 0);
  const included = await searchChatHistory({
    pilotHome,
    projectRoot: project,
    query: "hidden",
    includeInternal: true,
  });
  assert.equal(included.matches.length, 1);
});

test("searchChatHistory searches all projects, filters by session and reports truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-search-all-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  await writeSession(
    pilotHome,
    first,
    "web:first",
    line({ type: "accepted_input", sessionId: "web:first", messages: [{ role: "user", content: [{ type: "text", text: "same needle" }] }] }),
  );
  await writeSession(
    pilotHome,
    second,
    "web:second",
    line({ type: "accepted_input", sessionId: "web:second", messages: [{ role: "user", content: [{ type: "text", text: "same needle" }] }] }),
  );

  const all = await searchChatHistory({ pilotHome, query: "needle", limit: 1 });
  assert.equal(all.sessionsScanned, 2);
  assert.equal(all.matches.length, 1);
  assert.equal(all.truncated, true);

  const selected = await searchChatHistory({
    pilotHome,
    projectRoot: first,
    sessionId: "web:first",
    query: "needle",
    caseSensitive: true,
  });
  assert.equal(selected.matches.length, 1);
  assert.equal(selected.matches[0]?.sessionId, "web:first");

  const empty = await searchChatHistory({ pilotHome, query: "   " });
  assert.deepEqual(empty, { query: "", matches: [], truncated: false, sessionsScanned: 0 });
  const missing = await searchChatHistory({ pilotHome: join(root, "missing"), query: "needle" });
  assert.deepEqual(missing.matches, []);
});

test("formatChatHistorySearchResults renders empty, truncated and localized matches", () => {
  assert.match(formatChatHistorySearchResults({ query: "", matches: [], truncated: false, sessionsScanned: 0 }), /用法/);
  assert.match(formatChatHistorySearchResults({ query: "x", matches: [], truncated: false, sessionsScanned: 2 }, { locale: "en" }), /Scanned 2/);
  assert.match(formatChatHistorySearchResults({ query: "x", matches: [], truncated: false, sessionsScanned: 2 }), /已扫描 2 个会话/);
  const output = formatChatHistorySearchResults({
    query: "needle",
    truncated: true,
    sessionsScanned: 1,
    matches: [{
      sessionId: "123456789012345",
      sessionTitle: "Title",
      projectKey: "/tmp/project",
      role: "assistant",
      text: "needle text",
      snippet: "needle text",
      createdAt: "not-a-date",
      lineNumber: 3,
    }, {
      sessionId: "short",
      sessionTitle: "Second",
      role: "user",
      text: "needle",
      snippet: "needle",
      createdAt: "",
      lineNumber: 4,
    }],
  }, { locale: "en", includeProject: true });
  assert.match(output, /2 match\(es\)/);
  assert.match(output, /project/);
  assert.match(output, /unknown time/);
  const chinese = formatChatHistorySearchResults({
    query: "needle",
    truncated: false,
    sessionsScanned: 1,
    matches: [{
      sessionId: "short",
      sessionTitle: "标题",
      role: "user",
      text: "needle",
      snippet: "needle",
      createdAt: "2026-08-20T12:00:00.000Z",
      lineNumber: 1,
    }],
  });
  assert.match(chinese, /找到 1 条匹配/);
  assert.match(chinese, /用户/);
  assert.match(chinese, /提示：/);
});
