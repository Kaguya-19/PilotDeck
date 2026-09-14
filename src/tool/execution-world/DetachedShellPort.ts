import { spawn, type ChildProcess } from "node:child_process";

/** Host-independent request for one detached shell task. */
export type DetachedShellRequest = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: Buffer | string) => void;
  onStderr?: (chunk: Buffer | string) => void;
  onError?: (error: Error) => void;
};

export type DetachedShellExit = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
};

/** Provider-owned handle for one detached process. */
export type DetachedShellHandle = {
  readonly pid?: number;
  readonly exit: Promise<DetachedShellExit>;
  terminate(signal: NodeJS.Signals): void;
};

/** An exact executable invocation for providers that must not use a shell string. */
export type DetachedExecutableRequest = Omit<DetachedShellRequest, "command"> & {
  executable: string;
  args: readonly string[];
};

/** Node process substrate consumed by policy-enforcing detached-shell providers. */
export type DetachedExecutableStarter = (
  request: DetachedExecutableRequest,
) => Promise<DetachedShellHandle>;

/** DSH-style Definition for detached/background shell execution. */
export type DetachedShellPort = {
  start(request: DetachedShellRequest): Promise<DetachedShellHandle>;
};

/**
 * Native direct-executable substrate for a detached provider.
 *
 * This is intentionally separate from `createNodeDetachedShellPort()`: the
 * latter preserves the legacy shell-string behavior, while a sandbox provider
 * must dispatch only an already-prepared exact argv.
 */
export function createNodeDetachedExecutableStarter(
  spawnProgram: typeof spawn = spawn,
): DetachedExecutableStarter {
  return async (request) => {
    let child: ChildProcess;
    try {
      child = spawnProgram(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      throw error;
    }

    child.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => request.onStdout?.(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => request.onStderr?.(chunk));
    child.on("error", (error) => request.onError?.(error));
    const exit = new Promise<DetachedShellExit>((resolve) => {
      child.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
    });

    return {
      pid: typeof child.pid === "number" ? child.pid : undefined,
      exit,
      terminate(signal) {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the process handle when no detached group remains.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // The process may have exited between status observation and kill.
        }
      },
    };
  };
}

/** Native provider; task ownership and output retention stay with the consumer. */
export function createNodeDetachedShellPort(
  spawnShell: typeof spawn = spawn,
): DetachedShellPort {
  return {
    async start(request) {
      let child: ChildProcess;
      try {
        child = spawnShell(request.command, {
          cwd: request.cwd,
          env: request.env,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        throw error;
      }

      child.unref();
      child.stdout?.on("data", (chunk: Buffer | string) => request.onStdout?.(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => request.onStderr?.(chunk));
      child.on("error", (error) => request.onError?.(error));
      const exit = new Promise<DetachedShellExit>((resolve) => {
        child.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
      });

      return {
        pid: typeof child.pid === "number" ? child.pid : undefined,
        exit,
        terminate(signal) {
          try {
            child.kill(signal);
          } catch {
            // The process may have exited between status observation and kill.
          }
        },
      };
    },
  };
}
