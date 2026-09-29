export type PilotDeckServerBootstrapBundleOptions = {
  automation: { start(): Promise<unknown>; stop(): Promise<void> };
  disposeGateway: () => void | Promise<void>;
  telemetry: { shutdown(): Promise<void> };
  warn: (message: string, error: unknown) => void;
};

/**
 * Temporary owner for the CLI server boot sequence.
 *
 * Before commit, it guarantees that a failed server/channel startup drains
 * automation, the local Gateway, and telemetry in dependency order. After
 * commit, the existing server shutdown bundle is the only lifecycle owner.
 */
export class PilotDeckServerBootstrapBundle {
  private committed = false;
  private rollbackPromise?: Promise<void>;

  constructor(private readonly options: PilotDeckServerBootstrapBundleOptions) {}

  async startAutomation(): Promise<void> {
    try {
      await this.options.automation.start();
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    try {
      return await operation();
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  commit(): void {
    this.assertActive();
    this.committed = true;
  }

  rollback(): Promise<void> {
    if (this.committed) return Promise.resolve();
    if (this.rollbackPromise) return this.rollbackPromise;
    this.rollbackPromise = this.rollbackResources();
    return this.rollbackPromise;
  }

  private async rollbackResources(): Promise<void> {
    await this.cleanup("[pilotdeck] automation cleanup after server boot failure failed:", () => this.options.automation.stop());
    await this.cleanup("[pilotdeck] gateway cleanup after server boot failure failed:", this.options.disposeGateway);
    await this.cleanup("[pilotdeck] telemetry cleanup after server boot failure failed:", () => this.options.telemetry.shutdown());
  }

  private async cleanup(message: string, dispose: () => void | Promise<void>): Promise<void> {
    try {
      await dispose();
    } catch (error) {
      this.options.warn(message, error);
    }
  }

  private assertActive(): void {
    if (this.committed) {
      throw new Error("PilotDeck server bootstrap is already committed.");
    }
    if (this.rollbackPromise) {
      throw new Error("PilotDeck server bootstrap is rolling back.");
    }
  }
}
