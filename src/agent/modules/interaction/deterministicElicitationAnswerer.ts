import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationAnswerer,
} from "../../../tool/elicitation/PilotDeckElicitationChannel.js";

/** Native headless provider for benchmark and non-interactive profiles. */
export function createDeterministicElicitationAnswerer(): PilotDeckElicitationAnswerer {
  return {
    async answer(request): Promise<PilotDeckElicitationAnswer> {
      const answers: Record<string, string | string[]> = {};
      for (const question of request.questions) {
        if (question.options.length > 0) {
          answers[question.question] = question.multiSelect
            ? [question.options[0].label]
            : question.options[0].label;
        } else {
          answers[question.question] = "yes";
        }
      }
      return { type: "answered", answers };
    },
  };
}
