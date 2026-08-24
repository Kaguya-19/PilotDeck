import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runChatSearch, runChatSearchFormatted, runChatSearchCli } from "../../src/cli/commands/chatSearch.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";

function transcript(sessionId: string): string {
  const base = { sessionId, turnId: "turn", createdAt: "2026-08-24T00:00:00.000Z" };
  return [
    JSON.stringify({ ...base, sequence: 1, type: "accepted_input", messages: [{ role: "user", content: [{ type: "text", text: "Deploy PilotDeck" }] }] }),
    JSON.stringify({ ...base, sequence: 2, type: "turn_result", result: { type: "success", sessionId, turnId: "turn", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: base.createdAt, completedAt: base.createdAt } }),
  ].join("\n") + "\n";
}

test("chat search command wrappers pass parsed scope and format results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-chat-search-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const chatDir = getPilotProjectChatDir(project, join(root, "home"));
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, "web:session.jsonl"), transcript("web:session"), "utf8");

  const result = await runChatSearch({ pilotHome: join(root, "home"), projectRoot: project, arg: "--role user deploy" });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.role, "user");
  const formatted = await runChatSearchFormatted({ pilotHome: join(root, "home"), projectRoot: project, arg: "deploy", locale: "en" });
  assert.match(formatted.text, /PilotDeck|deploy/i);
});

test("chat search CLI fails clearly for invalid subcommands and empty queries", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    process.exitCode = undefined;
    await runChatSearchCli(["wrong"]);
    assert.equal(process.exitCode, 1);
    assert.match(errors.at(-1) ?? "", /Usage/);
    errors.length = 0;
    process.exitCode = undefined;
    await runChatSearchCli(["search", "--json"]);
    assert.equal(process.exitCode, 1);
    assert.match(errors.at(-1) ?? "", /keyword is required/);
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
});

test("chat search CLI emits JSON through the public command entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-chat-search-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const chatDir = getPilotProjectChatDir(project, join(root, "home"));
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, "session.jsonl"), transcript("session"), "utf8");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    await runChatSearchCli(["search", "deploy", "--json", "--project", project, "--pilot-home", join(root, "home")]);
  } finally {
    console.log = originalLog;
  }
  const parsed = JSON.parse(output.join("")) as { matches: unknown[] };
  assert.equal(parsed.matches.length, 1, JSON.stringify(parsed));
});
