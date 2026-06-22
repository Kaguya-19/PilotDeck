import type { CanonicalMessage } from "../../model/index.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  stripUnpairedToolCalls,
  stripUnpairedToolResults,
} from "./toolPairIntegrity.js";
import {
  collectProtectedTurnIndexes,
  protectedToolNameSet,
  splitMessagesIntoTurns,
} from "./protectedContext.js";

export type SnipEngineOptions = {
  /** Number of head turns to keep (default 2). */
  keepHeadTurns?: number;
  /** Number of tail turns to keep (default 4). */
  keepTailTurns?: number;
  /** Master enable flag — when false, `snip` is a no-op (default true). */
  enabled?: boolean;
  /** Tool names whose turns should be preserved through snip compaction. */
  protectedToolNames?: Iterable<string>;
};

export type SnipResult = {
  messages: CanonicalMessage[];
  applied: boolean;
  /** Number of turns removed from the middle. */
  turnsSnipped: number;
  /** Number of dangling tool_call ids whose results were removed. */
  danglingToolCallIds: string[];
};

/**
 * Boundary marker injected between the kept head and tail. Looks like a
 * user-visible note (role=user, text content) so providers don't choke on
 * an unknown role. Callers recognize it via `isSnipBoundaryMessage`. The
 * payload is wrapped in an XML-style envelope so it's easy to detect and
 * never mistaken for normal user input.
 */
const SNIP_BOUNDARY_TEXT_PREFIX = "<snip-boundary";

export function createSnipBoundary(turnsSnipped: number, headTurns: number, tailTurns: number): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${SNIP_BOUNDARY_TEXT_PREFIX} turnsSnipped="${turnsSnipped}" headTurns="${headTurns}" tailTurns="${tailTurns}" />`,
      },
    ],
  };
}

export function isSnipBoundaryMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user" || message.content.length !== 1) return false;
  const block = message.content[0];
  if (!block || block.type !== "text") return false;
  return block.text.startsWith(SNIP_BOUNDARY_TEXT_PREFIX);
}

/**
 * A5 snip-compact engine. Aggressively prunes the middle of a long
 * conversation by turn (not token) so the provider sees only the head and
 * tail anchors plus a boundary marker.
 *
 * Behaviour rules:
 *   S1 turn boundaries: a "turn" starts at a user message that is NOT a
 *      tool_result-only message. Assistant + subsequent tool_result user
 *      messages are part of that turn.
 *   S2 keepHeadTurns / keepTailTurns default 2 / 4. Configurable.
 *   S3 No-op when total turns ≤ headTurns + tailTurns.
 *   S4 Tool-pair integrity: after head + protected middle + tail projection,
 *      dangling tool_call / tool_result blocks are removed.
 *   S5 Boundary marker injected between head and tail.
 *   S6 `projectSnippedView` filters the input to head+boundary+tail in one
 *      call, used by callers that don't need the dangling-tool report.
 *   S7 Disabled engine returns input unchanged (intentional_difference: legacy
 *      uses an explicit SnipTool; PilotDeck uses an automatic policy).
 */
export class SnipEngine {
  private readonly keepHeadTurns: number;
  private readonly keepTailTurns: number;
  private readonly enabled: boolean;
  private readonly protectedToolNames: ReadonlySet<string>;

  constructor(options: SnipEngineOptions = {}) {
    this.keepHeadTurns = Math.max(0, options.keepHeadTurns ?? 2);
    this.keepTailTurns = Math.max(1, options.keepTailTurns ?? 4);
    this.enabled = options.enabled ?? true;
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  snip(messages: CanonicalMessage[]): SnipResult {
    if (!this.enabled) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }
    const turns = splitMessagesIntoTurns(messages);
    if (turns.length <= this.keepHeadTurns + this.keepTailTurns) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }

    const keepIndexes = new Set<number>();
    const headEnd = Math.min(this.keepHeadTurns, turns.length);
    for (let index = 0; index < headEnd; index += 1) {
      keepIndexes.add(index);
    }
    const tailStart = Math.max(headEnd, turns.length - this.keepTailTurns);
    for (let index = tailStart; index < turns.length; index += 1) {
      keepIndexes.add(index);
    }
    for (const index of collectProtectedTurnIndexes(messages, {
      protectedToolNames: this.protectedToolNames,
    })) {
      keepIndexes.add(index);
    }
    if (keepIndexes.size >= turns.length) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }

    const turnsSnipped = turns.length - keepIndexes.size;
    const projected = stitchKeptTurnsWithBoundaries(turns, keepIndexes, this.keepHeadTurns, this.keepTailTurns);

    // S4: tool pair integrity.
    const toolResultIds = collectToolResultIds(projected);
    const toolCallIds = collectToolCallIds(projected);
    const withoutDanglingCalls = stripUnpairedToolCalls(projected, toolResultIds);
    const pairedToolCallIds = collectToolCallIds(withoutDanglingCalls);

    const cleaned = stripUnpairedToolResults(withoutDanglingCalls, pairedToolCallIds);

    const dangling = Array.from(toolCallIds).filter((id) => !toolResultIds.has(id));

    return {
      messages: ensureTrailingUserMessage(cleaned),
      applied: true,
      turnsSnipped,
      danglingToolCallIds: dangling,
    };
  }
}

/**
 * S6: one-shot projection. Equivalent to `snip(messages).messages` but
 * always returns *some* projection — even if no snip happened, the input
 * is returned verbatim.
 */
export function projectSnippedView(
  messages: CanonicalMessage[],
  options: SnipEngineOptions = {},
): CanonicalMessage[] {
  return new SnipEngine(options).snip(messages).messages;
}

function stitchKeptTurnsWithBoundaries(
  turns: ReturnType<typeof splitMessagesIntoTurns>,
  keepIndexes: Set<number>,
  headTurns: number,
  tailTurns: number,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  let skipped = 0;
  for (const turn of turns) {
    if (!keepIndexes.has(turn.index)) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      out.push(createSnipBoundary(skipped, headTurns, tailTurns));
      skipped = 0;
    }
    out.push(...turn.messages);
  }
  if (skipped > 0) {
    out.push(createSnipBoundary(skipped, headTurns, tailTurns));
  }
  return out;
}
