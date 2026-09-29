#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
  type SidecarExecutionFactory,
} from "../agent/modules/index.js";

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

const sidecar = new AgentLoopSidecarServer(factory);
const tcpPort = optionalPort(process.env.PILOTDECK_AGENT_LOOP_TCP_PORT);
if (tcpPort === undefined) {
  await sidecar.serve();
} else {
  const server = new AgentLoopSidecarTcpServer(sidecar);
  await server.listen({
    host: process.env.PILOTDECK_AGENT_LOOP_TCP_HOST?.trim() || "127.0.0.1",
    port: tcpPort,
  });
  await new Promise<void>(() => undefined);
}

function optionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PILOTDECK_AGENT_LOOP_TCP_PORT must be an integer between 1 and 65535.");
  }
  return port;
}
