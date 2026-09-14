import { spawn } from "node:child_process";
import {
  NodeShellCommandRunner,
  type PilotDeckCommandOptions,
  type PilotDeckCommandResult,
  type PilotDeckCommandRunner,
} from "../builtin/bash/commandRunner.js";

/** Host-independent subprocess request consumed by shell tools. */
export type SubprocessRequest = PilotDeckCommandOptions & { command: string };

/** Canonical result returned by a subprocess provider. */
export type SubprocessResult = PilotDeckCommandResult & {
  /** Present for direct executable requests that close because of a signal. */
  exitSignal?: NodeJS.Signals | null;
};

/** Host-independent request for a program that must not be routed through a shell. */
export type SubprocessFileRequest = PilotDeckCommandOptions & {
  executable: string;
  args: readonly string[];
  /** Optional UTF-8 payload written to stdin before the process is observed. */
  stdin?: string;
};

/** DSH-style execution-world Definition for a foreground subprocess. */
export type SubprocessPort = {
  execute(request: SubprocessRequest): Promise<SubprocessResult>;
  /** Optional direct-executable path; consumers that need it must fail clearly when absent. */
  executeFile?(request: SubprocessFileRequest): Promise<SubprocessResult>;
};

/** Native provider adapter; the Node runner remains the source of shell semantics. */
export function createNodeSubprocessPort(
  runner: PilotDeckCommandRunner = new NodeShellCommandRunner(),
): SubprocessPort {
  return {
    execute: (request) => runner.run(request.command, request),
    executeFile: runNodeExecutable,
  };
}

function runNodeExecutable(request: SubprocessFileRequest): Promise<SubprocessResult> {
  if (request.signal?.aborted) {
    return Promise.reject(new Error("Subprocess execution was aborted."));
  }

  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* process already exited */ }
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process already exited */ }
        }, 1_000).unref();
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: SubprocessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      stop();
      fail(new Error("Subprocess execution was aborted."));
    };

    timeout = setTimeout(() => {
      stop();
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        durationMs: Date.now() - startedAt,
      });
    }, request.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      try { request.onStdout?.(chunk); } catch { /* progress is best-effort */ }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      try { request.onStderr?.(chunk); } catch { /* progress is best-effort */ }
    });
    child.stdin?.end(request.stdin ?? "");
    child.on("error", (error) => fail(error));
    child.on("close", (exitCode, exitSignal) => {
      finish({
        exitCode,
        stdout,
        stderr,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        exitSignal,
      });
    });
    request.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
