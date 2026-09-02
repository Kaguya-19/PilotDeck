#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AgentLoopSidecarServer, type SidecarExecutionFactory } from "../agent/modules/sidecar.js";

const factoryPath = process.env.PILOTDECK_AGENT_LOOP_FACTORY;
let factory: SidecarExecutionFactory | undefined;
if (factoryPath) {
  const loaded = await import(pathToFileURL(isAbsolute(factoryPath) ? factoryPath : resolve(process.cwd(), factoryPath)).href) as {
    default?: SidecarExecutionFactory;
    createSidecarExecution?: SidecarExecutionFactory;
  };
  factory = loaded.default ?? loaded.createSidecarExecution;
} else {
  factory = (await import("./pilotdeck-agent-loop-default-factory.js") as { default: SidecarExecutionFactory }).default;
}
if (!factory) {
  throw new Error("Sidecar factory module must export default or createSidecarExecution.");
}

await new AgentLoopSidecarServer(factory).serve();
