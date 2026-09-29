import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { ModuleMessage } from "../protocol.js";
import type {
  AgentLoopSidecarConnection,
  AgentLoopSidecarConnectionFactory,
} from "./agentLoopSidecarClient.js";

const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export type StdioAgentLoopSidecarConnectionFactoryOptions = {
  /** Executable used to start the sidecar, normally `process.execPath`. */
  command: string;
  /** Arguments passed to the sidecar process, normally the built CLI path. */
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Wait this long after stdin closes before terminating an unresponsive child. */
  killTimeoutMs?: number;
  /** Bounded stderr retained in a transport error diagnostic. */
  maxStderrBytes?: number;
};

/**
 * Application-owned stdio provider for one sidecar turn. The connection only
 * owns a child process and its streams; Session, Gateway, Router, tools and
 * persistence remain in the host capability view.
 */
export function createStdioAgentLoopSidecarConnectionFactory(
  options: StdioAgentLoopSidecarConnectionFactoryOptions,
): AgentLoopSidecarConnectionFactory {
  const command = requiredText(options.command, "sidecar command");
  const args = options.args.map((value) => String(value));
  const killTimeoutMs = positiveInteger(options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS, "killTimeoutMs");
  const maxStderrBytes = positiveInteger(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
  const cwd = options.cwd;
  const env = options.env;

  return () => new StdioAgentLoopSidecarConnection({
    command,
    args,
    cwd,
    env,
    killTimeoutMs,
    maxStderrBytes,
  });
}

type StdioAgentLoopSidecarConnectionOptions = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killTimeoutMs: number;
  maxStderrBytes: number;
};

type ExitStatus = {
  code: number | null;
  signal: NodeJS.Signals | null;
  startupError?: Error;
};

class StdioAgentLoopSidecarConnection implements AgentLoopSidecarConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines;
  private readonly exit: Promise<ExitStatus>;
  private readonly stderr: BoundedTextBuffer;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: StdioAgentLoopSidecarConnectionOptions) {
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.stderr = new BoundedTextBuffer(options.maxStderrBytes);
    this.child.stderr.on("data", (chunk: Buffer | string) => this.stderr.append(String(chunk)));
    this.exit = observeExit(this.child);
  }

  async send(message: ModuleMessage): Promise<void> {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw this.transportError("Sidecar stdin is not writable.");
    }
    let encoded: string;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw this.transportError("Sidecar message is not JSON serializable.", error);
    }
    await write(this.child.stdin, encoded, () => this.transportError("Failed to write to sidecar stdin."));
  }

  async *receive(): AsyncGenerator<unknown, void, unknown> {
    try {
      for await (const line of this.lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch (error) {
          throw this.transportError("Sidecar stdout contains malformed NDJSON.", error);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Sidecar stdout contains malformed NDJSON.")) {
        throw error;
      }
      throw this.transportError("Failed while reading sidecar stdout.", error);
    }

    if (!this.closed) {
      const status = await this.exit;
      throw this.exitBeforeTerminalError(status);
    }
  }

  async close(_reason?: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeChild();
    return this.closePromise;
  }

  private async closeChild(): Promise<void> {
    this.lines.close();
    if (!this.child.stdin.destroyed && this.child.stdin.writable) this.child.stdin.end();
    if (await waitForExit(this.exit, this.options.killTimeoutMs)) return;

    this.child.kill("SIGTERM");
    if (await waitForExit(this.exit, this.options.killTimeoutMs)) return;

    this.child.kill("SIGKILL");
    await this.exit;
  }

  private exitBeforeTerminalError(status: ExitStatus): Error {
    const exit = status.startupError
      ? `failed to start: ${status.startupError.message}`
      : status.signal
        ? `exited from signal ${status.signal}`
        : `exited with code ${status.code ?? "unknown"}`;
    return this.transportError(`Sidecar ${exit} before execute reached a terminal event.`);
  }

  private transportError(message: string, cause?: unknown): Error {
    const stderr = this.stderr.value();
    const diagnostic = stderr ? `${message} stderr: ${stderr}` : message;
    return cause === undefined ? new Error(diagnostic) : new Error(diagnostic, { cause });
  }
}

class BoundedTextBuffer {
  private text = "";

  constructor(private readonly maximumBytes: number) {}

  append(value: string): void {
    this.text += value;
    if (Buffer.byteLength(this.text, "utf8") <= this.maximumBytes) return;
    this.text = Buffer.from(this.text, "utf8")
      .subarray(-this.maximumBytes)
      .toString("utf8");
  }

  value(): string {
    return this.text.trim();
  }
}

function observeExit(child: ChildProcessWithoutNullStreams): Promise<ExitStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: ExitStatus) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    child.once("error", (error) => finish({ code: null, signal: null, startupError: error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

async function write(
  stream: ChildProcessWithoutNullStreams["stdin"],
  value: string,
  onFailure: () => Error,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      stream.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(onFailure());
    stream.once("error", onError);
    try {
      stream.write(value, (error) => finish(error ? onFailure() : undefined));
    } catch {
      finish(onFailure());
    }
  });
}

async function waitForExit(exit: Promise<ExitStatus>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
