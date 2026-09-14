import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../protocol/types.js";

/**
 * Provider-neutral schedule control capability.
 *
 * It intentionally excludes Gateway binding, scheduler/store ownership, and
 * lifecycle methods. Those remain owned by the project-level cron provider.
 */
export type CronControlPort = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input?: CronListInput): Promise<CronListResult>;
  updateTask(input: CronUpdateInput): Promise<CronUpdateResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
  runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult>;
};
