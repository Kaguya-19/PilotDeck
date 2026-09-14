import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { parseSubagentDescriptor } from "./SubagentDescriptor.js";

export const SUBAGENT_DESCRIPTOR_METADATA_KEY = "pilotdeck.subagentDescriptor";

/** Persist the model-hidden descriptor immediately before the first visible child input. */
export async function recordSubagentAcceptedInputWithDescriptor(
  writer: AgentTranscriptWriter,
  sessionId: string,
  turnId: string,
  messages: CanonicalMessage[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  const rawDescriptor = metadata?.[SUBAGENT_DESCRIPTOR_METADATA_KEY];
  if (rawDescriptor !== undefined) {
    const descriptor = parseSubagentDescriptor(rawDescriptor);
    if (!descriptor) {
      throw new Error("Subagent descriptor version is not supported by this runtime.");
    }
    await writer.recordSessionEvent(sessionId, turnId, {
      type: "subagent_descriptor",
      descriptor,
    });
  }
  const acceptedMetadata = metadata
    ? Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== SUBAGENT_DESCRIPTOR_METADATA_KEY),
      )
    : undefined;
  await writer.recordAcceptedInput(
    sessionId,
    turnId,
    messages,
    acceptedMetadata && Object.keys(acceptedMetadata).length > 0 ? acceptedMetadata : undefined,
  );
}
