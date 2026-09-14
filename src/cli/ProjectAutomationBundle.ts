import {
  createAlwaysOnManager,
  createStandaloneAlwaysOnControl,
  SessionConfigOverrides,
  type AlwaysOnAgentGatewayPort,
  type AlwaysOnConfig,
  type AlwaysOnControlPort,
  type AlwaysOnProjectStorageProvider,
  type CreateAlwaysOnManagerOptions,
  type CreateStandaloneAlwaysOnControlDeps,
} from "../always-on/index.js";
import {
  createCronManager,
  type CreateCronManagerOptions,
  type CronAgentGatewayPort,
  type CronConfig,
  type CronControlPort,
  type CronProjectStorageProvider,
} from "../cron/index.js";
import type { TelemetryClient } from "../telemetry/index.js";
import type { PilotDeckToolDefinition } from "../tool/index.js";
import {
  createProjectSessionReadSideBundle,
  type ProjectSessionStorageProvider,
  type SessionCatalogPort,
  type SessionTranscriptReaderPort,
} from "../session/index.js";
import type { SubsystemUpdate } from "./createLocalGateway.js";

/** The parts of PilotConfig that belong to project automation providers. */
export type ProjectAutomationConfig = {
  alwaysOn?: AlwaysOnConfig;
  cron?: CronConfig;
};

/**
 * The application-facing lifecycle surface of the native Always-On provider.
 * Its scheduler, stores, and active-run cleanup remain provider-owned.
 */
export type ProjectAutomationAlwaysOnProvider = AlwaysOnControlPort & {
  getTools(): PilotDeckToolDefinition[];
  bindAgentGateway(
    agentGateway: AlwaysOnAgentGatewayPort,
    hooks?: { isProjectBusy?: (projectKey: string) => boolean },
  ): void;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * The application-facing lifecycle surface of the native Cron provider.
 * It deliberately exposes neither its scheduler nor storage internals.
 */
export type ProjectAutomationCronProvider = CronControlPort & {
  getTools(): PilotDeckToolDefinition[];
  bindAgentGateway(agentGateway: CronAgentGatewayPort): void;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type ProjectAutomationAgentGateway = AlwaysOnAgentGatewayPort & CronAgentGatewayPort;

export type ProjectAutomationAttachment = {
  agentGateway: ProjectAutomationAgentGateway;
  isProjectBusy?: (projectKey: string) => boolean;
  updateSubsystems: (update: SubsystemUpdate) => void;
};

export type ProjectAutomationInitialGatewayOptions = {
  extraTools: PilotDeckToolDefinition[];
  sessionOverrides: SessionConfigOverrides;
  cron?: CronControlPort;
};

export type ProjectAutomationReloadInput = {
  config: ProjectAutomationConfig;
  alwaysOnChanged: boolean;
  cronChanged: boolean;
};

export type ProjectAutomationStatus = {
  alwaysOn: boolean;
  cron: boolean;
};

export type ProjectAutomationBundleOptions = {
  config: ProjectAutomationConfig;
  pilotHome: string;
  sessionOverrides?: SessionConfigOverrides;
  telemetry?: TelemetryClient;
  alwaysOnLogger?: CreateAlwaysOnManagerOptions["logger"];
  cronLogger?: CreateCronManagerOptions["logger"];
  onWorktreeCreated?: CreateAlwaysOnManagerOptions["onWorktreeCreated"];
  onWorktreeRemoved?: CreateAlwaysOnManagerOptions["onWorktreeRemoved"];
  onAlwaysOnTurnEvent?: CreateAlwaysOnManagerOptions["onTurnEvent"];
  onCronTurnEvent?: CreateCronManagerOptions["onTurnEvent"];
  onCronResultDelivery?: CreateCronManagerOptions["onResultDelivery"];
  /** Application-selected durable backend used by default read-side providers. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Shared with Gateway when an application selects one session catalog provider. */
  sessionCatalog?: SessionCatalogPort;
  /** Shared with Always-On when an application selects one durable transcript reader. */
  sessionTranscriptReader?: SessionTranscriptReaderPort;
  /** Application-selected provider for each enabled project's Always-On records. */
  alwaysOnStorageProvider?: AlwaysOnProjectStorageProvider;
  /** Application-selected provider for each enabled project's Cron durable records. */
  cronStorageProvider?: CronProjectStorageProvider;
  /** Test/composition override. The default is the native Always-On provider. */
  createAlwaysOnManager?: (options: CreateAlwaysOnManagerOptions) => ProjectAutomationAlwaysOnProvider;
  /** Test/composition override. The default is the native Cron provider. */
  createCronManager?: (options: CreateCronManagerOptions) => ProjectAutomationCronProvider;
  /** Test/composition override for the no-Always-On control provider. */
  createStandaloneAlwaysOnControl?: (deps: CreateStandaloneAlwaysOnControlDeps) => AlwaysOnControlPort;
};

type ProjectAutomationGeneration = {
  config: ProjectAutomationConfig;
  alwaysOn?: ProjectAutomationAlwaysOnProvider;
  cron?: ProjectAutomationCronProvider;
};

type ProjectAutomationChanges = Pick<ProjectAutomationReloadInput, "alwaysOnChanged" | "cronChanged">;

/**
 * Application-owned bundle for project automation providers.
 *
 * It owns only composition generations and lifecycle order. Native managers
 * retain their scheduler, storage, active-run, and drain ownership; Gateway
 * remains a narrow-port consumer.
 */
export class ProjectAutomationBundle {
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly sessionCatalog: SessionCatalogPort;
  private readonly sessionTranscriptReader: SessionTranscriptReaderPort;
  private readonly makeAlwaysOn: (options: CreateAlwaysOnManagerOptions) => ProjectAutomationAlwaysOnProvider;
  private readonly makeCron: (options: CreateCronManagerOptions) => ProjectAutomationCronProvider;
  private readonly makeStandaloneAlwaysOnControl: (deps: CreateStandaloneAlwaysOnControlDeps) => AlwaysOnControlPort;
  private generation: ProjectAutomationGeneration;
  private attachment?: ProjectAutomationAttachment;
  private started = false;

  constructor(private readonly options: ProjectAutomationBundleOptions) {
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    const readSide = createProjectSessionReadSideBundle(options);
    this.sessionCatalog = readSide.catalog;
    this.sessionTranscriptReader = readSide.transcriptReader;
    this.makeAlwaysOn = options.createAlwaysOnManager ?? createAlwaysOnManager;
    this.makeCron = options.createCronManager ?? createCronManager;
    this.makeStandaloneAlwaysOnControl = options.createStandaloneAlwaysOnControl ?? createStandaloneAlwaysOnControl;
    this.generation = this.stage(options.config);
  }

  /** Static contribution needed while `createLocalGateway()` builds its first project runtime. */
  getInitialGatewayOptions(): ProjectAutomationInitialGatewayOptions {
    return {
      extraTools: this.getTools(this.generation),
      sessionOverrides: this.sessionOverrides,
      cron: this.generation.cron,
    };
  }

  /** Attach the only turn facade consumed by native automation providers. */
  attach(attachment: ProjectAutomationAttachment): void {
    if (this.attachment) {
      throw new Error("ProjectAutomationBundle.attach may only be called once.");
    }
    this.attachment = attachment;
    this.bindGeneration(this.generation, { alwaysOnChanged: true, cronChanged: true });
  }

  /** Start providers in dependency order, publishing only an all-started generation. */
  async start(): Promise<ProjectAutomationStatus> {
    if (this.started) return this.status(this.generation);
    this.requireAttachment();
    try {
      await this.startGeneration(this.generation, { alwaysOnChanged: true, cronChanged: true });
    } catch (error) {
      const cleanupError = await this.stopGeneration(this.generation, { alwaysOnChanged: true, cronChanged: true });
      throw combineFailure("Project automation startup failed.", error, cleanupError);
    }
    this.started = true;
    this.publishGeneration(this.generation);
    return this.status(this.generation);
  }

  /**
   * Replace changed provider families without making Gateway or SessionRuntime
   * an owner of their business state. Build failures leave the prior generation
   * untouched; start failures rebuild and restore the prior changed providers.
   */
  async reload(input: ProjectAutomationReloadInput): Promise<ProjectAutomationStatus> {
    const changes: ProjectAutomationChanges = {
      alwaysOnChanged: input.alwaysOnChanged,
      cronChanged: input.cronChanged,
    };
    if (!changes.alwaysOnChanged && !changes.cronChanged) {
      return this.status(this.generation);
    }

    const previous = this.generation;
    // Construction is intentionally effect-free. A malformed new config cannot
    // tear down a working provider generation.
    const candidate = this.stage(input.config, previous, changes);

    if (!this.started) {
      this.generation = candidate;
      if (this.attachment) this.bindGeneration(candidate, changes);
      return this.status(candidate);
    }

    this.requireAttachment();
    // Stop forwarding Gateway controls to a provider that is about to drain.
    this.publishGeneration({
      config: input.config,
      alwaysOn: changes.alwaysOnChanged ? undefined : previous.alwaysOn,
      cron: changes.cronChanged ? undefined : previous.cron,
    });

    const previousStopError = await this.stopGeneration(previous, changes);
    if (previousStopError) {
      throw new AggregateError(
        [previousStopError],
        "Project automation reload could not stop the previous generation; no replacement was started.",
      );
    }

    try {
      this.bindGeneration(candidate, changes);
      await this.startGeneration(candidate, changes);
      this.generation = candidate;
      this.publishGeneration(candidate);
      return this.status(candidate);
    } catch (error) {
      const candidateStopError = await this.stopGeneration(candidate, changes);
      try {
        const restored = this.stage(previous.config, previous, changes);
        this.bindGeneration(restored, changes);
        await this.startGeneration(restored, changes);
        this.generation = restored;
        this.publishGeneration(restored);
      } catch (restoreError) {
        this.generation = {
          config: input.config,
          alwaysOn: changes.alwaysOnChanged ? undefined : previous.alwaysOn,
          cron: changes.cronChanged ? undefined : previous.cron,
        };
        this.publishGeneration(this.generation);
        throw combineFailure(
          "Project automation reload failed and the previous generation could not be restored.",
          error,
          candidateStopError,
          restoreError,
        );
      }
      throw combineFailure("Project automation reload failed; the previous generation was restored.", error, candidateStopError);
    }
  }

  /** Stop in reverse dependency order and remove Gateway control consumers. */
  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      const stopError = await this.stopGeneration(this.generation, { alwaysOnChanged: true, cronChanged: true });
      if (stopError) throw stopError;
    } finally {
      this.started = false;
      this.unpublish();
    }
  }

  private stage(
    config: ProjectAutomationConfig,
    previous?: ProjectAutomationGeneration,
    changes: ProjectAutomationChanges = { alwaysOnChanged: true, cronChanged: true },
  ): ProjectAutomationGeneration {
    return {
      config,
      alwaysOn: previous && !changes.alwaysOnChanged
        ? previous.alwaysOn
        : this.createAlwaysOn(config.alwaysOn),
      cron: previous && !changes.cronChanged
        ? previous.cron
        : this.createCron(config.cron),
    };
  }

  private createAlwaysOn(config: AlwaysOnConfig | undefined): ProjectAutomationAlwaysOnProvider | undefined {
    if (!config || !Object.values(config.projects).some((project) => project.enabled)) return undefined;
    return this.makeAlwaysOn({
      config,
      pilotHome: this.options.pilotHome,
      sessionOverrides: this.sessionOverrides,
      logger: this.options.alwaysOnLogger,
      telemetry: this.options.telemetry,
      onWorktreeCreated: this.options.onWorktreeCreated,
      onWorktreeRemoved: this.options.onWorktreeRemoved,
      onTurnEvent: this.options.onAlwaysOnTurnEvent,
      sessionCatalog: this.sessionCatalog,
      sessionTranscriptReader: this.sessionTranscriptReader,
      alwaysOnStorageProvider: this.options.alwaysOnStorageProvider,
    });
  }

  private createCron(config: CronConfig | undefined): ProjectAutomationCronProvider | undefined {
    if (!config) return undefined;
    return this.makeCron({
      config,
      pilotHome: this.options.pilotHome,
      sessionOverrides: this.sessionOverrides,
      logger: this.options.cronLogger,
      telemetry: this.options.telemetry,
      onTurnEvent: this.options.onCronTurnEvent,
      onResultDelivery: this.options.onCronResultDelivery,
      cronStorageProvider: this.options.cronStorageProvider,
    });
  }

  private bindGeneration(generation: ProjectAutomationGeneration, changes: ProjectAutomationChanges): void {
    const attachment = this.requireAttachment();
    if (changes.alwaysOnChanged && generation.alwaysOn) {
      generation.alwaysOn.bindAgentGateway(attachment.agentGateway, { isProjectBusy: attachment.isProjectBusy });
    }
    if (changes.cronChanged && generation.cron) {
      generation.cron.bindAgentGateway(attachment.agentGateway);
    }
  }

  private async startGeneration(generation: ProjectAutomationGeneration, changes: ProjectAutomationChanges): Promise<void> {
    if (changes.alwaysOnChanged && generation.alwaysOn) await generation.alwaysOn.start();
    if (changes.cronChanged && generation.cron) await generation.cron.start();
  }

  /** Stops Cron before Always-On so producer dependencies drain in reverse startup order. */
  private async stopGeneration(
    generation: ProjectAutomationGeneration,
    changes: ProjectAutomationChanges,
  ): Promise<unknown | undefined> {
    const failures: unknown[] = [];
    if (changes.cronChanged && generation.cron) {
      try {
        await generation.cron.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (changes.alwaysOnChanged && generation.alwaysOn) {
      try {
        await generation.alwaysOn.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) return undefined;
    if (failures.length === 1) return failures[0];
    return new AggregateError(failures, "Project automation provider cleanup failed.");
  }

  private publishGeneration(generation: ProjectAutomationGeneration): void {
    const attachment = this.requireAttachment();
    attachment.updateSubsystems({
      extraTools: this.getTools(generation),
      sessionOverrides: this.sessionOverrides,
      cron: generation.cron,
      alwaysOnControl: generation.alwaysOn ?? this.createFallbackAlwaysOnControl(generation.config),
    });
  }

  private unpublish(): void {
    if (!this.attachment) return;
    this.attachment.updateSubsystems({
      extraTools: [],
      sessionOverrides: this.sessionOverrides,
      cron: undefined,
      alwaysOnControl: undefined,
    });
  }

  private createFallbackAlwaysOnControl(config: ProjectAutomationConfig): AlwaysOnControlPort {
    const attachment = this.requireAttachment();
    return this.makeStandaloneAlwaysOnControl({
      agentGateway: attachment.agentGateway,
      pilotHome: this.options.pilotHome,
      sessionOverrides: this.sessionOverrides,
      alwaysOnConfig: config.alwaysOn,
      telemetry: this.options.telemetry,
      onTurnEvent: this.options.onAlwaysOnTurnEvent,
      alwaysOnStorageProvider: this.options.alwaysOnStorageProvider,
      sessionCatalog: this.sessionCatalog,
      sessionTranscriptReader: this.sessionTranscriptReader,
    });
  }

  private getTools(generation: ProjectAutomationGeneration): PilotDeckToolDefinition[] {
    return [
      ...(generation.alwaysOn?.getTools() ?? []),
      ...(generation.cron?.getTools() ?? []),
    ];
  }

  private status(generation: ProjectAutomationGeneration): ProjectAutomationStatus {
    return { alwaysOn: generation.alwaysOn !== undefined, cron: generation.cron !== undefined };
  }

  private requireAttachment(): ProjectAutomationAttachment {
    if (!this.attachment) throw new Error("ProjectAutomationBundle must attach an agent gateway before lifecycle operations.");
    return this.attachment;
  }
}

export function createProjectAutomationBundle(options: ProjectAutomationBundleOptions): ProjectAutomationBundle {
  return new ProjectAutomationBundle(options);
}

function combineFailure(message: string, ...errors: Array<unknown | undefined>): Error {
  const failures = errors.filter((error): error is unknown => error !== undefined);
  return new AggregateError(failures, message);
}
