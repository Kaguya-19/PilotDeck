import type { CanonicalFinishReason, CanonicalModelEvent } from "../protocol/canonical.js";

export interface StreamingCheckpoint {
  partialText: string;
  tokensReceived: number;
  hasToolCalls: boolean;
  thinkingTokensReceived: number;
  toolCallsStarted: number;
  toolCallsEnded: number;
}

export type SyntheticStreamEndDecision =
  | { ok: true; finishReason: CanonicalFinishReason; reason: "text" | "thinking" | "tool_call" }
  | { ok: false; reason: "empty" | "incomplete_tool_call" };

/**
 * Lightweight tracker that accumulates partial assistant content from a
 * streaming model response. Used by the stream-retry logic in `streamModel`
 * to decide whether a mid-stream failure has enough partial content to
 * warrant a continuation retry (as opposed to a full from-scratch retry).
 */
export class StreamingCheckpointManager {
  private checkpoint: StreamingCheckpoint = {
    partialText: "",
    tokensReceived: 0,
    hasToolCalls: false,
    thinkingTokensReceived: 0,
    toolCallsStarted: 0,
    toolCallsEnded: 0,
  };

  onEvent(event: CanonicalModelEvent): void {
    switch (event.type) {
      case "text_delta":
        this.checkpoint.partialText += event.text;
        this.checkpoint.tokensReceived++;
        break;
      case "thinking_delta":
        this.checkpoint.tokensReceived++;
        this.checkpoint.thinkingTokensReceived++;
        break;
      case "tool_call_start":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.toolCallsStarted++;
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_delta":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_end":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.toolCallsEnded++;
        this.checkpoint.tokensReceived++;
        break;
    }
  }

  get(): StreamingCheckpoint {
    return { ...this.checkpoint };
  }

  hasSubstantialContent(): boolean {
    return this.checkpoint.tokensReceived > 50 && this.checkpoint.partialText.length > 100;
  }

  syntheticEndDecision(): SyntheticStreamEndDecision {
    if (this.checkpoint.toolCallsStarted > this.checkpoint.toolCallsEnded) {
      return { ok: false, reason: "incomplete_tool_call" };
    }
    if (this.checkpoint.toolCallsEnded > 0) {
      return { ok: true, finishReason: "tool_call", reason: "tool_call" };
    }
    if (this.checkpoint.partialText.trim().length > 0) {
      return { ok: true, finishReason: "unknown", reason: "text" };
    }
    if (this.checkpoint.thinkingTokensReceived > 0) {
      return { ok: true, finishReason: "unknown", reason: "thinking" };
    }
    return { ok: false, reason: "empty" };
  }

  reset(): void {
    this.checkpoint = {
      partialText: "",
      tokensReceived: 0,
      hasToolCalls: false,
      thinkingTokensReceived: 0,
      toolCallsStarted: 0,
      toolCallsEnded: 0,
    };
  }
}
