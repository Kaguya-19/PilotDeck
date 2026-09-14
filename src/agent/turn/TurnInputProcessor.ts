import type { AgentInput } from "../protocol/input.js";
import type { AgentInputAdmission, AgentInputAdmissionResult } from "./InputAdmission.js";

export type TurnInputProcessorResult = AgentInputAdmissionResult;

export class TurnInputProcessor {
  constructor(private readonly inputAdmission?: AgentInputAdmission) {}

  accept(input: AgentInput): TurnInputProcessorResult {
    const processed = this.inputAdmission?.accept(input);
    if (processed) {
      return {
        shouldCallModel: processed.shouldCallModel,
        messages: processed.messages,
      };
    }
    if (input.type === "text") {
      return {
        shouldCallModel: true,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.text }],
          },
        ],
      };
    }

    return {
      shouldCallModel: true,
      messages: [
        {
          role: "user",
          content: input.content,
        },
      ],
    };
  }
}
