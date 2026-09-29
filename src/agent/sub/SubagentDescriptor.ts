import type {
  AgentContinuableSubagentDescriptorData,
  AgentOneShotSubagentDescriptorData,
  AgentSubagentDescriptorData,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";

/** Existing one-shot descriptor version retained for log compatibility. */
export const SUBAGENT_DESCRIPTOR_VERSION = 1;
export const SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION = 2;

export type OneShotSubagentDescriptorData = AgentOneShotSubagentDescriptorData;
export type ContinuableSubagentDescriptorData = AgentContinuableSubagentDescriptorData;
export type SubagentDescriptorData = AgentSubagentDescriptorData;

export type OneShotSubagentDescriptorInput = {
  mode: "one-shot";
  provider: string;
  definitionId: string;
};

export type ContinuableSubagentDescriptorInput = {
  mode: "continuable";
  provider: string;
  definitionId: string;
  parentSessionId: string;
  label: string;
  agentProvider: string;
  agentModel: string;
};

export type SubagentDescriptorInput =
  | OneShotSubagentDescriptorInput
  | ContinuableSubagentDescriptorInput;

/** Validate and detach the composition identity before provider setup begins. */
export function snapshotSubagentDescriptor(
  input: OneShotSubagentDescriptorInput,
): AgentOneShotSubagentDescriptorData;
export function snapshotSubagentDescriptor(
  input: ContinuableSubagentDescriptorInput,
): AgentContinuableSubagentDescriptorData;
export function snapshotSubagentDescriptor(
  input: SubagentDescriptorInput,
): SubagentDescriptorData {
  const provider = requireNonEmpty(input.provider, "provider");
  const definitionId = requireNonEmpty(input.definitionId, "definitionId");
  const descriptor: SubagentDescriptorData = input.mode === "one-shot"
    ? {
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: input.mode,
        provider,
        definitionId,
      }
    : {
        version: SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
        mode: input.mode,
        provider,
        definitionId,
        parentSessionId: requireNonEmpty(input.parentSessionId, "parentSessionId"),
        label: requireNonEmpty(input.label, "label"),
        agentProvider: requireNonEmpty(input.agentProvider, "agentProvider"),
        agentModel: requireNonEmpty(input.agentModel, "agentModel"),
      };
  return JSON.parse(JSON.stringify(descriptor)) as SubagentDescriptorData;
}

/** The first descriptor in a child log is authoritative and cannot be rewritten. */
export function foldSubagentDescriptor(
  entries: readonly AgentTranscriptEntry[],
): SubagentDescriptorData | undefined {
  const entry = entries.find((candidate) => candidate.type === "subagent_descriptor");
  if (!entry || entry.type !== "subagent_descriptor") return undefined;
  return parseSubagentDescriptor(entry.descriptor);
}

export function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (!isRecord(value)) throw new Error("Persisted subagent descriptor must be an object.");
  if (typeof value.version !== "number") {
    throw new Error("Persisted subagent descriptor version must be a number.");
  }
  if (
    value.version !== SUBAGENT_DESCRIPTOR_VERSION
    && value.version !== SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION
  ) return undefined;
  const expectedMode = value.version === SUBAGENT_DESCRIPTOR_VERSION ? "one-shot" : "continuable";
  const keys = new Set(value.version === SUBAGENT_DESCRIPTOR_VERSION
    ? ["version", "mode", "provider", "definitionId"]
    : [
        "version",
        "mode",
        "provider",
        "definitionId",
        "parentSessionId",
        "label",
        "agentProvider",
        "agentModel",
      ]);
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));
  if (unknownKey) {
    throw new Error(`Persisted subagent descriptor has unknown field "${unknownKey}".`);
  }
  if (value.mode !== expectedMode) {
    throw new Error(`Persisted subagent descriptor mode must be "${expectedMode}".`);
  }
  const provider = requireNonEmpty(value.provider, "provider");
  const definitionId = requireNonEmpty(value.definitionId, "definitionId");
  if (value.version === SUBAGENT_DESCRIPTOR_VERSION) {
    return {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: "one-shot",
      provider,
      definitionId,
    };
  }
  return {
    version: SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
    mode: "continuable",
    provider,
    definitionId,
    parentSessionId: requireNonEmpty(value.parentSessionId, "parentSessionId"),
    label: requireNonEmpty(value.label, "label"),
    agentProvider: requireNonEmpty(value.agentProvider, "agentProvider"),
    agentModel: requireNonEmpty(value.agentModel, "agentModel"),
  };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Subagent descriptor ${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
