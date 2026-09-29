import type { CanonicalMessage } from "../../model/index.js";
import type { AgentInput } from "../protocol/input.js";

/**
 * Agent-owned admission seam for transforming an incoming turn into
 * model-visible messages. Context/extensions may provide it, but it does not
 * own session persistence, model dispatch, or Gateway state.
 */
export type AgentInputAdmissionResult = {
  messages: CanonicalMessage[];
  shouldCallModel: boolean;
};

export interface AgentInputAdmission {
  accept(input: AgentInput): AgentInputAdmissionResult;
}
