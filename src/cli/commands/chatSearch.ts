import { resolvePilotHome } from "../../pilot/index.js";
import {
  formatChatHistorySearchResults,
} from "../../session/search/formatChatHistorySearch.js";
import { parseChatSearchArgs } from "../../session/search/ChatSearchArgs.js";
import type { SessionSearchPort, SessionSearchResult } from "../../session/search/SessionSearchPort.js";

export type RunChatSearchOptions = {
  sessionSearch: SessionSearchPort;
  pilotHome?: string;
  projectRoot?: string;
  arg: string;
  locale?: "zh" | "en";
};

export async function runChatSearch(options: RunChatSearchOptions): Promise<SessionSearchResult> {
  const parsed = parseChatSearchArgs(options.arg);
  const pilotHome = options.pilotHome ?? resolvePilotHome(process.env);

  return options.sessionSearch.search({
    pilotHome,
    projectRoot: parsed.allProjects ? undefined : options.projectRoot,
    query: parsed.query,
    limit: parsed.limit,
    regex: parsed.regex,
    caseSensitive: parsed.caseSensitive,
    role: parsed.role,
    sessionId: parsed.sessionId,
  });
}

export async function runChatSearchFormatted(options: RunChatSearchOptions): Promise<{
  result: SessionSearchResult;
  text: string;
}> {
  const result = await runChatSearch(options);
  const text = formatChatHistorySearchResults(result, {
    locale: options.locale,
    includeProject: parseChatSearchArgs(options.arg).allProjects || !options.projectRoot,
  });
  return { result, text };
}

function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function readNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readStringFlag(argv, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function runChatSearchCli(argv: string[], sessionSearch: SessionSearchPort): Promise<void> {
  const subcommand = argv[0];
  if (subcommand !== "search") {
    console.error(
      "Usage: pilotdeck chat search <keyword> [--project <path>] [--all-projects] [--limit N] [--json] [--regex] [--case-sensitive] [--role user|assistant|all] [--session <id>]",
    );
    process.exitCode = 1;
    return;
  }

  const json = argv.includes("--json");
  const allProjects = argv.includes("--all-projects");
  const projectRoot = readStringFlag(argv, "--project") ?? process.cwd();
  const limit = readNumberFlag(argv, "--limit");
  const regex = argv.includes("--regex");
  const caseSensitive = argv.includes("--case-sensitive");
  const roleFlag = readStringFlag(argv, "--role");
  const role = roleFlag === "user" || roleFlag === "assistant" || roleFlag === "all" ? roleFlag : undefined;
  const sessionId = readStringFlag(argv, "--session");

  const queryParts = argv
    .slice(1)
    .filter((token, index, all) => {
      if (token.startsWith("--")) return false;
      const prev = all[index - 1];
      if (prev === "--project" || prev === "--limit" || prev === "--role" || prev === "--session") {
        return false;
      }
      return true;
    });

  const query = queryParts.join(" ").trim();
  if (!query) {
    console.error("Error: search keyword is required.");
    process.exitCode = 1;
    return;
  }

  const pilotHome = readStringFlag(argv, "--pilot-home") ?? resolvePilotHome(process.env);
  const result = await sessionSearch.search({
    pilotHome,
    projectRoot: allProjects ? undefined : projectRoot,
    query,
    limit,
    regex,
    caseSensitive,
    role,
    sessionId,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatChatHistorySearchResults(result, {
    locale: "en",
    includeProject: allProjects,
  }));
}
