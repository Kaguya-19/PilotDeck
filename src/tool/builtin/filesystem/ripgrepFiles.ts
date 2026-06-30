import { statSync } from "node:fs";
import path from "node:path";
import {
  isIgnoredPath,
  normalizeRelativePath,
  runRipgrep,
  splitRipgrepLines,
} from "./ripgrep.js";

const DEFAULT_LIMIT = 1_000;
const GLOB_ESCAPE_CHARS = new Set(["*", "?", "[", "]", "{", "}", "\\"]);

export type RipgrepFilesInput = {
  cwd: string;
  pattern: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type RipgrepFilesResult = {
  files: string[];
  count: number;
  truncated: boolean;
};

export function normalizeRipgrepGlobPattern(pattern: string, cwd?: string): string {
  let normalized = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char !== "\\") {
      normalized += char;
      continue;
    }

    normalized += shouldTreatBackslashAsPathSeparator(pattern, index, normalized, cwd)
      ? "/"
      : "\\";
  }
  return normalized;
}

export async function ripgrepFiles(input: RipgrepFilesInput): Promise<RipgrepFilesResult> {
  const stdout = await runRipgrep({
    cwd: input.cwd,
    args: [
      "--files",
      "--hidden",
      "--no-ignore",
      "--glob",
      normalizeRipgrepGlobPattern(input.pattern, input.cwd),
      "--sort=modified",
      ".",
    ],
    env: input.env,
    signal: input.signal,
    toolName: "glob",
  });
  const limit = input.limit ?? DEFAULT_LIMIT;
  const files = splitRipgrepLines(stdout)
    .map(normalizeRelativePath)
    .filter((line) => !isIgnoredPath(line));
  const selected = files.slice(0, limit);
  return {
    files: selected,
    count: files.length,
    truncated: selected.length < files.length,
  };
}

function shouldTreatBackslashAsPathSeparator(
  pattern: string,
  index: number,
  normalizedPrefix: string,
  cwd: string | undefined,
): boolean {
  const next = pattern[index + 1];
  if (!next) {
    return false;
  }

  if (!GLOB_ESCAPE_CHARS.has(next)) {
    return true;
  }

  if (startsGlobstarPathSegment(pattern, index + 1)) {
    return true;
  }

  if (hasUnescapedGlobSpecialChars(lastPathSegment(normalizedPrefix))) {
    return true;
  }

  return cwd !== undefined && staticPrefixIsDirectory(normalizedPrefix, cwd);
}

function startsGlobstarPathSegment(pattern: string, index: number): boolean {
  return pattern.startsWith("**", index)
    && (index + 2 === pattern.length || pattern[index + 2] === "\\" || pattern[index + 2] === "/");
}

function lastPathSegment(pattern: string): string {
  const lastSeparator = pattern.lastIndexOf("/");
  return lastSeparator === -1 ? pattern : pattern.slice(lastSeparator + 1);
}

function staticPrefixIsDirectory(prefix: string, cwd: string): boolean {
  if (prefix.length === 0 || hasUnescapedGlobSpecialChars(prefix)) {
    return false;
  }

  try {
    return statSync(path.resolve(cwd, prefix)).isDirectory();
  } catch {
    return false;
  }
}

function hasUnescapedGlobSpecialChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "*" || char === "?" || char === "[" || char === "{") {
      return true;
    }
  }
  return false;
}
