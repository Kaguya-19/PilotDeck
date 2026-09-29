import type {
  GatewayChannelKey,
  GatewayEvent,
  GatewayMode,
} from "../../gateway/protocol/types.js";

/** The only Gateway operations a cron run may invoke. */
export type CronAgentGatewayPort = {
  submitTurn(input: {
    sessionKey: string;
    channelKey: GatewayChannelKey;
    projectKey?: string;
    message: string;
    mode: GatewayMode;
    runId: string;
    timeoutMs: number;
  }): AsyncIterable<GatewayEvent>;
  abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
};

export type { GatewayEvent };
