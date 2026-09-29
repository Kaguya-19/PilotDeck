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
  /** @deprecated-compatible optional extension for preserving the pre-plan mode. */
  getBase?(sessionKey: string): PermissionMode | undefined;
  set(sessionKey: string, mode: PermissionMode): void;
  /** Optional transition-aware write; consumers fall back to set() for legacy ports. */
  transition?(sessionKey: string, mode: PermissionMode, fallbackBase?: PermissionMode): void;
  clear(sessionKey: string): void;
  dispose(): void;
};

export class GatewaySessionPermissionModeRegistry implements GatewaySessionPermissionModePort {
  private readonly modes = new Map<string, { current: PermissionMode; baseBeforePlan?: PermissionMode }>();

  get(sessionKey: string): PermissionMode | undefined {
    return this.modes.get(sessionKey)?.current;
  }

  getBase(sessionKey: string): PermissionMode | undefined {
    return this.modes.get(sessionKey)?.baseBeforePlan;
  }

  set(sessionKey: string, mode: PermissionMode): void {
    this.modes.set(sessionKey, { current: mode });
  }

  transition(sessionKey: string, mode: PermissionMode, fallbackBase?: PermissionMode): void {
    const previous = this.modes.get(sessionKey);
    if (mode === "plan") {
      this.modes.set(sessionKey, {
        current: mode,
        baseBeforePlan: previous?.baseBeforePlan ?? previous?.current ?? fallbackBase,
      });
      return;
    }
    this.modes.set(sessionKey, { current: mode });
  }

  clear(sessionKey: string): void {
    this.modes.delete(sessionKey);
  }

  dispose(): void {
    this.modes.clear();
  }
}
