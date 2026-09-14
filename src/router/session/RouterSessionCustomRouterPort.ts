import type { CustomRouterRegistry, PilotDeckCustomRouter } from "../customRouter/customRouter.js";

export type RouterSessionCustomRouterRegistration = {
  release(): void;
};

/**
 * Project-owned index of session-retained custom routers.
 *
 * Registration does not own plugin disposal: the session's plugin lease owns
 * that lifecycle. This index only maps the exact session identity to the
 * already-created router for dispatch and removes the mapping on release.
 */
export type RouterSessionCustomRouterPort = CustomRouterRegistry & {
  register(
    sessionId: string,
    routers: readonly PilotDeckCustomRouter[],
  ): RouterSessionCustomRouterRegistration;
  clear(): void;
  dispose(): void;
};

export type RouterSessionCustomRouterState = "active" | "disposed";

type Registration = {
  routers: ReadonlyMap<string, PilotDeckCustomRouter>;
};

export class RouterSessionCustomRouterRegistry implements RouterSessionCustomRouterPort {
  private readonly registrations = new Map<string, Registration>();
  private state_: RouterSessionCustomRouterState = "active";

  get state(): RouterSessionCustomRouterState {
    return this.state_;
  }

  register(
    sessionId: string,
    routers: readonly PilotDeckCustomRouter[],
  ): RouterSessionCustomRouterRegistration {
    this.assertActive();
    const mapped = new Map<string, PilotDeckCustomRouter>();
    for (const router of routers) {
      const id = router.id.trim();
      if (id.length === 0) {
        throw new Error(`Cannot register a custom router with an empty id for session ${sessionId}.`);
      }
      if (mapped.has(id)) {
        throw new Error(`Duplicate custom router '${id}' for session ${sessionId}.`);
      }
      mapped.set(id, router);
    }
    const registration: Registration = { routers: mapped };
    this.registrations.set(sessionId, registration);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.registrations.get(sessionId) === registration) {
          this.registrations.delete(sessionId);
        }
      },
    };
  }

  lookupRouter(extensionId: string, sessionId?: string): PilotDeckCustomRouter | undefined {
    if (this.state_ !== "active" || !sessionId) return undefined;
    return this.registrations.get(sessionId)?.routers.get(extensionId);
  }

  clear(): void {
    this.registrations.clear();
  }

  dispose(): void {
    if (this.state_ === "disposed") return;
    this.clear();
    this.state_ = "disposed";
  }

  private assertActive(): void {
    if (this.state_ !== "active") {
      throw new Error("Router session custom-router registry is disposed.");
    }
  }
}

export function createNativeRouterSessionCustomRouterPort(): RouterSessionCustomRouterPort {
  return new RouterSessionCustomRouterRegistry();
}
