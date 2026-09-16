import type { AgentEvent } from "../../agent/index.js";
import type { GatewayEvent } from "../protocol/types.js";

/** Canonical input for one Agent-to-Gateway live-event projection. */
export type GatewayAgentEventProjectionInput = {
  event: AgentEvent;
  runId: string;
  forwardSubagentText?: boolean;
};

/**
 * Definition consumed by the Gateway streaming loop.
 *
 * It projects already-produced Agent events into host-visible Gateway events.
 * It does not own the turn, Session durable record, replay buffer, Router, or
 * telemetry lifecycle that consumes the projected result.
 */
export type GatewayAgentEventProjectorPort = {
  project(input: GatewayAgentEventProjectionInput): GatewayEvent[];
};
