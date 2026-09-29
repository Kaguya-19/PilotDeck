import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { migrateCronStores } from "../storage/CronStoreMigration.js";
import { resolveCronPaths, type CronPaths } from "../storage/CronPaths.js";
import { CronTaskStore } from "../storage/CronTaskStore.js";

/** Operations the Cron runtime, scheduler, and run projection actually consume. */
export type CronTaskStorePort = Pick<
  CronTaskStore,
  | "listTasks"
  | "putTask"
  | "updateTask"
  | "deleteTask"
  | "appendRun"
  | "listRuns"
  | "appendRunEvent"
>;

export type CronProjectStorageProviderInput = {
  pilotHome: string;
  projectKey: string;
};

export type CronProjectStorage = {
  paths: CronPaths;
  taskStore: CronTaskStorePort;
};

export type CronProjectStorageLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

/**
 * Project durable-record Definition for Cron.
 *
 * The provider owns storage selection, legacy migration, and restart-time
 * project discovery. Scheduler timing, active runs, Gateway turns, and
 * session overrides stay in CronRuntime/CronManager.
 */
export type CronProjectStorageProvider = {
  create(input: CronProjectStorageProviderInput): CronProjectStorage;
  migrateLegacy(input: { pilotHome: string; logger?: CronProjectStorageLogger }): Promise<void>;
  listProjectKeys(input: { pilotHome: string; logger?: CronProjectStorageLogger }): Promise<string[]>;
  recordProjectKey(input: CronProjectStorageProviderInput): Promise<void>;
};

/** Native filesystem provider preserving the existing Cron file layout. */
export function createNativeCronProjectStorageProvider(): CronProjectStorageProvider {
  return {
    create(input) {
      const paths = resolveCronPaths(input);
      return { paths, taskStore: new CronTaskStore(paths) };
    },
    async migrateLegacy(input) {
      await migrateCronStores(input);
    },
    async listProjectKeys(input) {
      return discoverNativeCronProjectKeys(input.pilotHome, input.logger);
    },
    async recordProjectKey(input) {
      const paths = resolveCronPaths(input);
      await mkdir(paths.projectDir, { recursive: true });
      await writeFile(resolve(paths.projectDir, ".cwd"), `${resolve(input.projectKey)}\n`, "utf-8");
    },
  };
}

async function discoverNativeCronProjectKeys(
  pilotHome: string,
  logger?: CronProjectStorageLogger,
): Promise<string[]> {
  const projectsDir = resolve(pilotHome, "cron", "projects");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const projectKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = resolve(projectsDir, entry.name);
    await collectProjectKeysFromTasks(projectDir, projectKeys, logger);
    await collectProjectKeysFromRuns(projectDir, projectKeys, logger);
    try {
      const marker = (await readFile(resolve(projectDir, ".cwd"), "utf-8")).trim();
      if (marker) projectKeys.add(resolve(marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...projectKeys].sort();
}

async function collectProjectKeysFromTasks(
  projectDir: string,
  projectKeys: Set<string>,
  logger?: CronProjectStorageLogger,
): Promise<void> {
  try {
    const raw = await readFile(resolve(projectDir, "tasks.json"), "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: Array<{ projectKey?: unknown }> };
    for (const task of parsed.tasks ?? []) {
      if (typeof task.projectKey === "string" && task.projectKey.trim()) {
        projectKeys.add(resolve(task.projectKey));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger?.warn("cron project discovery skipped unreadable task store", {
        projectDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function collectProjectKeysFromRuns(
  projectDir: string,
  projectKeys: Set<string>,
  logger?: CronProjectStorageLogger,
): Promise<void> {
  try {
    const raw = await readFile(resolve(projectDir, "run-history.jsonl"), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as { projectKey?: unknown };
        if (typeof run.projectKey === "string" && run.projectKey.trim()) {
          projectKeys.add(resolve(run.projectKey));
        }
      } catch {
        // Preserve unreadable migration leftovers while scanning valid lines.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger?.warn("cron project discovery skipped unreadable run history", {
        projectDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
