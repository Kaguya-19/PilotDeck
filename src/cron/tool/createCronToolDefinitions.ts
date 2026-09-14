import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronControlPort } from "../runtime/CronControlPort.js";
import { createCronCreateTool } from "./CronCreateTool.js";
import { createCronDeleteTool } from "./CronDeleteTool.js";
import { createCronListTool } from "./CronListTool.js";
import { createCronRunNowTool } from "./CronRunNowTool.js";
import { createCronStopTool } from "./CronStopTool.js";
import { createCronUpdateTool } from "./CronUpdateTool.js";

/** Compose all agent-facing Cron consumers from one provider-neutral port. */
export function createCronToolDefinitions(runtime: CronControlPort): PilotDeckToolDefinition[] {
  return [
    createCronCreateTool(runtime),
    createCronListTool(runtime),
    createCronUpdateTool(runtime),
    createCronDeleteTool(runtime),
    createCronStopTool(runtime),
    createCronRunNowTool(runtime),
  ];
}
