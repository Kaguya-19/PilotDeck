import type {
  PilotDeckMcpClientStatusEntry,
  PilotDeckMcpServerSpec,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";

export type McpRuntimeServerInfo = {
  transport: PilotDeckMcpServerSpec["transport"];
  /** Stdio server working directory used to resolve returned local media links. */
  cwd?: string;
};

export type McpToolCallResult = {
  content: unknown;
  isError?: boolean;
};

/**
 * Provider-neutral MCP capability consumed by project/session composition and
 * the MCP-to-tool bridge. It deliberately does not expose `McpClient`.
 */
export type McpRuntimePort = {
  start(): Promise<PilotDeckMcpClientStatusEntry[]>;
  stop(): Promise<void>;
  listAllTools(): Promise<PilotDeckMcpToolSpec[]>;
  getServerInfo(serverId: string): McpRuntimeServerInfo | undefined;
  callTool(
    serverId: string,
    toolName: string,
    input: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpToolCallResult>;
};

/** Composition-time provider selector for shared and per-session MCP runtimes. */
export type McpRuntimeFactory = (servers: PilotDeckMcpServerSpec[]) => McpRuntimePort;
