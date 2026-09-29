/**
 * Process substrate for one model-authored code run.
 *
 * The consumer owns the language protocol, host bindings, tool dispatch, and
 * result presentation. A provider owns only the child-process lifecycle and
 * bounded stdio collection.
 */

export type CodeRuntimeRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
};

export type CodeRuntimeResult = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
};

export type CodeRuntimePort = {
  /** Resolve the first usable interpreter without exposing process APIs to consumers. */
  resolveExecutable(candidates: readonly string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined>;
  run(request: CodeRuntimeRequest): Promise<CodeRuntimeResult>;
  /** Stop new runs and await already-started runs when the owning composition is torn down. */
  dispose?(): Promise<void>;
};
