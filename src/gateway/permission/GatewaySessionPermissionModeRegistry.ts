import type { PermissionMode } from "../../permission/index.js";

/**
 * Host-owned live permission mode for one Gateway session.
 *
 * This is deliberately volatile: SessionRuntime remains the durable source
 * of truth, while this registry only carries a successful tool transition to
 * the next Gateway turn (including a dirty session recreate).
 */
export type GatewaySessionPermissionModePort = {
  get(sessionKey: string): PermissionMode | undefined;
  set(sessionKey: string, mode: PermissionMode): void;
  clear(sessionKey: string): void;
  dispose(): void;
};

export class GatewaySessionPermissionModeRegistry implements GatewaySessionPermissionModePort {
  private readonly modes = new Map<string, PermissionMode>();

  get(sessionKey: string): PermissionMode | undefined {
    return this.modes.get(sessionKey);
  }

  set(sessionKey: string, mode: PermissionMode): void {
    this.modes.set(sessionKey, mode);
  }

  clear(sessionKey: string): void {
    this.modes.delete(sessionKey);
  }

  dispose(): void {
    this.modes.clear();
  }
}
