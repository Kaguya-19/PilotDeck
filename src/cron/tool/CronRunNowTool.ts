import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronRunNowInput, CronRunNowResult } from "../protocol/types.js";
import type { CronControlPort } from "../runtime/CronControlPort.js";

/** Request one immediate run without changing the persisted task schedule. */
export function createCronRunNowTool(runtime: CronControlPort): PilotDeckToolDefinition<CronRunNowInput, CronRunNowResult> {
  return {
    name: "cron_run_now",
    title: "Run Cron Task Now",
    description: "Start one immediate run of a scheduled Cron task without changing its future schedule.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const result = await runtime.runTaskNow({ ...input, projectKey: context.cwd });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
