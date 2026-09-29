import type { AgentInput } from "../../agent/index.js";
import type { ChannelAttachment } from "../protocol/types.js";

/** Canonical model input and read-file allow-list for one Gateway turn message. */
export type GatewayAttachmentTurnComposition = {
  agentInput: AgentInput;
  allowedReadFiles: string[];
};

/** Input accepted by the Gateway attachment turn-composition Definition. */
export type GatewayAttachmentTurnComposerInput = {
  message: string;
  attachments?: ChannelAttachment[];
  projectRoot?: string;
  funasrInstallCommand?: string;
};

/**
 * Definition consumed by Gateway submit and steer admission.
 *
 * The provider only projects accepted attachments into model input. Upload
 * artifact lifetime remains owned by the Gateway turn that acquired it.
 */
export type GatewayAttachmentTurnComposerPort = {
  prepare(input: GatewayAttachmentTurnComposerInput): Promise<GatewayAttachmentTurnComposition>;
};
