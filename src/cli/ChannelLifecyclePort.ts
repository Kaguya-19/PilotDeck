import type { ChannelAdapter } from "../adapters/index.js";
import type { GatewayChannelKey } from "../gateway/index.js";

/**
 * Application-facing channel lifecycle definition.
 *
 * The server owns live channel handles. Composition providers only describe
 * the desired adapter set and never retain handles or Gateway session state.
 */
export type ChannelLifecycleReconcileInput = {
  channels: readonly ChannelAdapter[];
  managedChannelKeys: readonly GatewayChannelKey[];
};

export type ChannelLifecycleReconcileResult = {
  started: GatewayChannelKey[];
  stopped: GatewayChannelKey[];
};

export interface ChannelLifecyclePort {
  hotStartChannel(channel: ChannelAdapter): Promise<void>;
  reconcileChannels(input: ChannelLifecycleReconcileInput): Promise<ChannelLifecycleReconcileResult>;
}
