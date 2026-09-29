import type { CanonicalMessage } from "../../model/index.js";
import type { PilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import type { PilotDeckHookBaseInput } from "../../extension/hooks/protocol/input.js";
import type { PilotDeckHookEffect, PilotDeckLifecycleError } from "./effects.js";
import type { PendingAsyncHookDescriptor } from "../../extension/hooks/execution/AsyncHookRegistry.js";

export type LifecycleDispatchInput = {
  event: PilotDeckHookEvent;
  baseInput: PilotDeckHookBaseInput;
  payload?: Record<string, unknown>;
  matchQuery?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type LifecycleDispatchResult = {
  effects: PilotDeckHookEffect[];
  messages: CanonicalMessage[];
  events: unknown[];
  blockingErrors: PilotDeckLifecycleError[];
  nonBlockingErrors: PilotDeckLifecycleError[];
  /** Present for HookRuntime-backed dispatch; legacy null adapters may omit it. */
  pendingAsyncHooks?: PendingAsyncHookDescriptor[];
};

export function emptyLifecycleDispatchResult(): LifecycleDispatchResult {
  return {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
    pendingAsyncHooks: [],
  };
}
