import { resolve } from "node:path";
import type { SessionConfigOverrides } from "../../always-on/runtime/SessionConfigOverrides.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronConfig } from "../config/parseCronConfig.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronRunRecord,
  CronResultDeliveryHandler,
  CronStopInput,
  CronStopResult,
  CronTask,
  CronUpdateInput,
  CronUpdateResult,
} from "../protocol/types.js";
import { createCronToolDefinitions } from "../tool/createCronToolDefinitions.js";
import { CronRuntime, type CronRuntimeLogger } from "./CronRuntime.js";
import type { CronTurnEventHandler } from "./CronFire.js";
import type { CronControlPort } from "./CronControlPort.js";
import type { CronAgentGatewayPort } from "./CronAgentGatewayPort.js";
import {
  createNativeCronProjectStorageProvider,
  type CronProjectStorageProvider,
} from "./CronProjectStorageProvider.js";

export type CreateCronManagerOptions = {
  config: CronConfig;
  pilotHome: string;
  sessionOverrides?: SessionConfigOverrides;
  now?: () => Date;
  uuid?: () => string;
  logger?: CronRuntimeLogger;
  telemetry?: TelemetryClient;
  onResultDelivery?: CronResultDeliveryHandler;
  onTurnEvent?: CronTurnEventHandler;
  /** Application-selected provider for each project's Cron durable records. */
  cronStorageProvider?: CronProjectStorageProvider;
};

/** Native multi-project CronControlPort provider and lifecycle owner. */
export class CronManager implements CronControlPort {
  readonly config: CronConfig;

  private readonly pilotHome: string;
  private readonly runtimes = new Map<string, CronRuntime>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly tools: PilotDeckToolDefinition[];
  private readonly cronStorageProvider: CronProjectStorageProvider;
  private agentGateway?: CronAgentGatewayPort;
  private started = false;

  constructor(private readonly options: CreateCronManagerOptions) {
    this.config = options.config;
    this.pilotHome = resolve(options.pilotHome);
    this.cronStorageProvider = options.cronStorageProvider ?? createNativeCronProjectStorageProvider();
    this.tools = createCronToolDefinitions(this);
  }

  getTools(): PilotDeckToolDefinition[] {
    return this.config.enabled ? [...this.tools] : [];
  }

  bindAgentGateway(agentGateway: CronAgentGatewayPort): void {
    if (this.agentGateway) {
      throw new Error("CronManager.bindAgentGateway already called.");
    }
    this.agentGateway = agentGateway;
  }

  /** @deprecated Use bindAgentGateway; the parameter is intentionally only the turn facade. */
  bindGateway(agentGateway: CronAgentGatewayPort): void {
    this.bindAgentGateway(agentGateway);
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.options.logger?.info("cron disabled in config; manager is a no-op.");
      return;
    }
    if (!this.agentGateway) {
      throw new Error("CronManager.start called before bindAgentGateway.");
    }
    await this.cronStorageProvider.migrateLegacy({
      pilotHome: this.pilotHome,
      logger: this.options.logger,
    });
    this.started = true;
    const projectKeys = await this.cronStorageProvider.listProjectKeys({
      pilotHome: this.pilotHome,
      logger: this.options.logger,
    });
    for (const projectKey of projectKeys) {
      await this.ensureRuntime(projectKey);
    }
    this.options.logger?.info("cron manager started", { projectCount: this.runtimes.size });
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.starting.values()].map((pending) => pending.catch(() => undefined)));
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    this.runtimes.clear();
    this.starting.clear();
  }

  async createTask(input: CronCreateInput): Promise<CronCreateResult> {
    const projectKey = requireProjectKey(input.projectKey);
    const runtime = await this.ensureRuntime(projectKey);
    return runtime.createTask({ ...input, projectKey });
  }

  async listTasks(input: CronListInput = {}): Promise<CronListResult> {
    if (input.projectKey) {
      const runtime = await this.ensureRuntime(input.projectKey);
      return runtime.listTasks(input);
    }
    const tasks: CronTask[] = [];
    const runs: CronRunRecord[] = [];
    for (const runtime of this.runtimes.values()) {
      const result = await runtime.listTasks(input);
      tasks.push(...result.tasks);
      if (result.recentRuns) runs.push(...result.recentRuns);
    }
    const result: CronListResult = {
      tasks: tasks.sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "")),
    };
    if (input.includeHistory) {
      result.recentRuns = runs
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, input.limit ?? 50);
    }
    return result;
  }

  async updateTask(input: CronUpdateInput): Promise<CronUpdateResult> {
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { updated: false, reason: "not_found" };
    return runtime.updateTask(input);
  }

  async deleteTask(input: CronDeleteInput): Promise<CronDeleteResult> {
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { deleted: false };
    return runtime.deleteTask(input);
  }

  async stopTask(input: CronStopInput): Promise<CronStopResult> {
    const runtime = await this.resolveStopRuntime(input);
    if (!runtime) {
      return { stopped: false, taskId: input.taskId, runId: input.runId };
    }
    return runtime.stopTask(input);
  }

  async runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { started: false, reason: "not_found" };
    return runtime.runTaskNow(input);
  }

  /** Public for tests; runs one scheduler tick for one or all loaded projects. */
  async runTickOnce(projectKey?: string): Promise<void> {
    if (projectKey) {
      await (await this.ensureRuntime(projectKey)).runTickOnce();
      return;
    }
    for (const runtime of this.runtimes.values()) {
      await runtime.runTickOnce();
    }
  }

  private async ensureRuntime(projectKeyInput: string): Promise<CronRuntime> {
    const projectKey = resolve(projectKeyInput);
    const existing = this.runtimes.get(projectKey);
    if (existing) {
      await this.starting.get(projectKey);
      return existing;
    }

    const runtime = new CronRuntime({
      config: this.config,
      pilotHome: this.pilotHome,
      projectKey,
      sessionOverrides: this.options.sessionOverrides,
      now: this.options.now,
      uuid: this.options.uuid,
      logger: this.options.logger,
      telemetry: this.options.telemetry,
      onResultDelivery: this.options.onResultDelivery,
      onTurnEvent: this.options.onTurnEvent,
      activeRunCount: () => this.activeRunCount(),
      cronStorageProvider: this.cronStorageProvider,
      skipToolCreation: true,
    });
    if (this.agentGateway) runtime.bindAgentGateway(this.agentGateway);
    this.runtimes.set(projectKey, runtime);
    await this.cronStorageProvider.recordProjectKey({
      pilotHome: this.pilotHome,
      projectKey,
    });

    if (this.started) {
      const pending = runtime.start().finally(() => this.starting.delete(projectKey));
      this.starting.set(projectKey, pending);
      await pending;
    }
    return runtime;
  }

  private activeRunCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      count += runtime.getActiveRunCount();
    }
    return count;
  }

  private async resolveTaskRuntime(
    taskId: string,
    projectKey?: string,
  ): Promise<CronRuntime | undefined> {
    if (projectKey) {
      const runtime = await this.ensureRuntime(projectKey);
      return (await runtime.listTasks()).tasks.some((task) => task.taskId === taskId)
        ? runtime
        : undefined;
    }
    const matches: CronRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      if ((await runtime.listTasks()).tasks.some((task) => task.taskId === taskId)) {
        matches.push(runtime);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Cron task id is ambiguous across projects: ${taskId}`);
    }
    return matches[0];
  }

  private async resolveStopRuntime(input: CronStopInput): Promise<CronRuntime | undefined> {
    if (input.projectKey) {
      return this.ensureRuntime(input.projectKey);
    }
    const matches: CronRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      const tasks = (await runtime.listTasks()).tasks;
      if (tasks.some((task) =>
        (input.taskId && task.taskId === input.taskId)
        || (input.runId && task.lastRunId === input.runId))) {
        matches.push(runtime);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Cron run identifier is ambiguous across projects: ${input.runId ?? input.taskId}`);
    }
    return matches[0];
  }
}

export function createCronManager(options: CreateCronManagerOptions): CronManager {
  return new CronManager(options);
}

function requireProjectKey(projectKey: string | undefined): string {
  if (!projectKey?.trim()) {
    throw new Error("Cron task creation requires a projectKey.");
  }
  return resolve(projectKey);
}
