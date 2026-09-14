import type { PilotDeckHookInput } from "../protocol/input.js";
import type { PilotDeckHookCommand } from "../protocol/settings.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { PilotDeckHookOutput } from "../protocol/output.js";
import { createNodeShellPort, type ShellPort } from "../../../tool/execution-world/ShellPort.js";

export const PILOTDECK_HOOK_TIMEOUT_MS = 10 * 60 * 1000;
export const PILOTDECK_SESSION_END_HOOK_TIMEOUT_MS = 1500;

export type CommandHookExecutionOptions = {
  hook: Extract<PilotDeckHookCommand, { type: "command" }>;
  hookInput: PilotDeckHookInput;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CommandHookExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
  outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
  output: PilotDeckHookOutput;
};

export class CommandHookExecutor {
  constructor(private readonly shell: ShellPort = createNodeShellPort()) {}

  async execute(options: CommandHookExecutionOptions): Promise<CommandHookExecutionResult> {
    const timeoutMs = options.timeoutMs ?? PILOTDECK_HOOK_TIMEOUT_MS;
    try {
      const result = await this.shell.execute({
        command: options.hook.command,
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeoutMs,
        stdin: JSON.stringify(options.hookInput),
      });
      const exitCode = result.exitCode ?? undefined;
      const cancelled = options.signal?.aborted === true;
      const outcome = cancelled
        ? "cancelled"
        : result.timedOut
          ? "timeout"
          : exitCode === 0
            ? "success"
            : exitCode === 2
              ? "blocking"
              : "non_blocking_error";
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(exitCode !== undefined ? { exitCode } : {}),
        outcome,
        output: parseHookOutput(result.stdout),
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outcome: options.signal?.aborted ? "cancelled" : "non_blocking_error",
        output: parseHookOutput(""),
      };
    }
  }
}
