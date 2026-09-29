import type { ExtensionCommandContribution } from "../gateway/dialog/commands.js";
import { listCommands } from "../gateway/dialog/commands.js";
import type {
  CommandsListInput,
  CommandsListResult,
} from "../gateway/protocol/types.js";

export type GatewayCommandCatalogLease = {
  contributions: { commands: readonly ExtensionCommandContribution[] };
  release(): Promise<void>;
};

export type GatewayCommandCatalogRuntime = {
  pluginRuntime: {
    refresh(): Promise<unknown>;
    acquireCommandCatalog(): GatewayCommandCatalogLease;
  };
};

export type GatewayCommandCatalogProviders = {
  listCommands: typeof listCommands;
};

export type GatewayCommandCatalogBundleOptions = {
  pilotHome: string;
  resolveProjectKey: (projectKey: string) => Promise<string>;
  resolveRuntime: (projectKey: string) => GatewayCommandCatalogRuntime;
  providers?: Partial<GatewayCommandCatalogProviders>;
  warn?: (message: string, error: unknown) => void;
};

/**
 * Gateway consumer for one frozen extension command contribution generation.
 * PluginRuntime remains the generation and lease owner; this bundle only
 * projects that generation into a read-only command-list response.
 */
export class GatewayCommandCatalogBundle {
  private readonly providers: GatewayCommandCatalogProviders;
  private readonly warn: (message: string, error: unknown) => void;

  constructor(private readonly options: GatewayCommandCatalogBundleOptions) {
    this.providers = { listCommands, ...options.providers };
    this.warn = options.warn ?? ((message, error) => console.warn(message, error));
  }

  async commandsList(input: CommandsListInput): Promise<CommandsListResult> {
    const projectKey = await this.options.resolveProjectKey(input.projectKey);
    const runtime = this.options.resolveRuntime(projectKey);
    await runtime.pluginRuntime.refresh();
    const lease = runtime.pluginRuntime.acquireCommandCatalog();
    try {
      return await this.providers.listCommands(
        { ...input, projectKey },
        this.options.pilotHome,
        lease.contributions.commands,
      );
    } finally {
      await this.release(lease);
    }
  }

  private async release(lease: GatewayCommandCatalogLease): Promise<void> {
    try {
      await lease.release();
    } catch (error) {
      // A retired plugin disposer belongs to this short-lived catalog consumer.
      // Preserve the built response but retain the diagnostic for operators.
      this.warn("[pilotdeck] failed to release extension command catalog lease:", error);
    }
  }
}
