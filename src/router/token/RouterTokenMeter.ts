import type { CanonicalMessage, CanonicalModelEvent } from "../../model/index.js";
import {
  countMessagesTokens,
  countResponseTokens,
} from "../utils/countTokens.js";

/** DSH-style Definition for router token estimation and accounting fallback. */
export type RouterTokenMeter = {
  estimateInput(messages: readonly CanonicalMessage[]): number;
  estimateOutput(events: readonly CanonicalModelEvent[]): number;
  dispose?(): void | Promise<void>;
};

/** Native provider preserving PilotDeck's current o200k token semantics. */
export function createNativeRouterTokenMeter(): RouterTokenMeter {
  return {
    estimateInput(messages) {
      return countMessagesTokens(messages);
    },
    estimateOutput(events) {
      return countResponseTokens(events);
    },
  };
}
