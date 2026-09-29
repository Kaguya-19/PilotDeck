import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronUpdateInput, CronUpdateResult } from "../protocol/types.js";
import { CRON_TASK_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronControlPort } from "../runtime/CronControlPort.js";

/** Update a scheduled task with optimistic revision control. */
export function createCronUpdateTool(runtime: CronControlPort): PilotDeckToolDefinition<CronUpdateInput, CronUpdateResult> {
  return {
    name: "cron_update",
    title: "Update Cron Task",
    description: "Update the message or schedule of a scheduled Cron task. Use cron_list first to obtain the task revision. Updates to running tasks are rejected.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["taskId", "expectedRevision", "message", "schedule"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        expectedRevision: { type: "number", minimum: 0 },
        message: { type: "string" },
        schedule: CRON_TASK_SCHEDULE_SCHEMA,
        timezone: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const result = await runtime.updateTask({ ...input, projectKey: context.cwd });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
