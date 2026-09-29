import {
  LifecycleRuntime,
  type LifecycleDispatchInput,
  type LifecycleDispatchResult,
} from "../../../lifecycle/index.js";
import type {
  HostLifecycleModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
} from "../protocol.js";

type LifecycleModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostLifecycleModuleClient = (request: LifecycleModuleCall) => Promise<ModuleResponse>;

export type HostLifecycleModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

/**
 * LifecycleRuntime consumer that delegates hook execution to the host. The
 * host rebuilds ambient turn fields, so no process environment or hook
 * runtime object crosses the sidecar boundary.
 */
export class HostLifecycleRuntime extends LifecycleRuntime {
  constructor(
    private readonly callModule: HostLifecycleModuleClient,
    private readonly binding: HostLifecycleModuleBinding,
    private readonly uuid: () => string = () => Math.random().toString(36).slice(2),
  ) {
    super();
  }

  override async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    const response = await this.callModule({
      ...this.binding,
      requestId: `lifecycle-dispatch-${this.uuid()}`,
      module: "lifecycle",
      recordFailure: true,
      payload: {
        operation: "dispatch" satisfies HostLifecycleModuleMethod,
        event: input.event,
        ...(input.payload ? { payload: input.payload } : {}),
      },
    });
    if (!response.ok) throw moduleFailure(response);
    return parseDispatchResult(response.payload?.result);
  }
}

export function createHostLifecycleRuntime(
  callModule: HostLifecycleModuleClient,
  binding: HostLifecycleModuleBinding,
  uuid?: () => string,
): LifecycleRuntime {
  return new HostLifecycleRuntime(callModule, binding, uuid);
}

function parseDispatchResult(value: unknown): LifecycleDispatchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lifecycle module response must contain a dispatch result.");
  }
  const result = value as Partial<LifecycleDispatchResult>;
  if (
    !Array.isArray(result.effects)
    || !Array.isArray(result.messages)
    || !Array.isArray(result.events)
    || !Array.isArray(result.blockingErrors)
    || !Array.isArray(result.nonBlockingErrors)
    || (result.pendingAsyncHooks !== undefined && !Array.isArray(result.pendingAsyncHooks))
  ) {
    throw new Error("Lifecycle module response has an invalid dispatch result.");
  }
  return result as LifecycleDispatchResult;
}

function moduleFailure(response: ModuleResponse): Error & { code?: string } {
  const error = new Error(
    String(response.error?.message ?? response.code ?? "Lifecycle module failed."),
  ) as Error & { code?: string };
  error.code = response.code;
  return error;
}
