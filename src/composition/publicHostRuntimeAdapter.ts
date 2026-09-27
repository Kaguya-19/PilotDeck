/**
 * Adapter from the fixed runtime Port selection to the public host-capability
 * RPC shape.  The root supplies the already-selected native/external/disabled
 * Ports; this file never constructs a model runtime, registry, skill store,
 * task state machine, or permission context.
 */
import type { PublicCapabilityResponse, PublicHostCapabilityProvider, PublicHostPrincipal } from "./nativeHostCapabilityProvider.js";

type AbortOptions = { signal?: AbortSignal; principal: PublicHostPrincipal };
type PortMethod = (...args: any[]) => any;

export type PublicRuntimePortSelection = {
  profile: {
    id: string;
    defaultSelection?: { provider: string; model: string };
  };
  model: {
    catalog?: PortMethod;
    prepare?: PortMethod;
    stream?: PortMethod;
  };
  tools: {
    list?: PortMethod;
    test?: PortMethod;
    create?: PortMethod;
    update?: PortMethod;
    probe?: PortMethod;
    remove?: PortMethod;
  };
  skills: {
    list?: PortMethod;
    import?: PortMethod;
    publish?: PortMethod;
    archive?: PortMethod;
    test?: PortMethod;
  };
  file?: { parse?: PortMethod };
  task?: {
    start?: PortMethod;
    status?: PortMethod;
    result?: PortMethod;
    cancel?: PortMethod;
    events?: PortMethod;
  };
  /** Existing session/permission owner; no invented public session IDs. */
  context: {
    forTool: (principal: PublicHostPrincipal, input: unknown, signal?: AbortSignal) => unknown;
  };
};

const METHOD_PORTS = {
  list_tools: ["tools", "list"], test_tool: ["tools", "test"], create_tool: ["tools", "create"],
  update_tool: ["tools", "update"], probe_unsaved_tool: ["tools", "probe"], remove_tool: ["tools", "remove"],
  list_general_skills: ["skills", "list"], import_general_skill: ["skills", "import"],
  publish_general_skill: ["skills", "publish"], archive_general_skill: ["skills", "archive"], test_general_skill: ["skills", "test"],
  list_model_catalog: ["model", "catalog"], model_prepare: ["model", "prepare"], model_stream: ["model", "stream"],
  file_parse: ["file", "parse"], task_start: ["task", "start"], task_status: ["task", "status"],
  task_result: ["task", "result"], task_cancel: ["task", "cancel"], task_events: ["task", "events"],
} as const;

function unavailable(operation: string, port: string): PublicCapabilityResponse {
  return {
    status: 503,
    body: { code: "PUBLIC_HOST_PORT_UNAVAILABLE", operation, port, message: `Selected runtime has no ${port} capability.` },
  };
}

function invalid(message: string): PublicCapabilityResponse {
  return { status: 400, body: { code: "PUBLIC_HOST_INPUT_INVALID", message } };
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function methodFor(selection: PublicRuntimePortSelection, operation: string): { method?: PortMethod; port: string } {
  const entry = (METHOD_PORTS as Record<string, readonly string[]>)[operation];
  if (!entry) return { port: "unknown" };
  const owner = selection[entry[0] as keyof PublicRuntimePortSelection] as Record<string, unknown> | undefined;
  return { method: owner?.[entry[1]] as PortMethod | undefined, port: `${entry[0]}.${entry[1]}` };
}

export const PUBLIC_RUNTIME_HOST_OPERATIONS = Object.freeze(Object.keys(METHOD_PORTS));

/** Compose the selected runtime Ports into the bounded public provider. */
export function createRuntimeHostCapabilityProvider(selection: PublicRuntimePortSelection): PublicHostCapabilityProvider {
  const operations = PUBLIC_RUNTIME_HOST_OPERATIONS.filter((operation) => Boolean(methodFor(selection, operation).method));
  const call = async (operation: string, rawInput: unknown, options: AbortOptions): Promise<PublicCapabilityResponse> => {
    const { method, port } = methodFor(selection, operation);
    if (!method) return unavailable(operation, port);
    if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
    const input = record(rawInput);
    if (!input) return invalid("input must be an object.");
    try {
      switch (operation) {
        case "list_tools": {
          const result = await method({ profileId: selection.profile.id, principal: options.principal, signal: options.signal });
          return { status: 200, body: { data: result.data ?? result.items ?? result } };
        }
        case "test_tool":
          return { status: 200, body: await method({ toolId: requiredString(input.toolId, "toolId"), input: input.body, context: selection.context.forTool(options.principal, input, options.signal), signal: options.signal }) };
        case "list_general_skills": {
          const result = await method({ ...input, profileId: selection.profile.id, principal: options.principal, signal: options.signal });
          return { status: 200, body: { data: result.items ?? result.data ?? [], next_cursor: result.nextCursor ?? result.next_cursor ?? null, ...result } };
        }
        case "import_general_skill": {
          const body = record(input.body) ?? input;
          return { status: 200, body: await method({ ...body, profileId: selection.profile.id, principal: options.principal, signal: options.signal }) };
        }
        case "list_model_catalog": {
          const result = await method({ profileId: selection.profile.id, principal: options.principal, signal: options.signal });
          return { status: 200, body: { data: result.data ?? result.items ?? result, defaultSelection: result.defaultSelection ?? selection.profile.defaultSelection } };
        }
        case "model_prepare":
        case "model_stream": {
          const result = await method({ ...input, profileId: selection.profile.id, principal: options.principal, signal: options.signal });
          return { status: 200, body: result.body ?? result, headers: result.headers };
        }
        case "file_parse": {
          const bytes = Buffer.from(requiredString(input.content_base64, "content_base64"), "base64");
          return { status: 200, body: await method({ filename: requiredString(input.filename, "filename"), mediaType: input.media_type, bytes, maxBytes: input.max_bytes, signal: options.signal }) };
        }
        case "task_start":
          return { status: 202, body: await method({ domain: requiredString(input.domain, "domain"), operation: requiredString(input.operation, "operation"), input: input.input, budget: input.budget, principal: options.principal, signal: options.signal }) };
        case "task_status":
        case "task_result":
        case "task_cancel":
        case "task_events":
          return { status: 200, body: await method({ taskId: requiredString(input.taskId, "taskId"), afterSequence: input.afterSequence, afterCursor: input.afterCursor, principal: options.principal, signal: options.signal }) };
        case "create_tool":
        case "update_tool":
        case "probe_unsaved_tool":
        case "remove_tool":
        case "publish_general_skill":
        case "archive_general_skill":
        case "test_general_skill":
          return { status: 200, body: await method({ ...input, principal: options.principal, signal: options.signal }) };
        default:
          return unavailable(operation, port);
      }
    } catch (error) {
      if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 502;
      return { status, body: error instanceof Error ? { code: error.name, message: error.message } : error };
    }
  };
  return { operations, call };
}

/** Local callback transport used by the SD/domain composition root. */
export function createRuntimeHostCallbackTransport(provider: PublicHostCapabilityProvider) {
  return (operation: string, input: unknown, options: AbortOptions) => provider.call(operation, input, options);
}

/**
 * Domain-side DI client.  SOP/Knowledge services receive this client at
 * composition time and keep their own APIJob/preview/ingest state; these
 * methods only consume the selected host capability namespace.
 */
export function createPublicDomainHostClient(transport: ReturnType<typeof createRuntimeHostCallbackTransport>) {
  const call = (operation: string, input: unknown, options: AbortOptions) => transport(operation, input, options);
  return Object.freeze({
    modelPrepare: (input: unknown, options: AbortOptions) => call("model_prepare", input, options),
    modelStream: (input: unknown, options: AbortOptions) => call("model_stream", input, options),
    fileParse: (input: unknown, options: AbortOptions) => call("file_parse", input, options),
    taskStart: (input: unknown, options: AbortOptions) => call("task_start", input, options),
    taskStatus: (input: unknown, options: AbortOptions) => call("task_status", input, options),
    taskResult: (input: unknown, options: AbortOptions) => call("task_result", input, options),
    taskCancel: (input: unknown, options: AbortOptions) => call("task_cancel", input, options),
    taskEvents: (input: unknown, options: AbortOptions) => call("task_events", input, options),
  });
}
