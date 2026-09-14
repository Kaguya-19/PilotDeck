import type {
  GatewayTurnCompletionFencePort,
  GatewayTurnCompletionHandle,
} from "./GatewayTurnCompletionFencePort.js";

type MutableCompletionHandle = GatewayTurnCompletionHandle & {
  resolve(): void;
};

/** Native in-memory completion fence for live Gateway turns. */
export class GatewayTurnCompletionFence implements GatewayTurnCompletionFencePort {
  private readonly bySession = new Map<string, MutableCompletionHandle>();

  begin(sessionKey: string): GatewayTurnCompletionHandle {
    let resolve!: () => void;
    const done = new Promise<void>((resolveDone) => {
      resolve = resolveDone;
    });
    const handle: MutableCompletionHandle = { done, resolve };
    this.bySession.set(sessionKey, handle);
    return handle;
  }

  isCurrent(sessionKey: string, handle: GatewayTurnCompletionHandle): boolean {
    return this.bySession.get(sessionKey) === handle;
  }

  complete(sessionKey: string, handle: GatewayTurnCompletionHandle): void {
    if (this.bySession.get(sessionKey) === handle) {
      this.bySession.delete(sessionKey);
    }
    (handle as MutableCompletionHandle).resolve();
  }

  async waitForCompletion(sessionKey: string): Promise<void> {
    await this.bySession.get(sessionKey)?.done;
  }
}
