/** Vocabulary for per-invocation filesystem confinement policy. */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/** Per-invocation filesystem confinement policy for exact process argv. */
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Native and application-profile fallback when no sandbox mode is selected. */
export const DEFAULT_SANDBOX_MODE: SandboxMode = "danger-full-access";

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && SANDBOX_MODES.some((mode) => mode === value);
}

export function resolveSandboxMode(
  value: unknown,
  fallback: SandboxMode = DEFAULT_SANDBOX_MODE,
): SandboxMode {
  return isSandboxMode(value) ? value : fallback;
}

export type SandboxPolicy = {
  mode: SandboxMode;
  workspaceRoot: string;
  executionRoot?: string;
};

/** Resolve the policy for one command whose workspace is its current directory. */
export type WorkspaceSandboxPolicyResolver = (input: { workspaceRoot: string }) => SandboxPolicy;

export type SandboxCommandRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: SandboxPolicy;
  signal?: AbortSignal;
};

/** An exact command that a code or shell runtime may execute. */
export type SandboxedCommand = Pick<SandboxCommandRequest, "executable" | "args" | "cwd" | "env">;

/**
 * Prepares a process for one policy-bearing execution. A provider must either
 * return a command it enforces or reject; it must never silently turn a
 * confined request into an unconfined one.
 */
export type SandboxPort = {
  prepare(request: SandboxCommandRequest): Promise<SandboxedCommand>;
};

export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable";

  constructor(mode: Exclude<SandboxMode, "danger-full-access">) {
    super(`Sandbox mode ${mode} is requested but no enforcing sandbox provider is available.`);
    this.name = "SandboxUnavailableError";
  }
}
