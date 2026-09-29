import type { ExtensionResolver } from "../context/extension/ExtensionResolver.js";
import {
  filterAvailableTools,
  registerAvailableExtensionToolContributions,
  type PilotDeckToolAvailabilityContext,
  type PilotDeckUnavailableToolDiagnostic,
  type ToolRegistry,
} from "../tool/index.js";

export type SessionToolCompositionResult = {
  registry: ToolRegistry;
  unavailable: PilotDeckUnavailableToolDiagnostic[];
};

export type SessionToolCompositionBundleOptions = {
  /** Builds the one session-local registry with shared and per-session MCP tools. */
  composeMcpTools: () => Promise<ToolRegistry>;
  /** Frozen extension generation retained by the caller's session resource lease. */
  extension: Pick<ExtensionResolver, "listToolContributions">;
  availability: PilotDeckToolAvailabilityContext;
  excludeTools?: readonly string[];
  isAlwaysOnSession: boolean;
  /** Names contributed by the Always-On runtime, not a second tool registry. */
  alwaysOnToolNames?: readonly string[];
};

/**
 * Application composition for one session's final tool surface.
 *
 * Project tools, plugin contributions, and MCP runtimes remain owned by their
 * existing providers. This bundle only transfers the final session registry to
 * AgentRuntimeScope; intermediate registries are disposed on every path.
 */
export class SessionToolCompositionBundle {
  constructor(private readonly options: SessionToolCompositionBundleOptions) {}

  async compose(): Promise<SessionToolCompositionResult> {
    let working: ToolRegistry | undefined;
    let finalRegistry: ToolRegistry | undefined;
    try {
      working = await this.options.composeMcpTools();
      this.applySessionPolicy(working);

      const availability = await filterAvailableTools(working, this.options.availability);
      finalRegistry = availability.registry;
      const extension = await registerAvailableExtensionToolContributions(
        finalRegistry,
        this.options.extension,
        this.options.availability,
      );

      working.dispose();
      working = undefined;
      return {
        registry: finalRegistry,
        unavailable: [...availability.unavailable, ...extension.unavailable],
      };
    } catch (error) {
      finalRegistry?.dispose();
      working?.dispose();
      throw error;
    }
  }

  private applySessionPolicy(registry: ToolRegistry): void {
    for (const name of this.options.excludeTools ?? []) {
      registry.unregister(name);
    }
    if (this.options.isAlwaysOnSession) return;
    for (const name of this.options.alwaysOnToolNames ?? []) {
      registry.unregister(name);
    }
  }
}
