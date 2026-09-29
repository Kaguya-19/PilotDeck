import type { AgentInput } from "../protocol/input.js";
import type { AgentHandle } from "../scope/AgentHandle.js";
import type {
  SubagentContinuationPort,
} from "../../tool/builtin/subagentContinuation.js";
import { getSubagentDefinition } from "./builtinSubagentTypes.js";
import type {
  FollowupContinuableSubagentRequest,
  StartContinuableSubagentRequest,
  SubagentContinuationManager,
} from "./SubagentContinuationManager.js";

/** Bind the consumer contract to one exact live parent and one provider selection. */
export function bindSubagentContinuationPort(args: {
  manager: Pick<SubagentContinuationManager, "start" | "followup">;
  parent: AgentHandle;
  parentConfig: StartContinuableSubagentRequest["parentConfig"];
  parentDependencies: StartContinuableSubagentRequest["parentDependencies"];
  provider: string;
}): SubagentContinuationPort {
  return {
    start: (request) => {
      const definitionId = request.definitionId ?? "general-purpose";
      const definition = getSubagentDefinition(definitionId);
      if (!definition) throw new Error(`Unknown subagent type: ${definitionId}`);
      return args.manager.start({
        provider: args.provider,
        label: request.label,
        parent: args.parent,
        definition,
        parentConfig: args.parentConfig,
        parentDependencies: args.parentDependencies,
        input: textInput(request.prompt),
        abortSignal: request.abortSignal,
      });
    },
    followup: (request) => args.manager.followup({
      childSessionId: request.childSessionId,
      parent: args.parent,
      input: textInput(request.message),
      abortSignal: request.abortSignal,
    } satisfies FollowupContinuableSubagentRequest),
  };
}

function textInput(text: string): AgentInput {
  return { type: "text", text };
}
