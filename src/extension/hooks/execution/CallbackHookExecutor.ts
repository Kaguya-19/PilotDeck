import type { PilotDeckHookInput } from "../protocol/input.js";
import type { PilotDeckHookCommand } from "../protocol/settings.js";
import type { PilotDeckHookOutput } from "../protocol/output.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { CommandHookExecutionResult } from "./CommandHookExecutor.js";

export type CallbackHookHandler = (input: {
  hookInput: PilotDeckHookInput;
  signal?: AbortSignal;
}) => Promise<PilotDeckHookOutput | string | void> | PilotDeckHookOutput | string | void;

export type CallbackHookRegistration = {
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  dispose(): void;
};

export type CallbackHookExecutorState = "active" | "draining" | "disposed";

type CallbackEntry = {
  handler: CallbackHookHandler;
  registration: CallbackHookRegistrationImpl;
};

export class CallbackHookExecutor {
  private readonly callbacks = new Map<string, CallbackEntry>();
  private generation = 0;
  private state: CallbackHookExecutorState = "active";
  private inFlight = 0;
  private drainPromise?: Promise<void>;
  private resolveDrain?: () => void;

  get lifecycleState(): CallbackHookExecutorState {
    return this.state;
  }

  register(name: string, handler: CallbackHookHandler): CallbackHookRegistration {
    this.assertActive("register a callback hook");
    const normalized = name.trim();
    if (normalized.length === 0) throw new Error("Callback hook name must not be empty.");
    this.callbacks.get(normalized)?.registration.deactivate();
    const generation = ++this.generation;
    let registration: CallbackHookRegistrationImpl;
    registration = new CallbackHookRegistrationImpl(normalized, generation, () => {
      const current = this.callbacks.get(normalized);
      if (current?.registration !== registration) return;
      this.callbacks.delete(normalized);
    });
    this.callbacks.set(normalized, { handler, registration });
    return registration;
  }

  unregister(name: string): boolean {
    this.assertActive("unregister a callback hook");
    const entry = this.callbacks.get(name);
    if (!entry) return false;
    this.callbacks.delete(name);
    entry.registration.deactivate();
    return true;
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "draining";
    for (const entry of this.callbacks.values()) entry.registration.deactivate();
    this.callbacks.clear();
    if (this.inFlight > 0) {
      this.drainPromise ??= new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
      await this.drainPromise;
    }
    this.state = "disposed";
  }

  async execute(options: {
    hook: Extract<PilotDeckHookCommand, { type: "callback" }>;
    hookInput: PilotDeckHookInput;
    signal?: AbortSignal;
  }): Promise<CommandHookExecutionResult> {
    const entry = this.callbacks.get(options.hook.name);
    if (!entry) {
      return {
        stdout: "",
        stderr: `Callback hook ${options.hook.name} is not registered.`,
        outcome: "non_blocking_error",
        output: { type: "sync" },
      };
    }

    this.inFlight += 1;
    try {
      const result = await entry.handler({ hookInput: options.hookInput, signal: options.signal });
      if (typeof result === "string") {
        return {
          stdout: result,
          stderr: "",
          exitCode: 0,
          outcome: "success",
          output: parseHookOutput(result),
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        outcome: "success",
        output: result ?? { type: "sync" },
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outcome: "non_blocking_error",
        output: { type: "sync" },
      };
    } finally {
      this.inFlight -= 1;
      if (this.state === "draining" && this.inFlight === 0) {
        this.resolveDrain?.();
        this.resolveDrain = undefined;
        this.drainPromise = undefined;
      }
    }
  }

  private assertActive(action: string): void {
    if (this.state !== "active") {
      throw new Error(`Cannot ${action}; callback hook executor is ${this.state}.`);
    }
  }
}

class CallbackHookRegistrationImpl implements CallbackHookRegistration {
  private activeState = true;

  constructor(
    readonly name: string,
    readonly generation: number,
    private readonly remove: () => void,
  ) {}

  get active(): boolean {
    return this.activeState;
  }

  dispose(): void {
    if (!this.activeState) return;
    this.activeState = false;
    this.remove();
  }

  deactivate(): void {
    this.activeState = false;
  }
}
