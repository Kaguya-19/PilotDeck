import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";

import type { ModuleMessage } from "../protocol.js";
import type {
  AgentLoopSidecarConnection,
  AgentLoopSidecarConnectionFactory,
} from "./agentLoopSidecarClient.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export type TcpAgentLoopSidecarConnectionFactoryOptions = {
  /** Loopback host running one long-lived AgentLoop sidecar instance. */
  host?: string;
  port: number;
  connectTimeoutMs?: number;
};

/**
 * Connection provider for a long-lived local TCP sidecar.
 *
 * Unlike the stdio provider, each replacement connection reaches the same
 * sidecar process. The protocol client can therefore use its explicit
 * reconnect/resume path without replaying execute or host module calls.
 */
export function createTcpAgentLoopSidecarConnectionFactory(
  options: TcpAgentLoopSidecarConnectionFactoryOptions,
): AgentLoopSidecarConnectionFactory {
  const connectionOptions = {
    host: requiredText(options.host ?? "127.0.0.1", "sidecar host"),
    port: validPort(options.port),
    connectTimeoutMs: positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    ),
  };
  return () => TcpAgentLoopSidecarConnection.connect(connectionOptions);
}

type TcpAgentLoopSidecarConnectionOptions = {
  host: string;
  port: number;
  connectTimeoutMs: number;
};

export class TcpAgentLoopSidecarConnection implements AgentLoopSidecarConnection {
  private readonly socket: Socket;
  private readonly lines: Interface;
  private readonly connected: Promise<void>;
  private writeChain = Promise.resolve();
  private readError: Error | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(private readonly options: TcpAgentLoopSidecarConnectionOptions) {
    this.socket = createConnection({ host: options.host, port: options.port });
    this.socket.setNoDelay(true);
    this.lines = createInterface({ input: this.socket, crlfDelay: Infinity });
    this.connected = this.waitForConnection();
    this.lines.on("error", (error) => {
      this.readError = error;
    });
    this.socket.on("error", (error) => {
      this.readError = error;
      this.lines.close();
    });
  }

  static async connect(options: TcpAgentLoopSidecarConnectionOptions): Promise<TcpAgentLoopSidecarConnection> {
    const connection = new TcpAgentLoopSidecarConnection(options);
    await connection.connected;
    return connection;
  }

  async send(message: ModuleMessage): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await this.connected;
      if (this.closed || this.socket.destroyed || !this.socket.writable) {
        throw this.transportError("Sidecar TCP socket is not writable.");
      }
      let encoded: string;
      try {
        encoded = `${JSON.stringify(message)}\n`;
      } catch (error) {
        throw this.transportError("Sidecar TCP message is not JSON serializable.", error);
      }
      await writeSocket(this.socket, encoded, () => this.transportError("Failed to write to sidecar TCP socket."));
    });
    return this.writeChain;
  }

  async *receive(): AsyncGenerator<unknown, void, unknown> {
    await this.connected;
    try {
      for await (const line of this.lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch (error) {
          throw this.transportError("Sidecar TCP stream contains malformed NDJSON.", error);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Sidecar TCP stream contains malformed NDJSON.")) {
        throw error;
      }
      throw this.transportError("Failed while reading sidecar TCP stream.", error);
    }
    if (!this.closed) {
      throw this.transportError(this.readError
        ? `Sidecar TCP socket failed before execute reached a terminal event: ${this.readError.message}`
        : "Sidecar TCP socket closed before execute reached a terminal event.");
    }
  }

  async reconnect(_input: {
    streamId: string;
    previousBinding: { moduleInstanceId: string; connectionGeneration: string };
    lastAppliedSequence: number;
  }): Promise<AgentLoopSidecarConnection> {
    await this.close("reconnecting");
    return TcpAgentLoopSidecarConnection.connect(this.options);
  }

  async close(_reason?: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(() => {
      this.lines.close();
      if (!this.socket.destroyed) this.socket.destroy();
    });
    return this.closePromise;
  }

  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.socket.removeListener("connect", onConnect);
        this.socket.removeListener("error", onError);
        this.socket.removeListener("close", onClose);
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const onConnect = () => finish();
      const onError = (error: Error) => finish(this.transportError("Failed to connect to sidecar TCP server.", error));
      const onClose = () => finish(this.transportError("Sidecar TCP socket closed before connection completed."));
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      timer = setTimeout(() => {
        this.socket.destroy();
        finish(this.transportError(`Timed out connecting to sidecar TCP server after ${this.options.connectTimeoutMs}ms.`));
      }, this.options.connectTimeoutMs);
      timer.unref();
    });
  }

  private transportError(message: string, cause?: unknown): Error {
    return cause === undefined ? new Error(message) : new Error(message, { cause });
  }
}

async function writeSocket(socket: Socket, value: string, onFailure: () => Error): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(onFailure());
    socket.once("error", onError);
    try {
      socket.write(value, (error) => finish(error ? onFailure() : undefined));
    } catch {
      finish(onFailure());
    }
  });
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("sidecar port must be an integer between 1 and 65535.");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
