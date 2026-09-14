/**
 * Application-owned shutdown composition for a local Gateway process.
 *
 * It owns only stop ordering for already-created providers. Gateway/session
 * state remains owned by their existing runtimes, and project generations
 * remain owned by ProjectRuntimeRegistry.
 */
export type LocalGatewayLifecycleBundleOptions = {
  gateway: { dispose?: (reason: string) => void };
  subagentManager: { dispose(reason: string): Promise<void> };
  subagentProviders: { dispose(): Promise<void> };
  router?: { shutdown(): Promise<void> };
  registry: {
    disposeSessionMcpRuntimes(): Promise<void>;
    disposeProjectRuntimes(): Promise<void>;
  };
  telemetry: { dispose(): Promise<void> };
  stopConfigWatching: () => void;
  stopExtensionWatching: () => void;
  disposeRuntimeRefresh?: () => void;
  warn: (message: string, error: unknown) => void;
};

export class LocalGatewayLifecycleBundle {
  private disposePromise?: Promise<void>;

  constructor(private readonly options: LocalGatewayLifecycleBundleOptions) {}

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    // Preserve the existing behavior: Gateway stops admission before watcher
    // cleanup, while watcher callbacks are stopped before async drains finish.
    this.disposePromise = this.disposeResources();
    this.disposeStep("[pilotdeck] failed to stop config watching:", this.options.stopConfigWatching);
    this.disposeStep("[pilotdeck] failed to stop extension watching:", this.options.stopExtensionWatching);
    this.disposeStep("[pilotdeck] failed to dispose Gateway runtime refresh:", () => this.options.disposeRuntimeRefresh?.());
    return this.disposePromise;
  }

  private async disposeResources(): Promise<void> {
    // Gateway.dispose() is synchronous. Start the first async drain before
    // returning to dispose(), so watcher shutdown still overlaps that drain.
    void this.disposeStep(
      "[pilotdeck] failed to dispose local Gateway:",
      () => this.options.gateway.dispose?.("local_gateway_disposed"),
    );
    await this.disposeStep(
      "[pilotdeck] failed to dispose continuable subagents:",
      () => this.options.subagentManager.dispose("local_gateway_disposed"),
    );
    await this.disposeStep(
      "[pilotdeck] failed to dispose subagent providers:",
      () => this.options.subagentProviders.dispose(),
    );
    await this.disposeStep(
      "[pilotdeck] failed to shut down session router:",
      () => this.options.router?.shutdown(),
    );
    await this.disposeStep(
      "[pilotdeck] failed to dispose per-session MCP runtimes:",
      () => this.options.registry.disposeSessionMcpRuntimes(),
    );
    await this.disposeStep(
      "[pilotdeck] failed to dispose project runtimes:",
      () => this.options.registry.disposeProjectRuntimes(),
    );
    await this.disposeStep(
      "[pilotdeck] failed to dispose Gateway telemetry:",
      () => this.options.telemetry.dispose(),
    );
  }

  private async disposeStep(
    message: string,
    dispose: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await dispose();
    } catch (error) {
      this.options.warn(message, error);
    }
  }
}
