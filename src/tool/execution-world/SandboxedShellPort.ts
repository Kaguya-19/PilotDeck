import type {
  SandboxPort,
  WorkspaceSandboxPolicyResolver,
} from "./SandboxPort.js";
import type { ShellPort, ShellRequest, ShellResult } from "./ShellPort.js";
import type { SubprocessPort } from "./SubprocessPort.js";

/** Resolve one fully-specified file-effect policy at the shell call boundary. */
export type ShellSandboxPolicyResolver = WorkspaceSandboxPolicyResolver;

export type CreateNodeSandboxedShellPortOptions = {
  /** The enforcing provider; it receives the exact inner shell argv. */
  sandbox: SandboxPort;
  /** Direct executable substrate. A shell-string runner must never see the wrapped command. */
  subprocess: Pick<SubprocessPort, "executeFile">;
  resolvePolicy: ShellSandboxPolicyResolver;
  /** Defaults to the system command shell used by Node on the current platform. */
  platform?: NodeJS.Platform;
};

/**
 * DSH-style shell provider that confines the exact command-shell invocation.
 *
 * The `bash` tool remains the consumer and owns input validation, permission,
 * timeout presentation and output formatting. This provider owns only policy
 * resolution, argv construction and dispatch to the direct subprocess seam.
 */
export function createNodeSandboxedShellPort(
  options: CreateNodeSandboxedShellPortOptions,
): ShellPort {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const buildArgs = platform === "win32"
    ? (command: string) => ["/d", "/s", "/c", command]
    : (command: string) => ["-c", command];

  return {
    async execute(request: ShellRequest): Promise<ShellResult> {
      const executeFile = options.subprocess.executeFile;
      if (!executeFile) {
        throw new Error("Sandboxed shell requires a direct-executable subprocess provider.");
      }
      const policy = options.resolvePolicy({ workspaceRoot: request.cwd });
      const prepared = await options.sandbox.prepare({
        executable,
        args: buildArgs(request.command),
        cwd: request.cwd,
        env: request.env ?? process.env,
        policy,
        signal: request.signal,
      });
      return executeFile({
        ...prepared,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        stdin: request.stdin,
        onStdout: request.onStdout,
        onStderr: request.onStderr,
      });
    },
  };
}
