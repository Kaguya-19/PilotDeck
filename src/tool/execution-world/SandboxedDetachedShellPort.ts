import {
  createNodeDetachedExecutableStarter,
  type DetachedExecutableStarter,
  type DetachedShellPort,
  type DetachedShellRequest,
} from "./DetachedShellPort.js";
import type {
  SandboxPort,
  WorkspaceSandboxPolicyResolver,
} from "./SandboxPort.js";

/** Resolve one fully-specified file-effect policy at the detached-shell boundary. */
export type DetachedShellSandboxPolicyResolver = WorkspaceSandboxPolicyResolver;

export type CreateNodeSandboxedDetachedShellPortOptions = {
  /** The enforcing provider; it receives the exact inner shell argv. */
  sandbox: SandboxPort;
  /** Direct executable substrate. A shell-string runner must never see the wrapped command. */
  startExecutable?: DetachedExecutableStarter;
  resolvePolicy: DetachedShellSandboxPolicyResolver;
  /** Defaults to the system command shell used by Node on the current platform. */
  platform?: NodeJS.Platform;
};

/**
 * DSH-style detached-shell provider that confines the exact command-shell
 * invocation. Task identity, output retention, stop/drain and completion
 * classification remain the responsibility of `BackgroundTaskRuntime`.
 */
export function createNodeSandboxedDetachedShellPort(
  options: CreateNodeSandboxedDetachedShellPortOptions,
): DetachedShellPort {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const buildArgs = platform === "win32"
    ? (command: string) => ["/d", "/s", "/c", command]
    : (command: string) => ["-c", command];
  const startExecutable = options.startExecutable ?? createNodeDetachedExecutableStarter();

  return {
    async start(request: DetachedShellRequest) {
      const policy = options.resolvePolicy({ workspaceRoot: request.cwd });
      const prepared = await options.sandbox.prepare({
        executable,
        args: buildArgs(request.command),
        cwd: request.cwd,
        env: request.env ?? process.env,
        policy,
      });
      return startExecutable({
        ...prepared,
        onStdout: request.onStdout,
        onStderr: request.onStderr,
        onError: request.onError,
      });
    },
  };
}
