import type { InteractionPolicy, InteractionPolicyMode } from "../../interaction/index.js";

/**
 * Elicitation channel — abstraction over how a synchronous user prompt is
 * delivered (CLI / TUI / Feishu / in-memory test). Owned by the host
 * (Gateway / Adapter), wired into the ToolRuntime via
 * `PilotDeckToolRuntimeContext.elicitation`.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   E1 a single round-trip per invocation; channel returns one Result.
 *   E2 user can decline; channel returns `cancelled: true`.
 *   E3 free-form notes per question are optional.
 *   E4 multi-select answers are emitted as `Array<string>` in answers.
 *
 * Coordination with the cron PR (§1.3.1, §5.1):
 *   Gateway protocol naming for this surface is `elicitation_request` /
 *   `elicitation_answer` (no overlap with `cron_*`).
 */
export type PilotDeckElicitationOption = {
  label: string;
  description: string;
  preview?: string;
};

export type PilotDeckElicitationQuestion = {
  question: string;
  header: string;
  options: PilotDeckElicitationOption[];
  multiSelect?: boolean;
};

export type PilotDeckElicitationRequest = {
  /** Stable identifier of the underlying tool call. */
  toolCallId: string;
  toolName: string;
  /** Format hint forwarded to the channel. `html` = render previews as HTML. */
  previewFormat?: "html" | "markdown";
  questions: PilotDeckElicitationQuestion[];
  /** Free-form metadata forwarded verbatim (e.g. `source: "remember"`). */
  metadata?: Record<string, unknown>;
  /** Cancellation signal: channels MUST honor abort. */
  signal?: AbortSignal;
};

export type PilotDeckElicitationAnswer =
  | { type: "answered"; answers: Record<string, string | string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { type: "cancelled"; reason?: string };

/** Host-independent answerer used by headless profiles. */
export type PilotDeckElicitationAnswerer = {
  answer(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer>;
};

export type PilotDeckElicitationChannel = {
  /** Send a question batch to the user and await one answer batch. */
  askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer>;
  /** Stop accepting requests and release any pending host round-trips. */
  dispose?(reason?: string): void | Promise<void>;
};

export function createElicitationChannelFromAnswerer(
  answerer: PilotDeckElicitationAnswerer,
  options: {
    policy?: InteractionPolicy;
    policyMode?: InteractionPolicyMode;
    canPrompt?: boolean;
  } = {},
): PilotDeckElicitationChannel {
  let state: "active" | "draining" | "disposed" = "active";
  const pending = new Set<Promise<PilotDeckElicitationAnswer>>();
  return {
    askUser: (request) => {
      if (state !== "active") {
        return Promise.reject(new Error(`Elicitation channel is ${state}.`));
      }
      const decision = options.policy?.decide({
        kind: "question",
        mode: options.policyMode ?? "headless",
        hasAnswerer: true,
        canPrompt: options.canPrompt,
      });
      if (decision && decision.outcome !== "ask") {
        return Promise.resolve({ type: "cancelled", reason: decision.reason });
      }
      const result = Promise.resolve().then(() => answerer.answer(request));
      pending.add(result);
      const cleanup = () => pending.delete(result);
      void result.then(cleanup, cleanup);
      return result;
    },
    dispose: async (reason = "elicitation_channel_disposed") => {
      if (state === "disposed") return;
      state = "draining";
      await Promise.allSettled([...pending]);
      state = "disposed";
      void reason;
    },
  };
}

/**
 * Test/in-memory channel: pre-canned answers keyed by question text.
 * Throws if a question is asked that does not have an answer registered.
 */
export class InMemoryElicitationChannel implements PilotDeckElicitationChannel {
  private readonly answers: Map<string, string | string[]>;
  private readonly cancelOnAsk: boolean;

  constructor(
    answers: Record<string, string | string[]> = {},
    options: { cancelOnAsk?: boolean } = {},
  ) {
    this.answers = new Map(Object.entries(answers));
    this.cancelOnAsk = options.cancelOnAsk ?? false;
  }

  async askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer> {
    if (this.cancelOnAsk) {
      return { type: "cancelled", reason: "in-memory cancel" };
    }
    const answers: Record<string, string | string[]> = {};
    for (const q of request.questions) {
      if (!this.answers.has(q.question)) {
        throw new Error(`InMemoryElicitationChannel: no canned answer for "${q.question}"`);
      }
      answers[q.question] = this.answers.get(q.question)!;
    }
    return { type: "answered", answers };
  }
}
