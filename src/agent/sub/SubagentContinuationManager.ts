import { randomUUID } from "node:crypto";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentHandle } from "../scope/AgentHandle.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { SubagentDefinition } from "./builtinSubagentTypes.js";
import type { ContinuableSubagentCreateSpec } from "./SubagentProvider.js";
import type { SubagentProviderRegistry } from "./SubagentProviderRegistry.js";
import {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  type ContinuableSubagentDescriptorData,
} from "./SubagentDescriptor.js";

export type SubagentContinuationManagerState = "active" | "draining" | "disposed";

export type ContinuableSubagentMaterializeRequest = {
  childSessionId: string;
  parent: AgentHandle;
  definition: SubagentDefinition;
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  provider: string;
  providerGeneration: number;
  descriptor: ContinuableSubagentDescriptorData;
  spec: ContinuableSubagentCreateSpec;
  abortSignal?: AbortSignal;
};

export type ContinuableSubagentInspectRequest = {
  childSessionId: string;
  parent: AgentHandle;
  abortSignal?: AbortSignal;
};

export type ContinuableSubagentInspection = {
  entries: readonly AgentTranscriptEntry[];
};

export type ContinuableSubagentResumeRequest = {
  childSessionId: string;
  parent: AgentHandle;
  descriptor: ContinuableSubagentDescriptorData;
  abortSignal?: AbortSignal;
};

/** Host composition required by the manager after provider preparation. */
export type SubagentContinuationHost = {
  create(request: ContinuableSubagentMaterializeRequest): Promise<AgentHandle>;
  inspect(request: ContinuableSubagentInspectRequest): Promise<ContinuableSubagentInspection>;
  resume(request: ContinuableSubagentResumeRequest): Promise<AgentHandle>;
};

export type StartContinuableSubagentRequest = {
  provider: string;
  label: string;
  childSessionId?: string;
  parent: AgentHandle;
  definition: SubagentDefinition;
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  input: AgentInput;
  submitOptions?: Omit<AgentSubmitOptions, "turnId">;
  abortSignal?: AbortSignal;
};

export type FollowupContinuableSubagentRequest = {
  childSessionId: string;
  parent: AgentHandle;
  input: AgentInput;
  submitOptions?: Omit<AgentSubmitOptions, "turnId">;
  abortSignal?: AbortSignal;
};

export type ContinuableSubagentAdmission = {
  childSessionId: string;
  itemId: string;
  turnId: string;
};

export type ContinuableSubagentActivationSnapshot = {
  childSessionId: string;
  parentSessionId: string;
  provider: string;
  /** Fresh activations retain the preparing generation; cold resume is provider-independent. */
  providerGeneration?: number;
  state: "active" | "draining";
};

/** Residency derived from the child handle and its owned-child set. */
export type ContinuableSubagentResidencyState = "running" | "waiting" | "settled";

/** Terminal outcome used for parent settlement notices. */
export type ContinuableSubagentTerminalState = "completed" | "aborted" | "failed" | "unknown";

export type SubagentContinuationManagerOptions = {
  providers: SubagentProviderRegistry;
  host: SubagentContinuationHost;
  agents: SubagentContinuationAgentDirectory;
  uuid?: () => string;
};

/** Minimal live identity lookup required for parent authorization. */
export type SubagentContinuationAgentDirectory = {
  get(sessionId: string): AgentHandle | undefined;
};

type Activation = {
  childSessionId: string;
  parent: AgentHandle;
  provider: string;
  providerGeneration?: number;
  handle: AgentHandle;
  /** Direct continuation children owned by this live activation. */
  ownedChildren: Set<string>;
  /** Parent activation, when the direct parent is itself continuable. */
  parentActivation?: Activation;
  /** Prevents a settled child from being reclaimed by a racing watcher. */
  watcher?: Promise<void>;
  /** Wakes a parent watcher when a child is released or new work is admitted. */
  wake?: Deferred<void>;
  /** Whether the caller received an accepted message id for this activation. */
  announced?: boolean;
  /** Removes the teardown propagation hook after the activation is released. */
  removeDisposeStartListener?: () => void;
  disposal?: Promise<void>;
};

/**
 * Owns continuable child handles. Providers only prepare detached creation
 * data; all initial and later turns enter the child Agent's durable inbox.
 */
export class SubagentContinuationManager {
  private managerState: SubagentContinuationManagerState = "active";
  private readonly activations = new Map<string, Activation>();
  private readonly transactions = new Set<Promise<unknown>>();
  private readonly locks = new ChildOperationLock();
  private disposePromise?: Promise<void>;

  constructor(private readonly options: SubagentContinuationManagerOptions) {}

  get state(): SubagentContinuationManagerState {
    return this.managerState;
  }

  get size(): number {
    return this.activations.size;
  }

  has(childSessionId: string): boolean {
    return this.activations.has(childSessionId);
  }

  /** Return the derived residency of one live activation. */
  activationState(childSessionId: string): ContinuableSubagentResidencyState | undefined {
    const activation = this.activations.get(childSessionId);
    return activation ? this.stateOf(activation) : undefined;
  }

  snapshot(): readonly ContinuableSubagentActivationSnapshot[] {
    return [...this.activations.values()].map((activation) => ({
      childSessionId: activation.childSessionId,
      parentSessionId: activation.parent.sessionId,
      provider: activation.provider,
      ...(activation.providerGeneration === undefined
        ? {}
        : { providerGeneration: activation.providerGeneration }),
      state: activation.disposal ? "draining" : "active",
    }));
  }

  async start(request: StartContinuableSubagentRequest): Promise<ContinuableSubagentAdmission> {
    this.assertActive("start a continuable subagent");
    const childSessionId = requireId(
      request.childSessionId ?? this.options.uuid?.() ?? randomUUID(),
      "childSessionId",
    );
    const parentSessionId = this.authorizeLiveParent(request.parent);
    if (childSessionId === parentSessionId) {
      throw new Error("A continuable subagent cannot use its parent session id.");
    }
    const provider = requireId(request.provider, "provider").trim();
    const agentProvider = request.parentConfig.subagentModel?.provider ?? request.parentConfig.provider;
    const agentModel = request.parentConfig.subagentModel?.model ?? request.parentConfig.model;
    const descriptor = snapshotSubagentDescriptor({
      mode: "continuable",
      provider,
      definitionId: request.definition.id,
      parentSessionId,
      label: request.label,
      agentProvider,
      agentModel,
    });
    const itemId = this.nextId();
    const turnId = this.nextId();
    return this.runTransaction(() => this.locks.run(childSessionId, async () => {
      this.assertActive("start a continuable subagent");
      this.authorizeLiveParent(request.parent);
      if (this.activations.has(childSessionId)) {
        throw new Error(`Continuable subagent already exists: ${childSessionId}`);
      }
      throwIfAborted(request.abortSignal, "continuable subagent start");
      const prepared = await this.options.providers.prepareContinuable(provider, {
        subagentSessionId: childSessionId,
        parentSessionId,
        definition: request.definition,
        parentConfig: request.parentConfig,
        parentDependencies: request.parentDependencies,
        abortSignal: request.abortSignal,
      });
      this.assertActive("materialize a continuable subagent");
      throwIfAborted(request.abortSignal, "continuable subagent start");
      this.authorizeLiveParent(request.parent);

      let handle: AgentHandle | undefined;
      try {
        handle = await this.options.host.create({
          childSessionId,
          parent: request.parent,
          definition: request.definition,
          parentConfig: request.parentConfig,
          parentDependencies: request.parentDependencies,
          provider: prepared.provider,
          providerGeneration: prepared.generation,
          descriptor,
          spec: prepared.spec,
          abortSignal: request.abortSignal,
        });
        const childHandle = handle;
        this.assertActive("publish a continuable subagent");
        throwIfAborted(request.abortSignal, "continuable subagent start");
        this.authorizeLiveParent(request.parent);
        if (this.activations.has(childSessionId)) {
          throw new Error(`Continuable subagent already exists: ${childSessionId}`);
        }
        const activation: Activation = {
          childSessionId,
          parent: request.parent,
          provider: prepared.provider,
          providerGeneration: prepared.generation,
          handle,
          ownedChildren: new Set(),
        };
        this.activations.set(childSessionId, activation);
        this.acquireOwnership(activation);
        if (typeof handle.addDisposeStartListener === "function") {
          activation.removeDisposeStartListener = handle.addDisposeStartListener(() =>
            this.drainDescendants(childHandle, "parent_agent_disposed"));
        }
        await handle.session.recordSubagentDescriptor(turnId, descriptor);
        this.authorizeLiveParent(request.parent);
        const accepted = await handle.followup(request.input, {
          ...request.submitOptions,
          itemId,
          turnId,
          abortSignal: request.abortSignal,
          authorizeAdmission: () => this.authorizeActivationParent(
            activation,
            request.parent,
            childSessionId,
          ),
        });
        activation.announced = true;
        this.watchSettlement(activation);
        return { childSessionId, ...accepted };
      } catch (error) {
        if (handle) {
          const activation = this.activations.get(childSessionId);
          if (activation?.handle === handle) {
            await this.rollbackActivation(activation, error);
          } else {
            await rollbackHandle(handle, error);
          }
        }
        throw error;
      }
    }));
  }

  async followup(request: FollowupContinuableSubagentRequest): Promise<ContinuableSubagentAdmission> {
    this.assertActive("follow up a continuable subagent");
    const childSessionId = requireId(request.childSessionId, "childSessionId");
    this.authorizeLiveParent(request.parent);
    return this.runTransaction(() => this.locks.run(childSessionId, async () => {
      this.assertActive("follow up a continuable subagent");
      throwIfAborted(request.abortSignal, "continuable subagent follow-up");
      this.authorizeLiveParent(request.parent);
      const activation = this.activations.get(childSessionId);
      if (!activation) return this.coldResume(request, childSessionId);
      this.authorizeActivationParent(activation, request.parent, childSessionId);
      if (activation.disposal) {
        await Promise.allSettled([activation.disposal]);
        this.assertActive("cold resume a releasing continuable subagent");
        this.authorizeLiveParent(request.parent);
        return this.coldResume(request, childSessionId);
      }
      const accepted = await this.admit(activation.handle, request);
      return { childSessionId, ...accepted };
    }));
  }

  async disposeChild(childSessionId: string, reason = "continuable_subagent_disposed"): Promise<boolean> {
    this.assertActive("dispose a continuable subagent");
    const normalized = requireId(childSessionId, "childSessionId");
    return this.runTransaction(() => this.locks.run(normalized, async () => {
      const activation = this.activations.get(normalized);
      if (!activation) return false;
      await this.disposeActivation(activation, reason);
      return true;
    }));
  }

  /**
   * Drain all direct and nested continuation children of one exact parent
   * handle. This is called from the parent's dispose-start hook, before the
   * parent releases its own scope/resources. The handle may already be in
   * `draining`; object identity, not session id, is the authority here.
   */
  async drainDescendants(parent: AgentHandle, reason = "parent_agent_disposed"): Promise<void> {
    const targets = [...this.activations.values()].filter((activation) =>
      activation.parent === parent || activation.parentActivation?.handle === parent
      || this.isOwnedBy(activation, parent));
    const roots = targets.filter((activation) => !targets.some((candidate) =>
      candidate !== activation && candidate.ownedChildren.has(activation.childSessionId)));
    const results = await Promise.allSettled(
      roots.map((activation) => this.disposeActivation(activation, reason)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose continuable descendants.");
    }
  }

  dispose(reason = "subagent_continuation_manager_disposed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.managerState = "draining";
    this.disposePromise = this.finishDispose(reason);
    return this.disposePromise;
  }

  private async finishDispose(reason: string): Promise<void> {
    await Promise.allSettled([...this.transactions]);
    const results = await Promise.allSettled(
      [...this.activations.values()].reverse().map((activation) =>
        this.locks.run(activation.childSessionId, () => this.disposeActivation(activation, reason))
      ),
    );
    this.managerState = "disposed";
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose continuable subagents.");
    }
  }

  private disposeActivation(activation: Activation, reason: string): Promise<void> {
    if (activation.disposal) return activation.disposal;
    // A waiting parent watcher is suspended on its child/admission wake signal,
    // not on `whenIdle()` (which is already resolved in that residency). Wake
    // it so disposal cannot leave an observer retained on a dormant promise.
    this.wake(activation);
    activation.disposal = this.finishActivationDisposal(activation, reason);
    return activation.disposal;
  }

  private async finishActivationDisposal(activation: Activation, reason: string): Promise<void> {
    const childDisposals = [...activation.ownedChildren]
      .map((childSessionId) => this.activations.get(childSessionId))
      .filter((child): child is Activation => child !== undefined)
      .map((child) => this.disposeActivation(child, `parent_${reason}`));
    const errors: unknown[] = [];
    const childResults = await Promise.allSettled(childDisposals);
    for (const result of childResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    // Snapshot the terminal result while the child session's projections and
    // storage are still live. AgentHandle.dispose() tears those resources down
    // by design, so reading the session afterwards would turn a clean child
    // completion into a spurious projection-disposed failure.
    let terminal = terminalFor(activation.handle, errors[0]);
    let disposalError: unknown;
    try {
      await activation.handle.dispose(reason);
    } catch (error) {
      disposalError = error;
      errors.push(error);
      terminal = terminalFor(activation.handle, disposalError);
    }

    // Keep the activation's ownership edge until after the parent notice is
    // admitted. Otherwise the parent's watcher could observe itself childless
    // and dispose the parent before this terminal account is delivered.
    if (this.activations.get(activation.childSessionId) === activation) {
      this.activations.delete(activation.childSessionId);
    }
    activation.removeDisposeStartListener?.();
    activation.removeDisposeStartListener = undefined;
    await this.notifySettlement(activation, terminal);
    this.releaseOwnership(activation);
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose continuable subagent ${activation.childSessionId}.`);
    }
  }

  /** Install an ownership edge before the child can accept its first turn. */
  private acquireOwnership(activation: Activation): void {
    const parentActivation = [...this.activations.values()].find((candidate) =>
      candidate !== activation && candidate.handle === activation.parent,
    );
    if (!parentActivation) return;
    if (parentActivation.disposal) {
      throw new Error(`Continuable parent is already disposing: ${activation.parent.sessionId}`);
    }
    activation.parentActivation = parentActivation;
    parentActivation.ownedChildren.add(activation.childSessionId);
  }

  /** Remove an ownership edge after child teardown, then wake its parent watcher. */
  private releaseOwnership(activation: Activation): void {
    const parentActivation = activation.parentActivation;
    if (!parentActivation) return;
    parentActivation.ownedChildren.delete(activation.childSessionId);
    activation.parentActivation = undefined;
    this.wake(parentActivation);
  }

  private isOwnedBy(activation: Activation, parent: AgentHandle): boolean {
    let current = activation.parentActivation;
    while (current) {
      if (current.handle === parent) return true;
      current = current.parentActivation;
    }
    return false;
  }

  private wake(activation: Activation): void {
    activation.wake?.resolve();
    activation.wake = deferred();
  }

  private stateOf(activation: Activation): ContinuableSubagentResidencyState {
    if (activation.disposal) return "settled";
    if (activation.handle.state !== "active") return "running";
    const pendingTurns = typeof activation.handle.pendingTurns === "function"
      ? activation.handle.pendingTurns().length
      : 0;
    if (activation.handle.inFlight > 0 || pendingTurns > 0) return "running";
    if (activation.ownedChildren.size > 0) return "waiting";
    return "settled";
  }

  /**
   * Observe the one real Agent idle boundary and settle only when no owned
   * child remains. Handles supplied by legacy test-only adapters may not expose
   * `whenIdle`; those adapters retain their explicit-dispose behavior.
   */
  private watchSettlement(activation: Activation): void {
    if (typeof activation.handle.whenIdle !== "function") return;
    activation.wake = deferred();
    activation.watcher = (async () => {
      while (this.activations.get(activation.childSessionId) === activation && !activation.disposal) {
        const state = this.stateOf(activation);
        if (state === "running") {
          await activation.handle.whenIdle();
          continue;
        }
        if (state === "waiting") {
          const wake = (activation.wake ??= deferred()).promise;
          // This activation is known idle while an owned child remains. Racing
          // the already-resolved idle promise would spin indefinitely; later
          // child release, new admitted work, or disposal explicitly wakes it.
          await wake;
          continue;
        }
        const settling = await this.locks.run(activation.childSessionId, async () => {
          if (this.activations.get(activation.childSessionId) !== activation || activation.disposal) {
            return false;
          }
          if (this.stateOf(activation) !== "settled") return false;
          void this.disposeActivation(activation, "continuable_subagent_settled").catch(() => undefined);
          return true;
        });
        if (settling) {
          const disposal: Promise<void> | undefined = activation.disposal;
          await Promise.allSettled([disposal]);
          return;
        }
      }
    })();
  }

  private async rollbackActivation(activation: Activation, cause: unknown): Promise<never> {
    try {
      await this.disposeActivation(activation, "continuable_subagent_admission_rollback");
    } catch (rollbackError) {
      throw new AggregateError(
        [cause, rollbackError],
        "Failed to roll back a continuable subagent before admission.",
      );
    }
    throw cause;
  }

  private async notifySettlement(
    activation: Activation,
    terminal: { state: ContinuableSubagentTerminalState; detail?: string },
  ): Promise<void> {
    // A failed pre-admission materialization never returned an id and therefore
    // owes the parent no settlement notice.
    if (activation.disposal === undefined || !activation.announced) return;
    const parent = activation.parent;
    if (!this.isLiveParent(parent)) return;
    const detail = terminal.detail ? ` (${terminal.detail})` : "";
    const text = `Continuable subagent ${activation.childSessionId} settled: ${terminal.state}${detail}.`;
    if (typeof parent.followup !== "function") return;
    // The durable parent admission must happen while this ownership edge still
    // exists. Releasing it first would let an idle continuable parent settle
    // and discard the notice in the enqueue microtask.
    await parent.followup({ type: "text", text }).catch(() => undefined);
  }

  private async coldResume(
    request: FollowupContinuableSubagentRequest,
    childSessionId: string,
  ): Promise<ContinuableSubagentAdmission> {
    let inspection: ContinuableSubagentInspection;
    try {
      inspection = await this.options.host.inspect({
        childSessionId,
        parent: request.parent,
        abortSignal: request.abortSignal,
      });
    } catch (error) {
      throwIfAborted(request.abortSignal, "continuable subagent cold resume");
      throw new Error(`Continuable subagent is not resumable: ${childSessionId}`, { cause: error });
    }
    this.assertActive("cold resume a continuable subagent");
    throwIfAborted(request.abortSignal, "continuable subagent cold resume");
    const parentSessionId = this.authorizeLiveParent(request.parent);

    let descriptor;
    try {
      // Fork prefixes retain their source sessionId in PilotDeck's event
      // envelope, so the child log itself identifies its owned suffix.
      descriptor = foldSubagentDescriptor(
        inspection.entries.filter((entry) => entry.sessionId === childSessionId),
      );
    } catch (error) {
      throw new Error(`Continuable subagent has invalid durable state: ${childSessionId}`, { cause: error });
    }
    if (!descriptor || descriptor.mode !== "continuable") {
      throw new Error(`Continuable subagent is not resumable: ${childSessionId}`);
    }
    this.authorizeParent(descriptor.parentSessionId, parentSessionId, childSessionId);

    let handle: AgentHandle | undefined;
    try {
      handle = await this.options.host.resume({
        childSessionId,
        parent: request.parent,
        descriptor,
        abortSignal: request.abortSignal,
      });
      const childHandle = handle;
      this.assertActive("publish a cold-resumed continuable subagent");
      throwIfAborted(request.abortSignal, "continuable subagent cold resume");
      this.authorizeLiveParent(request.parent);
      if (this.activations.has(childSessionId)) {
        throw new Error(`Continuable subagent already exists: ${childSessionId}`);
      }
      const activation: Activation = {
        childSessionId,
        parent: request.parent,
        provider: descriptor.provider,
        handle,
        ownedChildren: new Set(),
      };
      this.activations.set(childSessionId, activation);
      this.acquireOwnership(activation);
      if (typeof handle.addDisposeStartListener === "function") {
        activation.removeDisposeStartListener = handle.addDisposeStartListener(() =>
          this.drainDescendants(childHandle, "parent_agent_disposed"));
      }
      const accepted = await this.admit(handle, request);
      activation.announced = true;
      this.watchSettlement(activation);
      return { childSessionId, ...accepted };
    } catch (error) {
      if (handle) {
        const activation = this.activations.get(childSessionId);
        if (activation?.handle === handle) {
          await this.rollbackActivation(activation, error);
        } else {
          await rollbackHandle(handle, error);
        }
      }
      throw error;
    }
  }

  private admit(
    handle: AgentHandle,
    request: FollowupContinuableSubagentRequest,
  ): Promise<{ itemId: string; turnId: string }> {
    return handle.followup(request.input, {
      ...request.submitOptions,
      itemId: this.nextId(),
      turnId: this.nextId(),
      abortSignal: request.abortSignal,
      authorizeAdmission: () => {
        const activation = this.activations.get(request.childSessionId);
        if (!activation || activation.handle !== handle) {
          throw new Error(`Continuable subagent is not active: ${request.childSessionId}`);
        }
        this.authorizeActivationParent(activation, request.parent, request.childSessionId);
      },
    }).then((accepted) => {
      const activation = this.activations.get(request.childSessionId);
      if (activation?.handle === handle) this.wake(activation);
      return accepted;
    });
  }

  private authorizeActivationParent(
    activation: Activation,
    parent: AgentHandle,
    childSessionId: string,
  ): string {
    const parentSessionId = this.authorizeLiveParent(parent);
    if (activation.parent !== parent) {
      throw new Error(`Continuable subagent ${childSessionId} belongs to another live parent agent.`);
    }
    return parentSessionId;
  }

  private authorizeLiveParent(parent: AgentHandle): string {
    const parentSessionId = requireId(parent.sessionId, "parent.sessionId");
    if (!this.isLiveParent(parent)) {
      throw new Error(`Continuable subagent operation requires the exact live parent agent: ${parentSessionId}`);
    }
    return parentSessionId;
  }

  /** A nested parent is live through its exact manager activation, not Gateway registry membership. */
  private isLiveParent(parent: AgentHandle): boolean {
    if (parent.state !== "active") return false;
    if (this.options.agents.get(parent.sessionId) === parent) return true;
    const continuationParent = this.activations.get(parent.sessionId);
    return continuationParent?.handle === parent && continuationParent.disposal === undefined;
  }

  private authorizeParent(
    expectedParentSessionId: string,
    actualParentSessionId: string,
    childSessionId: string,
  ): void {
    if (expectedParentSessionId !== actualParentSessionId) {
      throw new Error(`Continuable subagent ${childSessionId} belongs to another parent session.`);
    }
  }

  private runTransaction<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertActive("start a continuation transaction");
    const transaction = operation();
    this.transactions.add(transaction);
    void transaction.then(
      () => this.transactions.delete(transaction),
      () => this.transactions.delete(transaction),
    );
    return transaction;
  }

  private assertActive(action: string): void {
    if (this.managerState !== "active") {
      throw new Error(`Cannot ${action}; subagent continuation manager is ${this.managerState}.`);
    }
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }
}

class ChildOperationLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<Result>(childSessionId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(childSessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(childSessionId, tail);
    void tail.then(() => {
      if (this.tails.get(childSessionId) === tail) this.tails.delete(childSessionId);
    });
    return result;
  }
}

async function rollbackHandle(handle: AgentHandle, cause: unknown): Promise<never> {
  try {
    await handle.dispose("continuable_subagent_admission_rollback");
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Failed to roll back a continuable subagent before admission.",
    );
  }
  throw cause;
}

function throwIfAborted(signal: AbortSignal | undefined, action: string): void {
  if (!signal?.aborted) return;
  throw new Error(`${action} aborted: ${String(signal.reason ?? "aborted")}`);
}

function requireId(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty.`);
  return value;
}

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value | PromiseLike<Value>): void;
  reject(reason?: unknown): void;
};

function deferred(): Deferred<void> {
  let resolve!: (value: void | PromiseLike<void>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function terminalFor(
  handle: AgentHandle,
  disposalError: unknown,
): { state: ContinuableSubagentTerminalState; detail?: string } {
  if (disposalError !== undefined) {
    return { state: "failed", detail: renderError(disposalError) };
  }
  const status = handle.session.snapshot?.().status;
  if (!status) return { state: "unknown" };
  if (status === "aborted") return { state: "aborted" };
  if (status === "failed") return { state: "failed" };
  return status === "idle" ? { state: "completed" } : { state: "unknown" };
}

function renderError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unrenderable disposal error";
  }
}
