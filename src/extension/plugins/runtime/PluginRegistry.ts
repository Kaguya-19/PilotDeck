import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";

export type PluginRegistryState = "active" | "draining" | "disposed";

export type PluginRegistryLease = {
  readonly generation: number;
  readonly plugins: readonly PilotDeckLoadedPlugin[];
  release(): Promise<void>;
};

export type PluginRegistryReplacement = {
  readonly generation: number;
  readonly previous: PilotDeckLoadedPlugin[];
  readonly next: PilotDeckLoadedPlugin[];
  readonly removed: PilotDeckLoadedPlugin[];
  /**
   * Previous plugin instances no longer used by the active generation.
   * This includes a same-name plugin that was reloaded as a new instance.
   */
  readonly retired: PilotDeckLoadedPlugin[];
  /** Number of active leases retaining one or more retired instances. */
  readonly retiringLeaseCount: number;
  disposeRemoved(): Promise<void>;
};

export class PluginRegistry {
  private readonly plugins = new Map<string, PilotDeckLoadedPlugin>();
  private readonly retiredPlugins = new Set<PilotDeckLoadedPlugin>();
  private readonly pluginLeaseCounts = new Map<PilotDeckLoadedPlugin, number>();
  private readonly pendingDisposals = new Map<PilotDeckLoadedPlugin, Promise<void>>();
  private readonly leaseWaiters = new Set<() => void>();
  private registryState: PluginRegistryState = "active";
  private generation = 0;
  private disposalPromise?: Promise<void>;

  get state(): PluginRegistryState {
    return this.registryState;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  acquire(): PluginRegistryLease {
    this.assertActive("acquire plugins");
    const generation = this.generation;
    const plugins = this.list();
    for (const plugin of plugins) {
      this.pluginLeaseCounts.set(plugin, (this.pluginLeaseCounts.get(plugin) ?? 0) + 1);
    }

    let releasePromise: Promise<void> | undefined;
    return {
      generation,
      plugins,
      release: () => (releasePromise ??= this.release(plugins)),
    };
  }

  replaceAll(plugins: PilotDeckLoadedPlugin[]): PluginRegistryReplacement {
    this.assertActive("replace plugins");
    const previous = this.list();
    const next = [...plugins];
    const nextKeys = new Set(next.map((plugin) => `${plugin.name}@${plugin.source}`));
    const removed = previous.filter((plugin) => !nextKeys.has(`${plugin.name}@${plugin.source}`));
    // Key equality is not instance equality. A disk reload can replace a
    // plugin with the same name/source while sessions still use its callbacks.
    const retired = previous.filter((plugin) => !next.includes(plugin));
    const retiringLeaseCount = retired.reduce(
      (count, plugin) => count + (this.pluginLeaseCounts.get(plugin) ?? 0),
      0,
    );
    this.plugins.clear();
    for (const plugin of next) {
      this.plugins.set(`${plugin.name}@${plugin.source}`, plugin);
    }
    this.notifyLeaseWaiters();
    for (const plugin of retired) this.retiredPlugins.add(plugin);
    const generation = ++this.generation;
    let disposeRetired: Promise<void> | undefined;
    return {
      generation,
      previous,
      next,
      removed,
      retired,
      retiringLeaseCount,
      disposeRemoved: () => (disposeRetired ??= this.disposeWhenUnreferenced(retired)),
    };
  }

  list(): PilotDeckLoadedPlugin[] {
    return [...this.plugins.values()];
  }

  async dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    if (this.registryState === "disposed") return;
    this.registryState = "draining";
    const plugins = [...new Set([...this.retiredPlugins, ...this.list()])];
    this.plugins.clear();
    this.notifyLeaseWaiters();
    const disposeActive = this.disposeWhenUnreferenced(plugins);
    this.disposalPromise = (async () => {
      const pending = [...new Set([...this.pendingDisposals.values(), disposeActive])];
      const results = await Promise.allSettled(pending);
      this.registryState = "disposed";
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose plugins.");
    })();
    return this.disposalPromise;
  }

  private async release(plugins: readonly PilotDeckLoadedPlugin[]): Promise<void> {
    for (const plugin of plugins) {
      const current = this.pluginLeaseCounts.get(plugin) ?? 0;
      if (current <= 1) {
        this.pluginLeaseCounts.delete(plugin);
      } else {
        this.pluginLeaseCounts.set(plugin, current - 1);
      }
    }
    this.notifyLeaseWaiters();
    const pending = plugins
      .map((plugin) => this.pendingDisposals.get(plugin))
      .filter((value): value is Promise<void> => value !== undefined);
    const results = await Promise.allSettled(pending);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose released plugins.");
  }

  private disposeWhenUnreferenced(plugins: readonly PilotDeckLoadedPlugin[]): Promise<void> {
    const disposals = plugins.map((plugin) => this.disposePluginWhenUnreferenced(plugin));
    return settlePluginDisposals(disposals, "Failed to dispose retired plugins.");
  }

  private disposePluginWhenUnreferenced(plugin: PilotDeckLoadedPlugin): Promise<void> {
    const pending = this.pendingDisposals.get(plugin);
    if (pending) return pending;

    const disposal = (async () => {
      while (this.isPluginReferenced(plugin)) {
        await this.waitForLeaseChange();
      }
      await plugin.dispose?.();
    })();
    this.pendingDisposals.set(plugin, disposal);
    // A caller may intentionally defer retirement disposal until a session
    // releases its snapshot. Keep the rejection owned by the returned handle.
    void disposal.catch(() => undefined);
    void disposal.finally(() => {
      this.pendingDisposals.delete(plugin);
      this.retiredPlugins.delete(plugin);
    }).catch(() => undefined);
    return disposal;
  }

  private isPluginReferenced(plugin: PilotDeckLoadedPlugin): boolean {
    const activePlugin = this.plugins.get(`${plugin.name}@${plugin.source}`);
    return activePlugin === plugin || (this.pluginLeaseCounts.get(plugin) ?? 0) > 0;
  }

  private waitForLeaseChange(): Promise<void> {
    return new Promise((resolve) => this.leaseWaiters.add(resolve));
  }

  private notifyLeaseWaiters(): void {
    for (const resolve of this.leaseWaiters) resolve();
    this.leaseWaiters.clear();
  }

  private assertActive(action: string): void {
    if (this.registryState !== "active") {
      throw new Error(`Cannot ${action}; plugin registry is ${this.registryState}.`);
    }
  }
}

async function settlePluginDisposals(
  disposals: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(disposals);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
