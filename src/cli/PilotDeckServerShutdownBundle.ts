/**
 * Ordered application shutdown for the `pilotdeck server` composition root.
 * It deliberately does not own server/channel/session state; those providers
 * retain their existing owners and are only asked to finish in dependency
 * order here.
 */
export type PilotDeckServerShutdownBundleOptions = {
  automation: { stop(): Promise<void> };
  closeServer: () => Promise<void>;
  flushChannelState: () => Promise<void>;
  disposeGateway: () => void | Promise<void>;
  telemetry: {
    snapshot(): unknown;
    shutdown(): Promise<void>;
  };
  log: (message: string) => void;
};

export class PilotDeckServerShutdownBundle {
  private stopPromise?: Promise<void>;

  constructor(private readonly options: PilotDeckServerShutdownBundleOptions) {}

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopResources();
    return this.stopPromise;
  }

  private async stopResources(): Promise<void> {
    const failures: unknown[] = [];
    await this.stopStep(() => this.options.automation.stop(), failures);
    await this.stopStep(this.options.closeServer, failures);
    await this.stopStep(async () => {
      await this.options.flushChannelState();
      this.options.log(`[telemetry] shutdown snapshot ${JSON.stringify(this.options.telemetry.snapshot())}`);
    }, failures);
    await this.stopStep(() => this.options.disposeGateway(), failures);
    await this.stopStep(() => this.options.telemetry.shutdown(), failures);

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "PilotDeck server shutdown failed.");
    }
  }

  private async stopStep(stop: () => void | Promise<void>, failures: unknown[]): Promise<void> {
    try {
      await stop();
    } catch (error) {
      failures.push(error);
    }
  }
}
