/**
 * Temporary execution workspace seam used by code-runtime consumers.
 *
 * This is intentionally separate from {@link FsPort}: a workspace created
 * here is private to one execution and its owner is responsible for cleanup.
 * The port does not execute processes, expose the user's workspace, or own
 * the Python/RPC protocol.
 */

export type ExecutionWorkspace = {
  /** Absolute root visible to the execution consumer and its child process. */
  readonly root: string;
  /** Write one UTF-8 file below this workspace and return its absolute path. */
  writeText(relativePath: string, content: string): Promise<string>;
  /** Stop accepting new writes and remove all provider-owned resources. */
  cleanup(): Promise<void>;
};

export type ExecutionWorkspacePort = {
  /** Create one private, empty workspace for a single execution. */
  create(options?: { prefix?: string; signal?: AbortSignal }): Promise<ExecutionWorkspace>;
};
