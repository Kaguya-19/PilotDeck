/**
 * Public composition contracts for mounted host capabilities.
 *
 * These are injection-only contracts.  They deliberately do not import a
 * provider, model runtime, database, AgentLoop, or server transport.  SOP and
 * Knowledge modules keep ownership of their APIJob/preview/ingest state and
 * use these ports only for host execution.
 */
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalToolSchema,
  CanonicalUsage,
} from "../model/protocol/canonical.js";
import type { CanonicalModelError } from "../model/protocol/errors.js";

export type PublicModelSelection = {
  /** Stable model id selected by the caller/profile. */
  requestedModelId: string;
  /** Concrete id resolved by the mounted PD model catalog. */
  selectedModelId: string;
  providerId: string;
  profileId?: string;
};

export type PublicModelBudget = {
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Host budget is advisory; the provider binding remains authoritative. */
  maxInputTokens?: number;
};

export type PublicModelInvokeRequest = Omit<CanonicalModelRequest, "model" | "provider"> & {
  requestId: string;
  selection: PublicModelSelection;
  budget?: PublicModelBudget;
};

export type PublicModelTerminalEvent =
  | { type: "completed"; usage?: CanonicalUsage; finishReason: string }
  | { type: "cancelled"; reason: "signal" | "provider" | "host" }
  | { type: "failed"; error: CanonicalModelError };

export type PublicModelEvent = CanonicalModelEvent | PublicModelTerminalEvent;

export type PublicModelInvokerBinding = {
  /** Resolve the requested id against the mounted PD catalog/profile. */
  resolveModel: (requestedModelId: string, signal?: AbortSignal) => Promise<PublicModelSelection>;
  /** Invoke the already-resolved binding; no fallback or silent id rewrite. */
  invoke: (
    request: PublicModelInvokeRequest,
    options?: { signal?: AbortSignal },
  ) => AsyncIterable<PublicModelEvent>;
};

export type PublicModelInvokerClient = {
  resolveModel: PublicModelInvokerBinding["resolveModel"];
  invoke: PublicModelInvokerBinding["invoke"];
};

export function createPublicModelInvokerClient(binding: PublicModelInvokerBinding): PublicModelInvokerClient {
  return Object.freeze({
    resolveModel: (requestedModelId: string, signal?: AbortSignal) => binding.resolveModel(requestedModelId, signal),
    invoke: (request: PublicModelInvokeRequest, options?: { signal?: AbortSignal }) => binding.invoke(request, options),
  });
}

export type PublicHostTaskDomain = "sop_preview" | "sop_api_job" | "knowledge_ingest" | "file_extract";

export type PublicHostTaskRequest = {
  taskId: string;
  domain: PublicHostTaskDomain;
  operation: string;
  input: unknown;
  budget?: { timeoutMs?: number; maxOutputBytes?: number };
};

export type PublicHostTaskEvent =
  | { type: "started"; taskId: string; sequence: number; cursor?: string }
  | { type: "progress"; taskId: string; sequence: number; cursor?: string; payload: unknown }
  | { type: "completed"; taskId: string; sequence: number; cursor?: string; result: unknown }
  | { type: "failed"; taskId: string; sequence: number; cursor?: string; error: PublicHostPortError }
  | { type: "cancelled"; taskId: string; sequence: number; cursor?: string; reason: "signal" | "host" };

export type PublicHostTaskHandle = {
  taskId: string;
  events: (options?: { afterSequence?: number; afterCursor?: string; signal?: AbortSignal }) => AsyncIterable<PublicHostTaskEvent>;
  cancel: (signal?: AbortSignal) => Promise<void>;
};

export type PublicHostTaskPort = {
  start: (request: PublicHostTaskRequest, options?: { signal?: AbortSignal }) => Promise<PublicHostTaskHandle>;
};

export type PublicFileExtractRequest = {
  requestId: string;
  filename: string;
  mediaType?: string;
  bytes: Uint8Array;
  maxBytes?: number;
};

export type PublicFileExtractResult = {
  requestId: string;
  filename: string;
  text: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
};

export type PublicFileParsingPort = {
  extract: (request: PublicFileExtractRequest, options?: { signal?: AbortSignal }) => Promise<PublicFileExtractResult>;
};

export type PublicToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: CanonicalToolSchema["inputSchema"];
  outputSchema?: Record<string, unknown>;
  version?: string;
  capabilities?: readonly string[];
};

export type PublicToolPort = {
  list: (options?: { signal?: AbortSignal }) => Promise<readonly PublicToolDescriptor[]>;
  execute: (name: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

export type PublicSkillManagementPort = {
  list: (options?: { signal?: AbortSignal }) => Promise<readonly PublicToolDescriptor[]>;
  read: (name: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  create?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  update?: (name: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  remove?: (name: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

export type PublicHostPortError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
};

export type PublicHostPorts = {
  modelInvoker: PublicModelInvokerClient;
  task: PublicHostTaskPort;
  fileParsing: PublicFileParsingPort;
  tools: PublicToolPort;
  skills: PublicSkillManagementPort;
};

/** Domain adapters must keep these namespaces distinct. */
export const PUBLIC_HOST_TASK_DOMAINS = Object.freeze({
  sopPreview: "sop_preview",
  sopApiJob: "sop_api_job",
  knowledgeIngest: "knowledge_ingest",
  fileExtract: "file_extract",
} as const);
