import { LocalGatewayBootstrapBundle } from "./LocalGatewayBootstrapBundle.js";
import { LocalGatewayLifecycleBundle } from "./LocalGatewayLifecycleBundle.js";

type LocalGatewayTelemetry = {
  dispose(): Promise<void>;
};

type LocalGatewaySubagentRuntime = {
  dispose(reason: string): Promise<void>;
  manager: { dispose(reason: string): Promise<void> };
  providers: { dispose(): Promise<void> };
};

type LocalGatewayRegistry = {
  disposeSessionMcpRuntimes(): Promise<void>;
  disposeProjectRuntimes(): Promise<void>;
};

type LocalGatewayRouter = {
  shutdown(): Promise<void>;
};

type LocalGatewayRuntimeRefresh = {
  dispose(): void | Promise<void>;
};

export type LocalGatewayBootResourcesOptions = {
  bootstrap?: LocalGatewayBootstrapBundle;
  warn: (message: string, error: unknown) => void;
};

/**
 * Native application composition for resources acquired while booting a local
 * Gateway. It records each resource when it is acquired, so bootstrap failure
 * and steady-state shutdown share one explicit ownership inventory.
 *
 * This bundle owns neither Gateway turn state nor project/session state. It
 * only transfers already-created provider ownership from bootstrap rollback to
 * LocalGatewayLifecycleBundle after a successful composition.
 */
export class LocalGatewayBootResources {
  private readonly bootstrap: LocalGatewayBootstrapBundle;
  private readonly warn: LocalGatewayBootResourcesOptions["warn"];
  private telemetry?: LocalGatewayTelemetry;
  private subagentRuntime?: LocalGatewaySubagentRuntime;
  private registry?: LocalGatewayRegistry;
  private router?: LocalGatewayRouter;
  private runtimeRefresh?: LocalGatewayRuntimeRefresh;
  private stopConfigWatching?: () => void;
  private stopExtensionWatching?: () => void;
  private committed = false;

  constructor(options: LocalGatewayBootResourcesOptions) {
    this.bootstrap = options.bootstrap ?? new LocalGatewayBootstrapBundle();
    this.warn = options.warn;
  }

  ownTelemetry(telemetry: LocalGatewayTelemetry): void {
    this.assertVacant("Gateway telemetry", this.telemetry);
    this.bootstrap.own("Gateway telemetry", () => telemetry.dispose());
    this.telemetry = telemetry;
  }

  ownSubagentRuntime(subagentRuntime: LocalGatewaySubagentRuntime): void {
    this.assertVacant("subagent runtime", this.subagentRuntime);
    this.bootstrap.own("subagent runtime", () => subagentRuntime.dispose("local_gateway_bootstrap_failed"));
    this.subagentRuntime = subagentRuntime;
  }

  ownRegistry(registry: LocalGatewayRegistry): void {
    this.assertVacant("project runtime registry", this.registry);
    this.bootstrap.own("project runtimes", () => registry.disposeProjectRuntimes());
    this.bootstrap.own("per-session MCP runtimes", () => registry.disposeSessionMcpRuntimes());
    this.registry = registry;
  }

  ownConfigWatcher(stop: () => void): void {
    this.assertVacant("config watcher", this.stopConfigWatching);
    this.bootstrap.ownWatcher("config watcher", stop);
    this.stopConfigWatching = stop;
  }

  ownExtensionWatcher(stop: () => void): void {
    this.assertVacant("extension watcher", this.stopExtensionWatching);
    this.bootstrap.ownWatcher("extension watcher", stop);
    this.stopExtensionWatching = stop;
  }

  ownRuntimeRefresh(runtimeRefresh: LocalGatewayRuntimeRefresh): void {
    this.assertVacant("Gateway runtime refresh", this.runtimeRefresh);
    this.bootstrap.own("Gateway runtime refresh", () => runtimeRefresh.dispose());
    this.runtimeRefresh = runtimeRefresh;
  }

  ownRouter(router: LocalGatewayRouter): void {
    this.assertVacant("session router", this.router);
    this.bootstrap.own("session router", () => router.shutdown());
    this.router = router;
  }

  rollback(): Promise<void> {
    return this.bootstrap.rollback();
  }

  commit(input: { gateway: { dispose?: (reason: string) => void } }): LocalGatewayLifecycleBundle {
    if (this.committed) {
      throw new Error("Local Gateway boot resources are already committed.");
    }
    const resources = this.requireCompleteInventory();
    this.bootstrap.commit();
    this.committed = true;
    return new LocalGatewayLifecycleBundle({
      gateway: input.gateway,
      subagentManager: resources.subagentRuntime.manager,
      subagentProviders: resources.subagentRuntime.providers,
      router: resources.router,
      registry: resources.registry,
      telemetry: resources.telemetry,
      stopConfigWatching: resources.stopConfigWatching,
      stopExtensionWatching: resources.stopExtensionWatching,
      disposeRuntimeRefresh: () => resources.runtimeRefresh.dispose(),
      warn: this.warn,
    });
  }

  private assertVacant(name: string, resource: unknown): void {
    if (this.committed) {
      throw new Error(`Cannot register ${name}; local Gateway boot resources are already committed.`);
    }
    if (resource !== undefined) {
      throw new Error(`Local Gateway boot resource is already registered: ${name}.`);
    }
  }

  private requireCompleteInventory(): {
    telemetry: LocalGatewayTelemetry;
    subagentRuntime: LocalGatewaySubagentRuntime;
    registry: LocalGatewayRegistry;
    router: LocalGatewayRouter;
    runtimeRefresh: LocalGatewayRuntimeRefresh;
    stopConfigWatching: () => void;
    stopExtensionWatching: () => void;
  } {
    const missing = [
      this.telemetry ? undefined : "Gateway telemetry",
      this.subagentRuntime ? undefined : "subagent runtime",
      this.registry ? undefined : "project runtime registry",
      this.router ? undefined : "session router",
      this.runtimeRefresh ? undefined : "Gateway runtime refresh",
      this.stopConfigWatching ? undefined : "config watcher",
      this.stopExtensionWatching ? undefined : "extension watcher",
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      throw new Error(`Local Gateway boot is missing owned resources: ${missing.join(", ")}.`);
    }
    return {
      telemetry: this.telemetry!,
      subagentRuntime: this.subagentRuntime!,
      registry: this.registry!,
      router: this.router!,
      runtimeRefresh: this.runtimeRefresh!,
      stopConfigWatching: this.stopConfigWatching!,
      stopExtensionWatching: this.stopExtensionWatching!,
    };
  }
}
