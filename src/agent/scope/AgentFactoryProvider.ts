import type { AgentSession } from "../session/AgentSession.js";
import { AgentHandle, asAgentHandle } from "./AgentHandle.js";
import { AgentRegistry, type AgentReplacement } from "./AgentRegistry.js";

export type AgentFactoryProviderState = "active" | "draining" | "disposed";

export type AgentPublicationOptions = {
  setup?: (handle: AgentHandle) => void | Promise<void>;
};

export type AgentFactoryProviderOptions = {
  name?: string;
  registry?: AgentRegistry;
};

type AgentFactory = () => AgentSession | AgentHandle | Promise<AgentSession | AgentHandle>;

export class AgentFactoryProvider {
  readonly registry: AgentRegistry;

  private providerState: AgentFactoryProviderState = "active";
  private readonly transactions = new Set<Promise<unknown>>();
  private readonly ownedHandles = new Set<AgentHandle>();
  private readonly publishedHandles = new Map<string, AgentHandle>();
  private disposePromise?: Promise<void>;

  constructor(options: AgentFactoryProviderOptions = {}) {
    this.registry = options.registry ?? new AgentRegistry({ name: options.name ?? "agent-factory" });
  }

  get state(): AgentFactoryProviderState {
    return this.providerState;
  }

  get inFlightTransactions(): number {
    return this.transactions.size;
  }

  get ownedCount(): number {
    return this.ownedHandles.size;
  }

  create(
    agentId: string,
    factory: AgentFactory,
    options: AgentPublicationOptions = {},
  ): Promise<AgentHandle> {
    return this.runTransaction(async () => {
      let handle: AgentHandle | undefined;
      try {
        handle = asAgentHandle(await factory());
        await options.setup?.(handle);
        this.assertActive(`publish agent ${agentId}`);
        const published = this.registry.register(agentId, handle);
        this.ownedHandles.add(published);
        this.publishedHandles.set(agentId, published);
        return published;
      } catch (error) {
        return rollbackHandle(handle, error, `create agent ${agentId}`);
      }
    });
  }

  replace(
    agentId: string,
    factory: AgentFactory,
    options: AgentPublicationOptions = {},
  ): Promise<AgentReplacement> {
    return this.runTransaction(async () => {
      let handle: AgentHandle | undefined;
      try {
        handle = asAgentHandle(await factory());
        await options.setup?.(handle);
        this.assertActive(`publish replacement agent ${agentId}`);
        const previous = this.registry.get(agentId);
        const replacement = this.registry.replace(agentId, handle);
        this.ownedHandles.add(replacement.handle);
        this.publishedHandles.set(agentId, replacement.handle);
        if (previous && this.ownedHandles.has(previous)) {
          void replacement.previousDisposed.then(
            () => this.ownedHandles.delete(previous),
            () => this.ownedHandles.delete(previous),
          );
        }
        return replacement;
      } catch (error) {
        return rollbackHandle(handle, error, `replace agent ${agentId}`);
      }
    });
  }

  async remove(agentId: string, reason = "agent_provider_removed"): Promise<AgentHandle | undefined> {
    const published = this.publishedHandles.get(agentId);
    if (!published) return undefined;
    this.publishedHandles.delete(agentId);
    if (this.registry.get(agentId) !== published) {
      return undefined;
    }
    const removed = await this.registry.remove(agentId, reason);
    this.ownedHandles.delete(published);
    return removed;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.providerState = "draining";
    this.disposePromise = this.disposeOwnedAgents();
    return this.disposePromise;
  }

  private runTransaction<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertActive("start an agent publication transaction");
    const transaction = operation();
    this.transactions.add(transaction);
    void transaction.then(
      () => this.transactions.delete(transaction),
      () => this.transactions.delete(transaction),
    );
    return transaction;
  }

  private async disposeOwnedAgents(): Promise<void> {
    await Promise.allSettled([...this.transactions]);
    const removalResults = await Promise.allSettled(
      [...this.publishedHandles].reverse().map(async ([agentId, handle]) => {
        if (this.registry.get(agentId) === handle) {
          await this.registry.remove(agentId, "agent_factory_provider_disposed");
        }
      }),
    );
    const handleResults = await Promise.allSettled(
      [...this.ownedHandles].reverse().map((handle) =>
        handle.dispose("agent_factory_provider_disposed")
      ),
    );
    this.publishedHandles.clear();
    this.ownedHandles.clear();
    this.providerState = "disposed";

    const errors = [...removalResults, ...handleResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose agent factory provider.");
    }
  }

  private assertActive(action: string): void {
    if (this.providerState !== "active") {
      throw new Error(`Cannot ${action}; agent factory provider is ${this.providerState}.`);
    }
  }
}

async function rollbackHandle(
  handle: AgentHandle | undefined,
  cause: unknown,
  action: string,
): Promise<never> {
  if (!handle) throw cause;
  try {
    await handle.dispose("agent_publication_rollback");
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      `Failed to roll back unpublished resources while attempting to ${action}.`,
    );
  }
  throw cause;
}
