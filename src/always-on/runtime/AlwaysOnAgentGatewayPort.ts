import type {
  GatewayChannelKey,
  GatewayEvent,
  GatewayMode,
} from "../../gateway/protocol/types.js";

/** The only turn lifecycle surface an Always-On run may use. */
export type AlwaysOnAgentGatewayPort = {
  submitTurn(input: {
    sessionKey: string;
    channelKey: GatewayChannelKey;
    message: string;
    projectKey: string;
    mode: GatewayMode;
    runId: string;
    telemetry: {
      ownerModule: "always_on";
      executionKind: "always_on";
      phase?: string;
    };
  }): AsyncIterable<GatewayEvent>;
  abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
};

export type { GatewayChannelKey, GatewayEvent };
