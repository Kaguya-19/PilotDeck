import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronListInput, CronListResult } from "../protocol/types.js";
import type { CronControlPort } from "../runtime/CronControlPort.js";

export function createCronListTool(runtime: CronControlPort): PilotDeckToolDefinition<CronListInput, CronListResult> {
  return {
    name: "cron_list",
    title: "List Cron Tasks",
    description: "List scheduled Cron tasks and optionally recent Cron run history.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeHistory: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const result = await runtime.listTasks({
        ...(input ?? {}),
        projectKey: context.cwd,
      });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
