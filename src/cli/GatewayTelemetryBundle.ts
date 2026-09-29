import {
  TelemetryObserverRegistry,
  createObservingTelemetryClient,
  createTelemetryCollector,
  type TelemetryClient,
} from "../telemetry/index.js";

export type GatewayTelemetryCollectorFactory = (input: {
  env: Record<string, string | undefined>;
  pilotHome: string;
}) => TelemetryClient;

export type GatewayTelemetryBundleOptions = {
  env: Record<string, string | undefined>;
  pilotHome: string;
  /** An injected client remains owned by the caller. */
  telemetry?: TelemetryClient;
  createCollector?: GatewayTelemetryCollectorFactory;
};

/**
 * Application-owned composition for live telemetry. Durable Session events
 * remain separate; this bundle only owns the observer carrier and a native
 * collector that it created itself.
 */
export class GatewayTelemetryBundle {
  readonly observers = new TelemetryObserverRegistry();
  readonly client: TelemetryClient;
  private readonly base: TelemetryClient;
  private readonly ownsBase: boolean;
  private disposePromise?: Promise<void>;

  constructor(options: GatewayTelemetryBundleOptions) {
    this.ownsBase = options.telemetry === undefined;
    this.base = options.telemetry
      ?? (options.createCollector ?? createTelemetryCollector)({
        env: options.env,
        pilotHome: options.pilotHome,
      });
    this.client = createObservingTelemetryClient(this.base, this.observers);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeResources();
    return this.disposePromise;
  }

  private async disposeResources(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.observers.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (this.ownsBase) {
      try {
        await this.base.shutdown();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose Gateway telemetry.");
    }
  }
}
