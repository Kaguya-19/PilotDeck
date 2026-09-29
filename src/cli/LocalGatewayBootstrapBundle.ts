type BootstrapCleanup = {
  name: string;
  dispose: () => void | Promise<void>;
};

/**
 * Owns resources only while a local Gateway is being constructed. Once boot
 * succeeds, ownership transfers to LocalGatewayLifecycleBundle. Watchers are
 * stopped before provider cleanup so no boot-time callback can create or
 * invalidate state during rollback.
 */
export class LocalGatewayBootstrapBundle {
  private readonly cleanups: BootstrapCleanup[] = [];
  private readonly watcherStops: BootstrapCleanup[] = [];
  private committed = false;
  private rollbackPromise?: Promise<void>;

  own(name: string, dispose: () => void | Promise<void>): void {
    this.assertMutable();
    this.cleanups.push({ name, dispose });
  }

  ownWatcher(name: string, stop: () => void): void {
    this.assertMutable();
    this.watcherStops.push({ name, dispose: stop });
  }

  commit(): void {
    this.assertMutable();
    this.committed = true;
    this.cleanups.length = 0;
    this.watcherStops.length = 0;
  }

  rollback(): Promise<void> {
    if (this.committed) return Promise.resolve();
    if (this.rollbackPromise) return this.rollbackPromise;
    this.rollbackPromise = this.rollbackResources();
    return this.rollbackPromise;
  }

  private async rollbackResources(): Promise<void> {
    const failures: unknown[] = [];
    for (const cleanup of this.watcherStops) {
      await this.runCleanup(cleanup, failures);
    }
    for (const cleanup of [...this.cleanups].reverse()) {
      await this.runCleanup(cleanup, failures);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to roll back local Gateway bootstrap.");
    }
  }

  private async runCleanup(cleanup: BootstrapCleanup, failures: unknown[]): Promise<void> {
    try {
      await cleanup.dispose();
    } catch (error) {
      failures.push(new Error(`Failed to roll back ${cleanup.name}.`, { cause: error }));
    }
  }

  private assertMutable(): void {
    if (this.committed) {
      throw new Error("Local Gateway bootstrap is already committed.");
    }
    if (this.rollbackPromise) {
      throw new Error("Local Gateway bootstrap is rolling back.");
    }
  }
}
