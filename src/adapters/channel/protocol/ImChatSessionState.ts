export type ImQueuedTurn = {
  sessionKey: string;
  message: string;
  projectKey?: string;
  attachments: unknown[];
};

export type ImActiveRun = {
  sessionKey: string;
  runId?: string;
  generation: number;
};

export class ImChatSessionState<Turn extends ImQueuedTurn = ImQueuedTurn> {
  private readonly maxPendingTurns: number;
  private readonly pendingTurns = new Map<string, Turn[]>();
  private readonly generations = new Map<string, number>();
  private readonly activeRuns = new Map<string, ImActiveRun>();

  constructor(options: { maxPendingTurns: number }) {
    this.maxPendingTurns = options.maxPendingTurns;
  }

  generation(chatId: string): number {
    return this.generations.get(chatId) ?? 0;
  }

  isCurrent(chatId: string, generation: number): boolean {
    return this.generation(chatId) === generation;
  }

  resetForNewSession(chatId: string): void {
    this.generations.set(chatId, this.generation(chatId) + 1);
    this.pendingTurns.delete(chatId);
    this.activeRuns.delete(chatId);
  }

  queueTurn(chatId: string, turn: Turn): void {
    const pending = this.pendingTurns.get(chatId) ?? [];
    pending.push(turn);
    if (pending.length > this.maxPendingTurns) {
      pending.splice(0, pending.length - this.maxPendingTurns);
    }
    this.pendingTurns.set(chatId, pending);
  }

  shiftTurn(chatId: string): Turn | undefined {
    const pending = this.pendingTurns.get(chatId);
    const next = pending?.shift();
    if (pending && pending.length === 0) {
      this.pendingTurns.delete(chatId);
    }
    return next;
  }

  setActiveRun(chatId: string, run: ImActiveRun): void {
    this.activeRuns.set(chatId, run);
  }

  activeRun(chatId: string): ImActiveRun | undefined {
    return this.activeRuns.get(chatId);
  }

  clearActiveRun(chatId: string): void {
    this.activeRuns.delete(chatId);
  }

}
