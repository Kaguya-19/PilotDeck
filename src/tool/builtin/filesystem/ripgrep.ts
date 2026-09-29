import { createRequire } from "node:module";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import {
  createNodeSubprocessPort,
  type SubprocessPort,
  type SubprocessResult,
} from "../../execution-world/SubprocessPort.js";

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 20_000;

export const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export type RipgrepRunInput = {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  subprocess?: Pick<SubprocessPort, "executeFile">;
  toolName: "glob" | "grep";
};

let cachedRipgrepPath: string | undefined;

export async function runRipgrep(input: RipgrepRunInput): Promise<string> {
  const env = input.env ?? process.env;
  const ripgrepPath = resolveBundledRipgrepPath(input.toolName);
  const subprocess = input.subprocess ?? createNodeSubprocessPort();
  if (!subprocess.executeFile) {
    throw new PilotDeckToolRuntimeError(
      "unsupported_tool",
      `${input.toolName} requires a subprocess provider with direct executable support.`,
    );
  }
  let result: SubprocessResult;
  try {
    result = await subprocess.executeFile({
      executable: ripgrepPath,
      args: input.args,
      cwd: input.cwd,
      env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) {
      throw new PilotDeckToolRuntimeError("tool_aborted", `${input.toolName} search aborted.`);
    }
    if (isEnoent(error)) {
      throw createBundledRipgrepUnavailableError(input.toolName, error);
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `ripgrep ${input.toolName} search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (input.signal?.aborted) {
    throw new PilotDeckToolRuntimeError("tool_aborted", `${input.toolName} search aborted.`);
  }
  if (result.timedOut) {
    throw new PilotDeckToolRuntimeError(
      "tool_timeout",
      `${input.toolName} search timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
    );
  }
  if (result.exitCode === 0 || result.exitCode === 1) {
    return result.stdout;
  }
  if (result.exitSignal) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `ripgrep ${input.toolName} search exited via signal ${result.exitSignal}.`,
    );
  }

  const stderrText = result.stderr.trim();
  throw new PilotDeckToolRuntimeError(
    "tool_execution_failed",
    stderrText.length > 0
      ? `ripgrep ${input.toolName} search failed: ${stderrText}`
      : `ripgrep ${input.toolName} search failed with exit code ${result.exitCode}.`,
    { exitCode: result.exitCode, stderr: stderrText || undefined },
  );
}

function resolveBundledRipgrepPath(toolName: RipgrepRunInput["toolName"]): string {
  if (cachedRipgrepPath) {
    return cachedRipgrepPath;
  }

  try {
    const resolved = require("@vscode/ripgrep") as { rgPath?: unknown };
    if (typeof resolved.rgPath !== "string" || resolved.rgPath.length === 0) {
      throw new Error("@vscode/ripgrep did not expose a valid rgPath.");
    }
    cachedRipgrepPath = resolved.rgPath;
    return cachedRipgrepPath;
  } catch (error) {
    throw createBundledRipgrepUnavailableError(toolName, error);
  }
}

function createBundledRipgrepUnavailableError(
  toolName: RipgrepRunInput["toolName"],
  cause: unknown,
): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError(
    "unsupported_tool",
    `${toolName} requires the bundled ripgrep binary from @vscode/ripgrep, but it is not available for ${process.platform}-${process.arch}. Reinstall dependencies with optional dependencies enabled.`,
    { cause: cause instanceof Error ? cause.message : String(cause) },
  );
}

export function splitRipgrepLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function normalizeRelativePath(file: string): string {
  const normalized = file.split(path.sep).join("/");
  const withoutDotPrefix = normalized.replace(/^\.\//, "");
  return path.posix.normalize(withoutDotPrefix);
}

export function isIgnoredPath(file: string): boolean {
  return file.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
