import {
  createMcpToolDefinitionsFromRuntime,
  createNativeMcpRuntime,
  type McpRuntimeFactory,
  type ProjectMcpRuntimeProvider,
} from "../mcp/index.js";
import type { PilotDeckMcpServerSpec } from "../mcp/protocol/types.js";
import type { ToolRegistry } from "../tool/index.js";
import { SessionMcpRuntimeRegistry } from "../mcp/runtime/SessionMcpRuntimeRegistry.js";
import { GatewaySessionResourceLeaseBundle } from "./GatewaySessionResourceLeaseBundle.js";

export type SessionMcpRuntimeBundleOptions = {
  sessionKey: string;
  baseTools: ToolRegistry;
  mcpProvider: ProjectMcpRuntimeProvider;
  mcpServers: Record<string, unknown>;
  resources: GatewaySessionResourceLeaseBundle;
  perSessionRuntimes: SessionMcpRuntimeRegistry;
  maxPerSessionInstances: number;
  createRuntime?: McpRuntimeFactory;
  preparePerSessionSpecs?: (
    specs: readonly PilotDeckMcpServerSpec[],
  ) => PilotDeckMcpServerSpec[];
  onDiagnostic?: (message: string, error?: unknown) => void;
};

/**
 * Composes MCP tools for one Agent session without becoming the owner of
 * project MCP state, plugin state, or Gateway session state. The supplied
 * resource bundle owns release order: per-session MCP -> shared MCP ->
 * plugin contribution -> project runtime.
 */
export class SessionMcpRuntimeBundle {
  constructor(private readonly options: SessionMcpRuntimeBundleOptions) {}

  async compose(): Promise<ToolRegistry> {
    const sharedLease = await this.options.mcpProvider.acquireSharedRuntime(
      this.options.mcpServers,
    );
    try {
      this.options.resources.add("shared MCP runtime lease", sharedLease.release);
    } catch (error) {
      await sharedLease.release().catch(() => undefined);
      throw error;
    }

    const tools = this.options.baseTools.clone();
    for (const definition of sharedLease.tools) {
      if (!tools.has(definition.name)) tools.register(definition);
    }

    const perSessionSpecs = this.options.mcpProvider.getPerSessionServerSpecs(
      this.options.mcpServers,
    );
    if (!perSessionSpecs || perSessionSpecs.length === 0) return tools;
    if (this.options.perSessionRuntimes.size >= this.options.maxPerSessionInstances) {
      this.options.onDiagnostic?.(
        `Per-session MCP limit reached (${this.options.maxPerSessionInstances}). ` +
          `Session ${this.options.sessionKey} will not start: ${perSessionSpecs.map((spec) => spec.id).join(", ")}.`,
      );
      return tools;
    }

    const specs = this.options.preparePerSessionSpecs
      ? this.options.preparePerSessionSpecs(perSessionSpecs)
      : [...perSessionSpecs];
    const runtime = (this.options.createRuntime ?? createNativeMcpRuntime)(specs);
    const registration = this.options.perSessionRuntimes.register(this.options.sessionKey, runtime);
    try {
      this.options.resources.add("per-session MCP runtime", registration.dispose);
    } catch (error) {
      await registration.dispose().catch(() => undefined);
      throw error;
    }

    try {
      const statuses = await runtime.start();
      for (const status of statuses) {
        if (status.status === "error") {
          this.options.onDiagnostic?.(
            `${status.serverId === "funasr" ? "ASR unavailable" : "Per-session MCP unavailable"} ` +
              `(server=${status.serverId}, session=${this.options.sessionKey}): ${status.error ?? "unknown error"}`,
          );
        }
      }
      const definitions = await createMcpToolDefinitionsFromRuntime(runtime);
      for (const definition of definitions) {
        if (tools.has(definition.name)) {
          tools.replace(definition);
        } else {
          tools.register(definition);
        }
      }
    } catch (error) {
      this.options.onDiagnostic?.(
        `Per-session MCP startup failed for ${this.options.sessionKey}`,
        error,
      );
    }
    return tools;
  }
}
