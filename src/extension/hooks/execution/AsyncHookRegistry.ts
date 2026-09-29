import type { PilotDeckHookEvent } from "../protocol/events.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { PilotDeckHookOutput, PilotDeckHookSyncOutput } from "../protocol/output.js";

export type PendingAsyncHook = {
  id: string;
  startedAt: Date;
  hookName: string;
  hookEvent: PilotDeckHookEvent;
  stdout: string;
  stderr: string;
  responseDelivered: boolean;
  asyncRewake?: boolean;
  generation?: number;
  /** Set only through complete(); an async declaration is not a completion. */
  completion?: {
    stdout: string;
    stderr: string;
    output: PilotDeckHookSyncOutput;
  };
};

export type AsyncHookRegistryState = "active" | "draining" | "disposed";

export type AsyncHookRegistration = {
  readonly id: string;
  readonly generation: number;
  readonly active: boolean;
  dispose(): void;
};

export type AsyncHookResponse = {
  id: string;
  hookName: string;
  hookEvent: PilotDeckHookEvent;
  stdout: string;
  stderr: string;
  output: PilotDeckHookOutput;
  rewake: boolean;
};

export type PendingAsyncHookDescriptor = {
  id: string;
  generation: number;
  hookName: string;
  hookEvent: PilotDeckHookEvent;
  startedAt: Date;
};

export type AsyncHookCompletion = {
  stdout?: string;
  stderr?: string;
  /** A completed async hook must resolve to a terminal sync output. */
  output?: PilotDeckHookSyncOutput;
};

export class AsyncHookRegistry {
  private readonly hooks = new Map<string, PendingAsyncHook>();
  private state: AsyncHookRegistryState = "active";
  private generation = 0;

  get lifecycleState(): AsyncHookRegistryState {
    return this.state;
  }

  register(hook: PendingAsyncHook): AsyncHookRegistration {
    if (this.state !== "active") {
      throw new Error(`Cannot register an async hook; registry is ${this.state}.`);
    }
    const generation = ++this.generation;
    hook.generation = generation;
    this.hooks.set(hook.id, hook);
    const registry = this;
    let active = true;
    return {
      id: hook.id,
      generation,
      get active() { return active && registry.hooks.get(hook.id) === hook; },
      dispose: () => {
        if (!active) return;
        active = false;
        this.hooks.delete(hook.id);
      },
    };
  }

  list(): PendingAsyncHook[] {
    return [...this.hooks.values()];
  }

  describe(id: string): PendingAsyncHookDescriptor | undefined {
    const hook = this.hooks.get(id);
    if (!hook || hook.generation === undefined) return undefined;
    return {
      id: hook.id,
      generation: hook.generation,
      hookName: hook.hookName,
      hookEvent: hook.hookEvent,
      startedAt: new Date(hook.startedAt),
    };
  }

  /**
   * Resume a pending hook only when its external owner has produced a
   * terminal result. Late completions after cancellation/disposal are ignored.
   */
  complete(id: string, completion: AsyncHookCompletion = {}): boolean {
    if (this.state !== "active") return false;
    const hook = this.hooks.get(id);
    if (!hook || hook.responseDelivered || hook.completion) return false;
    const stdout = completion.stdout ?? hook.stdout;
    const output = completion.output ?? parseHookOutput(stdout);
    if (output.type === "async") return false;
    hook.completion = {
      stdout,
      stderr: completion.stderr ?? hook.stderr,
      output,
    };
    return true;
  }

  /** Cancel a pending hook without manufacturing a successful response. */
  cancel(id: string): boolean {
    if (this.state !== "active") return false;
    return this.hooks.delete(id);
  }

  collectResponses(): AsyncHookResponse[] {
    const responses: AsyncHookResponse[] = [];
    for (const hook of this.hooks.values()) {
      if (hook.responseDelivered || !hook.completion) {
        continue;
      }
      hook.responseDelivered = true;
      responses.push({
        id: hook.id,
        hookName: hook.hookName,
        hookEvent: hook.hookEvent,
        stdout: hook.completion.stdout,
        stderr: hook.completion.stderr,
        output: hook.completion.output,
        rewake: hook.asyncRewake === true && isBlockingOutput(hook.completion.output),
      });
    }
    return responses;
  }

  removeDelivered(): void {
    for (const hook of this.hooks.values()) {
      if (hook.responseDelivered) {
        this.hooks.delete(hook.id);
      }
    }
  }

  clear(): void {
    this.hooks.clear();
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "draining";
    this.clear();
    this.state = "disposed";
  }
}

function isBlockingOutput(output: PilotDeckHookOutput): boolean {
  return output.type === "sync" && (output.continue === false || output.decision === "block");
}
