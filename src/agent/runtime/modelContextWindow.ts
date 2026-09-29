import type { ModelRuntime } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export type ResolveRoutedModelMaxContextTokensInput = {
  modelRuntime: Pick<ModelRuntime, "getCapabilities">;
  agentModel: PilotAgentModelSelection;
  agentMaxContextTokens?: number;
  provider: string;
  model: string;
};

export function resolveRoutedModelMaxContextTokens(
  input: ResolveRoutedModelMaxContextTokensInput,
): number | undefined {
  if (
    input.agentMaxContextTokens !== undefined &&
    input.provider === input.agentModel.provider &&
    input.model === input.agentModel.model
  ) {
    return input.agentMaxContextTokens;
  }

  try {
    return input.modelRuntime.getCapabilities(input.provider, input.model).maxContextTokens;
  } catch {
    return undefined;
  }
}
