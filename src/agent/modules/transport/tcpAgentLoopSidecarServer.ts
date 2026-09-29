import { createServer, type Server, type Socket } from "node:net";

import { AgentLoopSidecarServer } from "./agentLoopSidecarServer.js";

export type TcpAgentLoopSidecarListenOptions = {
  host?: string;
  port: number;
  backlog?: number;
};

export type TcpAgentLoopSidecarAddress = {
  host: string;
  port: number;
};

/**
 * Long-lived TCP listener for one AgentLoop sidecar instance.
 *
 * The listener owns only accepted sockets. Its shared sidecar instance retains
 * volatile transport replay state while durable Session and operation state
 * remains in the host owning each connection.
 */
export class AgentLoopSidecarTcpServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly sidecar: AgentLoopSidecarServer) {}

  async listen(options: TcpAgentLoopSidecarListenOptions): Promise<TcpAgentLoopSidecarAddress> {
    if (this.server) throw new Error("AgentLoop sidecar TCP server is already listening.");
    const host = (options.host ?? "127.0.0.1").trim();
    if (!host) throw new Error("sidecar TCP host must not be empty.");
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error("sidecar TCP port must be an integer between 0 and 65535.");
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host, port: options.port, ...(options.backlog === undefined ? {} : { backlog: options.backlog }) });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("AgentLoop sidecar TCP server did not bind a TCP address.");
      return { host: address.address, port: address.port };
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.once("close", () => this.sockets.delete(socket));
    void this.sidecar.serve(socket, socket).catch((error: unknown) => {
      if (!socket.destroyed) socket.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  }
}
