import {
  createNodeSubprocessPort,
  type SubprocessPort,
  type SubprocessRequest,
  type SubprocessResult,
} from "./SubprocessPort.js";

/** Host-independent request for one shell command. */
export type ShellRequest = SubprocessRequest;

/** Canonical result returned by a shell provider. */
export type ShellResult = SubprocessResult;

/**
 * DSH-style execution-world Definition for shell semantics.
 *
 * Shell expansion, quoting, environment inheritance, streaming and process
 * termination belong to this provider. Tool consumers should not need to know
 * whether the implementation is local, remote or backed by a sidecar.
 */
export type ShellPort = {
  execute(request: ShellRequest): Promise<ShellResult>;
};

/**
 * Native composition adapter. The existing subprocess provider remains the
 * compatibility substrate while shell-specific consumers depend on the
 * narrower ShellPort definition.
 */
export function createNodeShellPort(
  subprocess: Pick<SubprocessPort, "execute"> = createNodeSubprocessPort(),
): ShellPort {
  return {
    execute: (request) => subprocess.execute(request),
  };
}
