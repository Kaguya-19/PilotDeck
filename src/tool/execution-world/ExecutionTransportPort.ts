import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Transport address for the private execute_code RPC bridge. */
export type ExecutionRpcTransport =
  | { kind: "uds"; socketPath: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number; token: string };

/**
 * Execution-world Definition for ephemeral RPC transport allocation and
 * cleanup. The execute_code consumer still owns the RPC protocol, Python
 * helper module, and nested tool dispatch.
 */
export type ExecutionTransportPort = {
  create(): ExecutionRpcTransport;
  cleanup(transport: ExecutionRpcTransport): Promise<void>;
};

export type ExecuteCodeTransportKind = ExecutionRpcTransport["kind"];

let executeCodeTransportOverride: ExecuteCodeTransportKind | undefined;

export function setExecuteCodeTransportOverrideForTests(kind: ExecuteCodeTransportKind | undefined): void {
  executeCodeTransportOverride = kind;
}

/** Native provider for local UDS/TCP execute_code transport resources. */
export function createNodeExecutionTransportPort(): ExecutionTransportPort {
  return {
    create() {
      const kind = executeCodeTransportOverride ?? (process.platform === "win32" ? "tcp" : "uds");
      if (kind === "tcp") {
        return {
          kind,
          host: "127.0.0.1",
          port: 0,
          token: randomBytes(32).toString("hex"),
        };
      }
      return {
        kind,
        socketPath: path.join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          `pilotdeck_rpc_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sock`,
        ),
      };
    },
    async cleanup(transport) {
      if (transport.kind === "uds") {
        await rm(transport.socketPath, { force: true });
      }
    },
  };
}
