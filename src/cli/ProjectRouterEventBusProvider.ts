import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  RouterEvent,
  RouterEventBus,
  RouterRetryProgressEvent,
} from "../router/protocol/events.js";

export type ProjectRouterEventBusProviderOptions = {
  pilotHome: string;
  /** Live projection only; Gateway remains the owner of active turn state. */
  onRetryProgress?: (event: RouterRetryProgressEvent) => void;
};

/**
 * Native application provider for Router's append-only event observation.
 *
 * The Router remains the producer of decisions and retries. This provider
 * only records those already-canonical events and forwards retry progress to
 * an optional live observer; neither output becomes Session durable state.
 */
export class ProjectRouterEventBusProvider {
  constructor(private readonly options: ProjectRouterEventBusProviderOptions) {}

  create(): RouterEventBus {
    const eventsPath = this.ensureEventsPath();
    return {
      emit: (event) => this.emit(eventsPath, event),
    };
  }

  private ensureEventsPath(): string {
    const routerDir = resolve(this.options.pilotHome, "router");
    const eventsPath = join(routerDir, "events.jsonl");
    try { mkdirSync(routerDir, { recursive: true }); } catch { /* best-effort directory creation */ }
    try {
      const oldPath = resolve(this.options.pilotHome, "router-events.jsonl");
      if (!existsSync(eventsPath) && existsSync(oldPath)) renameSync(oldPath, eventsPath);
    } catch { /* best-effort legacy event-log migration */ }
    return eventsPath;
  }

  private emit(eventsPath: string, event: RouterEvent): void {
    try {
      appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    } catch {
      // Router decisions must not fail because the optional event log is unavailable.
    }
    if (event.type !== "pilotdeck_router_retry_progress") return;
    try {
      this.options.onRetryProgress?.(event);
    } catch {
      // A live Gateway observer must not alter the router retry path.
    }
  }
}
