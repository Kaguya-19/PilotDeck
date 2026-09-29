import type { PilotDeckToolDefinition } from "../../tool/index.js";
import { loadMcpServerConfig } from "../config/loadMcpServerConfig.js";
import type { PilotDeckMcpServerSpec } from "../protocol/types.js";
import { createNativeMcpRuntime } from "./McpRuntime.js";
import type { McpRuntimeFactory, McpRuntimePort } from "./McpRuntimePort.js";
import { createMcpToolDefinitionsFromRuntime } from "./PluginToToolBridge.js";
import { parsePluginMcpServers } from "./parsePluginMcpServers.js";
import { patchProjectScopedMcpSpec } from "./projectMcpSpec.js";

export type ProjectMcpRuntimeProviderState = "active" | "draining" | "disposed";

export type ProjectMcpRuntimeProviderOptions = {
  projectRoot: string;
  pilotHome: string;
  createRuntime?: McpRuntimeFactory;
  onDiagnostic?: (message: string, error?: unknown) => void;
};

/** A session-scoped retain on one shared MCP runtime generation. */
export type ProjectMcpRuntimeLease = {
  readonly tools: readonly PilotDeckToolDefinition[];
  release(): Promise<void>;
};

type SharedRuntimeEntry = {
  signature: string;
  runtime: McpRuntimePort;
  tools: PilotDeckToolDefinition[];
  leases: number;
  ready: Promise<void>;
  stopPromise?: Promise<void>;
};

/**
 * Project-scoped MCP provider.
 *
 * It owns shared MCP runtime generations. A session retains exactly the
 * generation that produced its MCP tool definitions, so a plugin reload can
 * publish a new generation without disconnecting older sessions. Per-session
 * MCP instances remain outside this provider and are owned by their exact
 * AgentHandle resource lease.
 */
export class ProjectMcpRuntimeProvider {
  private state_: ProjectMcpRuntimeProviderState = "active";
  private disposePromise?: Promise<void>;
  private readonly sharedEntries = new Map<string, SharedRuntimeEntry>();
  private configuredServers?: Record<string, unknown>;

  constructor(private readonly options: ProjectMcpRuntimeProviderOptions) {}

  get state(): ProjectMcpRuntimeProviderState {
    return this.state_;
  }

  /**
   * Project config is fixed by the ProjectRuntime, while plugin entries must
   * come from the exact frozen contribution already retained by a session.
   */
  getPerSessionServerSpecs(
    pluginServers: Record<string, unknown>,
  ): readonly PilotDeckMcpServerSpec[] | undefined {
    const servers = this.materializeServers(pluginServers).filter(
      (server) => server.transport === "stdio" && server.perSession,
    );
    return servers.length > 0 ? servers : undefined;
  }

  /**
   * Starts or reuses the shared runtime described by one frozen plugin
   * contribution snapshot. New sessions receive only this lease's tools;
   * existing sessions retain their previous runtime until their own cleanup.
   */
  async acquireSharedRuntime(
    pluginServers: Record<string, unknown>,
  ): Promise<ProjectMcpRuntimeLease> {
    this.assertActive("acquire a shared MCP runtime");
    const servers = this.materializeServers(pluginServers).filter(
      (server) => server.transport !== "stdio" || !server.perSession,
    );
    if (servers.length === 0) return EMPTY_SHARED_RUNTIME_LEASE;

    const signature = stableServerSignature(servers);
    let entry = this.sharedEntries.get(signature);
    if (!entry) {
      const runtime = (this.options.createRuntime ?? createNativeMcpRuntime)(servers);
      entry = {
        signature,
        runtime,
        tools: [],
        leases: 0,
        ready: Promise.resolve(),
      };
      entry.ready = this.startEntry(entry);
      this.sharedEntries.set(signature, entry);
    }

    entry.leases += 1;
    try {
      await entry.ready;
    } catch (error) {
      await this.releaseEntry(entry).catch((releaseError) => {
        this.options.onDiagnostic?.("Failed to clean up unavailable MCP runtime", releaseError);
      });
      this.options.onDiagnostic?.("MCP runtime startup partial-failed", error);
      return EMPTY_SHARED_RUNTIME_LEASE;
    }

    if (this.state_ !== "active") {
      await this.releaseEntry(entry);
      throw new Error(`Cannot acquire a shared MCP runtime; provider is ${this.state_}.`);
    }

    let released = false;
    return {
      tools: entry.tools,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseEntry(entry!);
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state_ = "draining";
    this.disposePromise = this.stopAll();
    return this.disposePromise;
  }

  private async startEntry(entry: SharedRuntimeEntry): Promise<void> {
    const statuses = await entry.runtime.start();
    for (const status of statuses) {
      if (status.status === "error") {
        this.options.onDiagnostic?.(
          `${status.serverId === "funasr" ? "ASR unavailable" : "MCP server unavailable"} ` +
            `(server=${status.serverId}): ${status.error ?? "unknown error"}`,
        );
      }
    }
    entry.tools = await createMcpToolDefinitionsFromRuntime(entry.runtime);
  }

  private async releaseEntry(entry: SharedRuntimeEntry): Promise<void> {
    if (entry.leases > 0) entry.leases -= 1;
    if (entry.leases === 0) await this.stopEntry(entry);
  }

  private stopEntry(entry: SharedRuntimeEntry): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      await entry.ready.catch(() => undefined);
      try {
        await entry.runtime.stop();
      } finally {
        if (this.sharedEntries.get(entry.signature) === entry) {
          this.sharedEntries.delete(entry.signature);
        }
      }
    })();
    return entry.stopPromise;
  }

  private async stopAll(): Promise<void> {
    const entries = [...this.sharedEntries.values()];
    const results = await Promise.allSettled(entries.map((entry) => this.stopEntry(entry)));
    this.state_ = "disposed";
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose project MCP runtime provider.");
    }
  }

  private materializeServers(pluginServers: Record<string, unknown>): PilotDeckMcpServerSpec[] {
    const rawServers = {
      ...pluginServers,
      ...this.getConfiguredServers(),
    };
    const { servers, diagnostics } = parsePluginMcpServers(rawServers);
    for (const diagnostic of diagnostics) {
      this.options.onDiagnostic?.(`Ignoring invalid MCP server ${diagnostic.id}: ${diagnostic.message}`);
    }
    return servers.map((server) => patchProjectScopedMcpSpec(
      server,
      this.options.projectRoot,
      this.options.pilotHome,
    ));
  }

  private getConfiguredServers(): Record<string, unknown> {
    if (this.configuredServers) return this.configuredServers;
    const configServers = loadMcpServerConfig(this.options.projectRoot, this.options.pilotHome);
    for (const diagnostic of configServers.diagnostics) {
      this.options.onDiagnostic?.(`Ignoring invalid MCP config ${diagnostic.path}: ${diagnostic.message}`);
    }
    this.configuredServers = configServers.servers;
    return this.configuredServers;
  }

  private assertActive(action: string): void {
    if (this.state_ !== "active") {
      throw new Error(`Cannot ${action}; MCP provider is ${this.state_}.`);
    }
  }
}

const EMPTY_SHARED_RUNTIME_LEASE: ProjectMcpRuntimeLease = {
  tools: [],
  async release() {},
};

function stableServerSignature(servers: readonly PilotDeckMcpServerSpec[]): string {
  return JSON.stringify(normalizeForSignature(
    [...servers].sort((left, right) => left.id.localeCompare(right.id)),
  ));
}

function normalizeForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForSignature);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForSignature(child)]),
  );
}
