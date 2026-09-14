/**
 * Owns per-session MCP runtime registrations without treating a session key
 * as the runtime identity. During dirty recreation an old and replacement
 * AgentHandle can coexist briefly under the same key; each must release only
 * the MCP runtime it created.
 */

export type SessionMcpRuntime = {
  stop(): Promise<void>;
};

export type SessionMcpRuntimeRegistration = {
  dispose(): Promise<void>;
};

export type SessionMcpRuntimeRegistryState = "active" | "draining" | "disposed";

type Entry = {
  runtime: SessionMcpRuntime;
  stopPromise?: Promise<void>;
};

export class SessionMcpRuntimeRegistry {
  private readonly entriesBySession = new Map<string, Set<Entry>>();
  private state_: SessionMcpRuntimeRegistryState = "active";
  private disposePromise?: Promise<void>;

  get state(): SessionMcpRuntimeRegistryState {
    return this.state_;
  }

  get size(): number {
    let count = 0;
    for (const entries of this.entriesBySession.values()) count += entries.size;
    return count;
  }

  register(sessionKey: string, runtime: SessionMcpRuntime): SessionMcpRuntimeRegistration {
    if (this.state_ !== "active") {
      throw new Error(`Cannot register per-session MCP runtime; registry is ${this.state_}.`);
    }
    const entry: Entry = { runtime };
    let entries = this.entriesBySession.get(sessionKey);
    if (!entries) {
      entries = new Set<Entry>();
      this.entriesBySession.set(sessionKey, entries);
    }
    entries.add(entry);
    let released = false;
    return {
      dispose: async () => {
        if (released) return;
        released = true;
        await this.release(sessionKey, entry);
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state_ = "draining";
    this.disposePromise = this.disposeEntries();
    return this.disposePromise;
  }

  private async disposeEntries(): Promise<void> {
    const entries = [...this.entriesBySession.entries()];
    try {
      const results = await Promise.allSettled(
        entries.flatMap(([sessionKey, sessionEntries]) =>
          [...sessionEntries].map((entry) => this.release(sessionKey, entry)),
        ),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Failed to dispose per-session MCP runtimes.");
      }
    } finally {
      this.state_ = "disposed";
    }
  }

  private async release(sessionKey: string, entry: Entry): Promise<void> {
    const entries = this.entriesBySession.get(sessionKey);
    if (!entries?.delete(entry)) return;
    if (entries.size === 0) this.entriesBySession.delete(sessionKey);
    await this.stop(entry);
  }

  private stop(entry: Entry): Promise<void> {
    if (!entry.stopPromise) entry.stopPromise = entry.runtime.stop();
    return entry.stopPromise;
  }
}
