import type { CanonicalMessage } from "../../model/index.js";
import type { InboxMutationDraft } from "./AgentSessionEventRecorder.js";

export type AgentSteerMessage = {
  itemId: string;
  message: CanonicalMessage;
  allowedReadFiles?: string[];
};

export type AgentSteerResult = {
  accepted: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "turn_closing" | "cancelled";
};

export type AgentCancelSteerResult = {
  cancelled: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "too_late";
};

export type SteerMailboxOptions = {
  recordMutation?: (turnId: string, mutation: InboxMutationDraft) => void | Promise<void>;
};

type PendingSteer = AgentSteerMessage & {
  state: "pending" | "offered" | "claimed";
};

/** Turn-scoped, durable-first inbox for guidance submitted during a run. */
export class SteerMailbox {
  private turnId: string | undefined;
  private open = false;
  private readonly pending: PendingSteer[] = [];
  private readonly seenItemIds = new Set<string>();
  private readonly cancelledItemIds = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SteerMailboxOptions = {}) {}

  start(turnId: string): void {
    this.turnId = turnId;
    this.open = true;
    this.pending.splice(0);
    this.seenItemIds.clear();
    this.cancelledItemIds.clear();
  }

  enqueue(turnId: string, input: AgentSteerMessage): Promise<AgentSteerResult> {
    return this.serialize(async () => {
      const rejected = this.validateActiveTurn(turnId);
      if (rejected) return { accepted: false, reason: rejected };
      if (this.cancelledItemIds.has(input.itemId)) return { accepted: false, reason: "cancelled" };
      if (this.seenItemIds.has(input.itemId)) return { accepted: true };

      await this.record(turnId, {
        mutation: "insert",
        itemId: input.itemId,
        message: input.message,
        ...(input.allowedReadFiles ? { allowedReadFiles: input.allowedReadFiles } : {}),
      });

      if (!this.open || this.turnId !== turnId) {
        await this.record(turnId, {
          mutation: "discard",
          itemId: input.itemId,
          reason: "turn_closing",
        });
        return { accepted: false, reason: this.turnId === turnId ? "turn_closing" : "no_active_turn" };
      }

      this.seenItemIds.add(input.itemId);
      this.pending.push({ ...input, state: "pending" });
      return { accepted: true };
    });
  }

  cancel(turnId: string, itemId: string): Promise<AgentCancelSteerResult> {
    return this.serialize(async () => {
      if (!this.turnId) return { cancelled: false, reason: "no_active_turn" };
      if (this.turnId !== turnId) return { cancelled: false, reason: "turn_mismatch" };
      if (this.cancelledItemIds.has(itemId)) return { cancelled: true };

      const pending = this.pending.find((entry) => entry.itemId === itemId);
      if (pending && pending.state !== "pending") {
        return { cancelled: false, reason: "too_late" };
      }
      if (!pending && this.seenItemIds.has(itemId)) {
        return { cancelled: false, reason: "too_late" };
      }

      await this.record(turnId, { mutation: "cancel", itemId });
      if (pending) this.remove(itemId);
      this.cancelledItemIds.add(itemId);
      return { cancelled: true };
    });
  }

  drain(turnId: string): AgentSteerMessage[] {
    if (!this.open || this.turnId !== turnId) return [];
    return this.offerPending();
  }

  drainOrClose(turnId: string): { messages: AgentSteerMessage[]; closed: boolean } {
    if (!this.open || this.turnId !== turnId) return { messages: [], closed: true };
    const messages = this.offerPending();
    if (messages.length > 0) return { messages, closed: false };
    this.open = false;
    return { messages: [], closed: true };
  }

  claim(turnId: string, itemId: string): Promise<void> {
    return this.serialize(async () => {
      const pending = this.pending.find((entry) => entry.itemId === itemId);
      if (!pending || pending.state === "claimed") return;
      if (this.turnId !== turnId || pending.state !== "offered") {
        throw new Error(`Steer ${itemId} is not offered for turn ${turnId}.`);
      }
      await this.record(turnId, { mutation: "claim", itemId });
      pending.state = "claimed";
    });
  }

  ack(turnId: string, itemId: string): void {
    if (this.turnId !== turnId) return;
    const pending = this.pending.find((entry) => entry.itemId === itemId);
    if (!pending || pending.state !== "claimed") return;
    this.remove(itemId);
  }

  close(turnId: string): Promise<AgentSteerMessage[]> {
    if (this.turnId !== turnId) return Promise.resolve([]);
    this.open = false;
    return this.serialize(async () => {
      const discarded: AgentSteerMessage[] = [];
      while (this.pending.length > 0) {
        const entry = this.pending[0]!;
        await this.record(turnId, {
          mutation: "discard",
          itemId: entry.itemId,
          reason: "turn_ended",
        });
        discarded.push(toSteerMessage(entry));
        this.pending.shift();
      }
      return discarded;
    });
  }

  finish(turnId: string): AgentSteerMessage[] {
    if (this.turnId !== turnId) return [];
    this.open = false;
    this.turnId = undefined;
    const remaining = this.pending.splice(0).map(toSteerMessage);
    this.seenItemIds.clear();
    this.cancelledItemIds.clear();
    return remaining;
  }

  private offerPending(): AgentSteerMessage[] {
    const offered: AgentSteerMessage[] = [];
    for (const entry of this.pending) {
      if (entry.state !== "pending") continue;
      entry.state = "offered";
      offered.push(toSteerMessage(entry));
    }
    return offered;
  }

  private remove(itemId: string): void {
    const index = this.pending.findIndex((entry) => entry.itemId === itemId);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private validateActiveTurn(turnId: string): AgentSteerResult["reason"] | undefined {
    if (!this.turnId) return "no_active_turn";
    if (this.turnId !== turnId) return "turn_mismatch";
    if (!this.open) return "turn_closing";
    return undefined;
  }

  private record(turnId: string, mutation: InboxMutationDraft): Promise<void> {
    return Promise.resolve(this.options.recordMutation?.(turnId, mutation));
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function toSteerMessage(entry: PendingSteer): AgentSteerMessage {
  return {
    itemId: entry.itemId,
    message: entry.message,
    ...(entry.allowedReadFiles ? { allowedReadFiles: entry.allowedReadFiles } : {}),
  };
}
