import type {
  GatewayTurnCompletionFencePort,
  GatewayTurnCompletionHandle,
} from "./GatewayTurnCompletionFencePort.js";

type MutableCompletionHandle = GatewayTurnCompletionHandle & {
  controller: AbortController;
  resolve(): void;
};

/** Native in-memory completion fence for live Gateway turns. */
export class GatewayTurnCompletionFence implements GatewayTurnCompletionFencePort {
  private readonly bySession = new Map<string, MutableCompletionHandle>();

  begin(sessionKey: string, runId: string): GatewayTurnCompletionHandle {
    let resolve!: () => void;
    const done = new Promise<void>((resolveDone) => {
      resolve = resolveDone;
    });
    const controller = new AbortController();
    const handle: MutableCompletionHandle = { runId, signal: controller.signal, done, controller, resolve };
    this.bySession.set(sessionKey, handle);
    return handle;
  }

  isCurrent(sessionKey: string, handle: GatewayTurnCompletionHandle): boolean {
    return this.bySession.get(sessionKey) === handle;
  }

  cancel(sessionKey: string, reason?: string, runId?: string): boolean {
    const handle = this.bySession.get(sessionKey);
    if (!handle || (runId !== undefined && handle.runId !== runId)) return false;
    handle.controller.abort(reason);
    return true;
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
