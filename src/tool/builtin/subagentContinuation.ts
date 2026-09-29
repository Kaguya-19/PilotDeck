import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

/** Consumer-facing continuation port. It deliberately hides manager/provider/host/storage details. */
export type SubagentContinuationPort = {
  start(request: SubagentStartPortRequest): Promise<SubagentContinuationAdmission>;
  followup(request: SubagentFollowupPortRequest): Promise<SubagentContinuationAdmission>;
};

export type SubagentContinuationAdmission = {
  childSessionId: string;
  itemId: string;
  turnId: string;
};

export type SubagentStartPortRequest = {
  label: string;
  definitionId?: string;
  prompt: string;
  abortSignal?: AbortSignal;
};

export type SubagentFollowupPortRequest = {
  childSessionId: string;
  message: string;
  abortSignal?: AbortSignal;
};

export type SubagentAdmissionToolOutput = {
  subagentId: string;
  messageId: string;
  turnId: string;
};

const SUBAGENT_DEFINITION_IDS = ["general-purpose", "explore", "plan", "verify"] as const;

export function createSubagentContinuationTool(
  port: SubagentContinuationPort,
): PilotDeckToolDefinition<
  { description: string; prompt: string; subagent_type?: string },
  SubagentAdmissionToolOutput
> {
  return {
    name: "subagent",
    aliases: ["continuable_subagent"],
    description: `Start a continuable background subagent. Available types: ${SUBAGENT_DEFINITION_IDS.join(", ")}. The call returns after the initial message is durably admitted.`,
    kind: "agent",
    requiredRuntimeCapabilities: ["subagent_fork"],
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      additionalProperties: false,
      properties: {
        description: { type: "string", description: "Short label for the delegated task." },
        prompt: { type: "string", description: "Initial directive for the background subagent." },
        subagent_type: {
          type: "string",
          description: `Subagent definition. Available: ${SUBAGENT_DEFINITION_IDS.join(", ")}.`,
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["subagentId", "messageId", "turnId"],
      additionalProperties: false,
      properties: {
        subagentId: { type: "string" },
        messageId: { type: "string" },
        turnId: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input, context) => {
      const definitionId = input.subagent_type ?? "general-purpose";
      const admission = await port.start({
        label: input.description,
        definitionId,
        prompt: input.prompt,
        abortSignal: context.abortSignal,
      });
      return admissionOutput(admission);
    },
  };
}

export function createSendMessageTool(
  port: SubagentContinuationPort,
): PilotDeckToolDefinition<
  { subagent_id: string; message: string },
  SubagentAdmissionToolOutput
> {
  return {
    name: "send_message",
    description: "Send a follow-up message to a continuable subagent. The call returns after durable admission.",
    kind: "agent",
    requiredRuntimeCapabilities: ["subagent_fork"],
    inputSchema: {
      type: "object",
      required: ["subagent_id", "message"],
      additionalProperties: false,
      properties: {
        subagent_id: { type: "string", description: "Stable continuable subagent id." },
        message: { type: "string", description: "Message to enqueue for the subagent." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["subagentId", "messageId", "turnId"],
      additionalProperties: false,
      properties: {
        subagentId: { type: "string" },
        messageId: { type: "string" },
        turnId: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input, context) => {
      const admission = await port.followup({
        childSessionId: input.subagent_id,
        message: input.message,
        abortSignal: context.abortSignal,
      });
      return admissionOutput(admission);
    },
  };
}

function admissionOutput(admission: SubagentContinuationAdmission): PilotDeckToolExecutionOutput<SubagentAdmissionToolOutput> {
  return {
    data: {
      subagentId: admission.childSessionId,
      messageId: admission.itemId,
      turnId: admission.turnId,
    },
    content: [{
      type: "text",
      text: `accepted message ${admission.itemId} for subagent ${admission.childSessionId}`,
    }],
  };
}
