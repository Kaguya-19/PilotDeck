import type { AgentSession } from "../session/AgentSession.js";
import { AgentHandle, asAgentHandle, type AgentHandleOptions } from "./AgentHandle.js";
import {
  ScopedServiceRegistry,
  createScopedServiceToken,
  type ScopedServiceRegistration,
  type ScopedServiceToken,
} from "./ScopedServiceRegistry.js";

type AgentRegistryEntry = {
  handle: AgentHandle;
  registration: ScopedServiceRegistration;
  token: ScopedServiceToken<AgentHandle>;
};

export type AgentRegistryOptions = {
  name?: string;
};

export type AgentReplacement = {
  handle: AgentHandle;
  previousDisposed: Promise<void>;
};

export class AgentRegistry {
  private readonly scope: ScopedServiceRegistry;
  private readonly entries = new Map<string, AgentRegistryEntry>();

  constructor(options: AgentRegistryOptions = {}) {
    this.scope = new ScopedServiceRegistry({ name: options.name ?? "agent-registry" });
  }

  get state() {
    return this.scope.state;
  }

  get size(): number {
    return this.entries.size;
  }

  get(agentId: string): AgentHandle | undefined {
    if (this.scope.state !== "active") return undefined;
    return this.entries.get(agentId)?.handle;
  }

  register(
    agentId: string,
    session: AgentSession | AgentHandle,
    options: AgentHandleOptions = {},
  ): AgentHandle {
    if (this.entries.has(agentId)) {
      throw new Error(`Agent is already registered: ${agentId}`);
    }
    const handle = asAgentHandle(session, options);
    const token = createScopedServiceToken<AgentHandle>(`agent:${agentId}`);
    const registration = this.scope.register(token, handle, {
      dispose: (registeredHandle) => registeredHandle.dispose(`agent_removed:${agentId}`),
    });
    this.entries.set(agentId, { handle, registration, token });
    return handle;
  }

  replace(
    agentId: string,
    session: AgentSession | AgentHandle,
    options: AgentHandleOptions = {},
  ): AgentReplacement {
    const previous = this.entries.get(agentId);
    if (!previous) {
      throw new Error(`Agent is not registered: ${agentId}`);
    }
    const handle = asAgentHandle(session, options);
    const replacement = this.scope.replace(previous.token, handle, {
      dispose: (registeredHandle) => registeredHandle.dispose(`agent_replaced:${agentId}`),
    });
    this.entries.set(agentId, {
      handle,
      registration: replacement.registration,
      token: previous.token,
    });
    return { handle, previousDisposed: replacement.previousDisposed };
  }

  async remove(agentId: string, reason = "agent_removed"): Promise<AgentHandle | undefined> {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    // Keep the exact handle addressable while its disposal-start hooks run.
    // Scoped owners (notably continuable subagents) use that identity to
    // propagate child-first teardown. Replacement has already swapped the
    // entry before disposing the old handle, so this does not authorize stale
    // same-id handles.
    const handleDisposal = entry.handle.dispose(reason);
    try {
      await Promise.all([handleDisposal, entry.registration.dispose()]);
    } finally {
      if (this.entries.get(agentId) === entry) this.entries.delete(agentId);
    }
    return entry.handle;
  }

  async dispose(): Promise<void> {
    try {
      await this.scope.dispose();
    } finally {
      this.entries.clear();
    }
  }
}
