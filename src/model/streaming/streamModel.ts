import { normalizeModelError } from "../errors/normalizeModelError.js";
import { createGoogleClient, type GoogleClientFactory } from "../providers/google/client.js";
import { parseGoogleResponse } from "../providers/google/response.js";
import type { GoogleRequestBody } from "../providers/google/request.js";
import { buildModelRequest } from "../request/buildModelRequest.js";
import { validateModelRequest } from "../request/validateModelRequest.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelConfig,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import { ModelProviderError, parseRetryAfterHeader } from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";
import { createGoogleStreamState, normalizeGoogleStreamEvent } from "../providers/google/stream.js";
import { normalizeProviderBaseUrl } from "../normalizeProviderBaseUrl.js";
import { StreamingCheckpointManager } from "./StreamingCheckpoint.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  googleClientFactory?: GoogleClientFactory;
  signal?: AbortSignal;
};

const DEFAULT_REQUEST_MAX_RETRIES = 2;

export async function complete(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  const maxRetries = provider.retry?.requestMaxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    if (provider.protocol === "google") {
      try {
        const raw = await sendGoogleCompleteRequest(
          provider,
          nonStreamingRequest,
          options,
        );
        return parseGoogleResponse(raw, provider.id);
      } catch (error) {
        if (attempt < maxRetries && isRetryableRequestError(error)) {
          const delayMs = computeRetryDelayMs(provider, attempt);
          console.warn(
            `[PilotDeck] complete() retry: ${(error as Error).message} ` +
            `(attempt ${attempt + 1}/${maxRetries}, delay=${Math.round(delayMs)}ms)`,
          );
          await delay(delayMs, options.signal);
          continue;
        }
        throw error;
      }
    }

    const body = buildModelRequest(nonStreamingRequest, config);
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);
    } catch (error) {
      if (attempt < maxRetries && isRetryableRequestError(error)) {
        const delayMs = computeRetryDelayMs(provider, attempt);
        console.warn(
          `[PilotDeck] complete() retry: ${(error as Error).message} ` +
          `(attempt ${attempt + 1}/${maxRetries}, delay=${Math.round(delayMs)}ms)`,
        );
        await delay(delayMs, options.signal);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      throw new ModelProviderError(
        normalizeModelError(provider.id, provider.protocol, raw, response.status),
      );
    }

    const raw = await response.json();
    return parseModelResponse(provider.protocol, raw, provider.id);
  }

  throw new Error("complete() exhausted all retry attempts without a result.");
}

const DEFAULT_STREAM_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);
  const maxRetries = provider.retry?.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES;

  yield {
    type: "request_started",
    provider: provider.id,
    model: streamingRequest.model,
    providerBaseUrl: normalizeProviderBaseUrl(provider.url),
    metadata: streamingRequest.metadata,
  };

  let currentRequest = streamingRequest;
  const checkpoint = new StreamingCheckpointManager();

  if (provider.protocol === "google") {
    yield* streamGoogleProviderRequest({
      request: currentRequest,
      provider,
      maxRetries,
      checkpoint,
      options,
    });
    return;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    const diagnostics = createStreamDiagnostics(provider, streamingRequest.model, attempt + 1);
    const body = buildModelRequest(currentRequest, config);
    if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dumpPath = path.join(os.tmpdir(), `pilotdeck_request_${Date.now()}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
      console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
    }
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal);
      diagnostics.captureResponse(response);
    } catch (error) {
      if (attempt < maxRetries && isRetryableStreamError(error)) {
        const delayMs = computeRetryDelayMs(provider, attempt);
        console.warn(
          `[model-stream] open retry: ${formatStreamDiagnostics(diagnostics)} ` +
          `error=${formatErrorForLog(error)} delay=${Math.round(delayMs)}ms`,
        );
        await delay(delayMs, options.signal);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      const error = normalizeModelError(provider.id, provider.protocol, raw, response.status);
      if (error.retryAfterMs === undefined) {
        const headerMs = parseRetryAfterHeader(response.headers.get("retry-after"));
        if (headerMs !== undefined) {
          error.retryAfterMs = headerMs;
        }
      }
      yield { type: "error", error };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
      };
      return;
    }

    const state = createStreamNormalizerState(provider.protocol);
    let streamCompleted = false;
    let sawCompletionSentinel = false;

    const streamIdleTimeoutMs = resolveStreamIdleTimeout(provider);

    try {
      for await (const sseEvent of readServerSentEvents(response.body, options.signal, streamIdleTimeoutMs, diagnostics)) {
        if (sseEvent.type === "done") {
          sawCompletionSentinel = true;
          continue;
        }
        for (const event of normalizeStreamEvent(provider.protocol, sseEvent.data, state)) {
          if (event.type === "message_end") {
            sawCompletionSentinel = true;
          }
          checkpoint.onEvent(event);
          yield event;
        }
      }
      if (!sawCompletionSentinel) {
        const syntheticEnd = checkpoint.syntheticEndDecision();
        if (!syntheticEnd.ok) {
          throw new IncompleteStreamError();
        }
        const checkpointState = checkpoint.get();
        console.warn(
          `[model-stream] missing completion sentinel salvaged: finishReason=${syntheticEnd.finishReason}, reason=${syntheticEnd.reason}, ` +
          `tokens=${checkpointState.tokensReceived}, textChars=${checkpointState.partialText.length}, ` +
          `toolCalls=${checkpointState.toolCallsEnded}/${checkpointState.toolCallsStarted}, ` +
          formatStreamDiagnostics(diagnostics),
        );
        yield { type: "message_end", finishReason: syntheticEnd.finishReason, raw: undefined };
      }
      streamCompleted = true;
    } catch (error) {
      if (
        attempt < maxRetries &&
        isRetryableStreamError(error) &&
        checkpoint.hasSubstantialContent()
      ) {
        currentRequest = buildContinuationRequest(currentRequest, checkpoint.get().partialText);
        checkpoint.reset();
        const delayMs = computeRetryDelayMs(provider, attempt);
        console.warn(
          `[model-stream] continuation retry: ${formatStreamDiagnostics(diagnostics)} ` +
          `error=${formatErrorForLog(error)} delay=${Math.round(delayMs)}ms`,
        );
        await delay(delayMs, options.signal);
        continue;
      }

      if (isRetryableStreamError(error) && attempt < maxRetries) {
        const delayMs = computeRetryDelayMs(provider, attempt);
        console.warn(
          `[model-stream] retry: ${formatStreamDiagnostics(diagnostics)} ` +
          `error=${formatErrorForLog(error)} delay=${Math.round(delayMs)}ms`,
        );
        await delay(delayMs, options.signal);
        continue;
      }

      console.warn(
        `[model-stream] failed: ${formatStreamDiagnostics(diagnostics)} error=${formatErrorForLog(error)}`,
      );
      throw error;
    }

    if (streamCompleted) {
      return;
    }
  }
}

async function sendGoogleCompleteRequest(
  provider: ProviderConfig,
  request: CanonicalModelRequest,
  options: ModelRuntimeOptions,
): Promise<unknown> {
  try {
    const body = withGoogleAbortSignal(buildModelRequest(request, {
      providers: { [provider.id]: provider },
    }) as Record<string, unknown>, options.signal);
    const client = (options.googleClientFactory ?? createGoogleClient)(provider);
    return await client.models.generateContent(body as unknown as GoogleRequestBody);
  } catch (error) {
    throwIfGoogleAbort(error, options.signal);
    throw toProviderError(provider, error);
  }
}

async function* streamGoogleProviderRequest(params: {
  request: CanonicalModelRequest & { stream: boolean };
  provider: ProviderConfig;
  maxRetries: number;
  checkpoint: StreamingCheckpointManager;
  options: ModelRuntimeOptions;
}): AsyncIterable<CanonicalModelEvent> {
  let currentRequest = params.request;

  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    throwIfAborted(params.options.signal);
    const startedAt = Date.now();
    try {
      const body = withGoogleAbortSignal(buildModelRequest(currentRequest, {
        providers: { [params.provider.id]: params.provider },
      }) as Record<string, unknown>, params.options.signal);
      if (process.env.PILOTDECK_DUMP_REQUEST === "1") {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const dumpPath = path.join(os.tmpdir(), `pilotdeck_request_${Date.now()}.json`);
        fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
        console.log(`[model-debug] Request dumped to ${dumpPath} (model=${currentRequest.model})`);
      }

      const client = (params.options.googleClientFactory ?? createGoogleClient)(params.provider);
      const stream = await client.models.generateContentStream(body as unknown as GoogleRequestBody);
      const state = createGoogleStreamState();
      let sawTerminalEvent = false;

      for await (const chunk of stream) {
        throwIfAborted(params.options.signal);
        for (const event of normalizeGoogleStreamEvent(chunk, state)) {
          if (event.type === "message_end" || event.type === "error") {
            sawTerminalEvent = true;
          }
          params.checkpoint.onEvent(event);
          yield event;
        }
      }

      if (!sawTerminalEvent && !state.ended) {
        yield { type: "message_end", finishReason: "unknown", raw: undefined };
      }
      return;
    } catch (error) {
      throwIfGoogleAbort(error, params.options.signal);
      const providerError = toProviderError(params.provider, error);
      if (
        attempt < params.maxRetries &&
        isRetryableGoogleStreamError(providerError, error) &&
        params.checkpoint.hasSubstantialContent()
      ) {
        currentRequest = buildContinuationRequest(currentRequest, params.checkpoint.get().partialText);
        params.checkpoint.reset();
        const delayMs = computeRetryDelayMs(params.provider, attempt);
        console.warn(
          `[model-stream] google continuation retry: provider=${params.provider.id}, model=${params.request.model}, ` +
          `protocol=${params.provider.protocol}, attempt=${attempt + 1}, elapsedMs=${Date.now() - startedAt}, ` +
          `error=${formatErrorForLog(error)} delay=${Math.round(delayMs)}ms`,
        );
        await delay(delayMs, params.options.signal);
        continue;
      }

      if (isRetryableGoogleStreamError(providerError, error) && attempt < params.maxRetries) {
        const delayMs = computeRetryDelayMs(params.provider, attempt);
        console.warn(
          `[model-stream] google retry: provider=${params.provider.id}, model=${params.request.model}, ` +
          `protocol=${params.provider.protocol}, attempt=${attempt + 1}, elapsedMs=${Date.now() - startedAt}, ` +
          `error=${formatErrorForLog(error)} delay=${Math.round(delayMs)}ms`,
        );
        await delay(delayMs, params.options.signal);
        continue;
      }

      console.warn(
        `[model-stream] google failed: provider=${params.provider.id}, model=${params.request.model}, ` +
        `protocol=${params.provider.protocol}, attempt=${attempt + 1}, elapsedMs=${Date.now() - startedAt}, ` +
        `error=${formatErrorForLog(error)}`,
      );
      yield { type: "error", error: providerError.error };
      return;
    }
  }
}

function throwIfGoogleAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
  if (isAbortError(error)) {
    throw error;
  }
}

function isRetryableGoogleStreamError(providerError: ModelProviderError, raw: unknown): boolean {
  return providerError.error.retryable || isRetryableStreamError(raw);
}

function withGoogleAbortSignal(body: Record<string, unknown>, signal: AbortSignal | undefined): Record<string, unknown> {
  if (!signal) {
    return body;
  }
  const config = body.config && typeof body.config === "object"
    ? { ...(body.config as Record<string, unknown>), abortSignal: signal }
    : { abortSignal: signal };
  return { ...body, config };
}

function toProviderError(provider: ProviderConfig, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  return new ModelProviderError(
    normalizeModelError(provider.id, provider.protocol, error, extractStatus(error)),
  );
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  if (typeof status === "number" && Number.isInteger(status)) {
    return status;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number" && Number.isInteger(responseStatus)) {
      return responseStatus;
    }
  }
  return undefined;
}

function isRetryableRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ModelProviderError) {
    return error.error.retryable;
  }
  if (error instanceof Error) {
    return isTransientNetworkMessage(error);
  }
  return false;
}

function isRetryableStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return false;
  }
  if (error instanceof StreamIdleTimeoutError) {
    return true;
  }
  if (error instanceof IncompleteStreamError) {
    return true;
  }
  if (error instanceof StreamParseError) {
    return true;
  }
  if (error instanceof Error) {
    return isTransientNetworkMessage(error);
  }
  return false;
}

function isTransientNetworkMessage(error: Error): boolean {
  const msg = `${error.name} ${error.message}`.toLowerCase();
  return (
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("econnrefused") ||
    msg.includes("und_err_") ||
    msg.includes("terminated") ||
    msg.includes("other side closed") ||
    msg.includes("remoteprotocolerror") ||
    msg.includes("premature close") ||
    msg.includes("socket closed") ||
    msg.includes("connection closed")
  );
}

function computeRetryDelayMs(provider: ProviderConfig, attempt: number, retryAfterMs?: number): number {
  const maxDelayMs = provider.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }
  const baseDelayMs = provider.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const exponent = Math.max(0, attempt);
  const exponential = Math.min(baseDelayMs * (2 ** exponent), maxDelayMs);
  const jitter = Math.random() * exponential * 0.5;
  return Math.min(exponential + jitter, maxDelayMs);
}

function buildContinuationRequest(
  original: CanonicalModelRequest & { stream: boolean },
  partialText: string,
): CanonicalModelRequest & { stream: boolean } {
  return {
    ...original,
    messages: [
      ...original.messages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: partialText }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Continue from where you left off." }],
      },
    ],
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const effectiveTimeoutMs = stream ? provider.timeoutMs : (provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const timeout = effectiveTimeoutMs
    ? setTimeout(() => controller.abort("request_timeout"), effectiveTimeoutMs)
    : undefined;

  const finalBody = provider.extraBody
    ? { ...(body as Record<string, unknown>), ...provider.extraBody }
    : body;

  try {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    };
    return await transport(buildEndpoint(provider, stream), fetchOptions);
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detachAbort?.();
  }
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function buildEndpoint(provider: ProviderConfig, _stream: boolean): string {
  if (provider.protocol === "anthropic") {
    return joinUrl(provider.url, "v1/messages");
  }

  if (provider.protocol === "openai-responses") {
    return joinUrl(provider.url, "responses");
  }

  return joinUrl(provider.url, "chat/completions");
}

function buildHeaders(provider: ProviderConfig): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };

  // Defensive trim: parseModelConfig already strips whitespace from
  // apiKey, but a programmatic caller could hand a ProviderConfig in
  // here that bypassed the parser. A stray space in the header value
  // (`Bearer  sk-...`) is silently rejected by most providers as
  // `invalid_token`, so guard at the wire boundary too.
  const apiKey = provider.apiKey.trim();
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = headers.authorization ?? `Bearer ${apiKey}`;
  }

  return headers;
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Stream idle timeout: no data received for ${idleMs}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

class IncompleteStreamError extends Error {
  constructor() {
    super("Network stream ended before provider completion sentinel.");
    this.name = "IncompleteStreamError";
  }
}

class StreamParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamParseError";
  }
}

const STREAM_DIAGNOSTIC_HEADERS = [
  "cf-ray",
  "x-request-id",
  "x-openrouter-provider",
  "x-openrouter-model",
  "x-openrouter-id",
  "server",
  "via",
] as const;

type StreamDiagnostics = {
  provider: string;
  model: string;
  protocol: ModelProtocol;
  baseUrl: string;
  attempt: number;
  startedAt: number;
  firstChunkAt?: number;
  bytes: number;
  chunks: number;
  httpStatus?: number;
  headers: Record<string, string>;
  captureResponse(response: Response): void;
  observeChunk(bytes: number): void;
};

function createStreamDiagnostics(provider: ProviderConfig, model: string, attempt: number): StreamDiagnostics {
  return {
    provider: provider.id,
    model,
    protocol: provider.protocol,
    baseUrl: normalizeProviderBaseUrl(provider.url) ?? "unknown",
    attempt,
    startedAt: Date.now(),
    bytes: 0,
    chunks: 0,
    headers: {},
    captureResponse(response: Response) {
      this.httpStatus = response.status;
      for (const header of STREAM_DIAGNOSTIC_HEADERS) {
        const value = response.headers.get(header);
        if (value) {
          this.headers[header] = truncateForLog(value, 120);
        }
      }
    },
    observeChunk(bytes: number) {
      if (this.firstChunkAt === undefined) {
        this.firstChunkAt = Date.now();
      }
      this.bytes += bytes;
      this.chunks += 1;
    },
  };
}

function formatStreamDiagnostics(diagnostics: StreamDiagnostics): string {
  const now = Date.now();
  const elapsedMs = now - diagnostics.startedAt;
  const ttfbMs = diagnostics.firstChunkAt === undefined ? "-" : String(diagnostics.firstChunkAt - diagnostics.startedAt);
  const headers = Object.entries(diagnostics.headers)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `provider=${diagnostics.provider}, model=${diagnostics.model}, protocol=${diagnostics.protocol}, ` +
    `baseUrl=${diagnostics.baseUrl}, attempt=${diagnostics.attempt}, httpStatus=${diagnostics.httpStatus ?? "-"}, ` +
    `ttfbMs=${ttfbMs}, elapsedMs=${elapsedMs}, bytes=${diagnostics.bytes}, chunks=${diagnostics.chunks}, ` +
    `upstream=${headers || "-"}`;
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}(${truncateForLog(error.message, 220)})`;
  }
  return truncateForLog(String(error), 220);
}

function truncateForLog(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

type ServerSentEvent =
  | { type: "data"; data: unknown }
  | { type: "done" };

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
  diagnostics?: StreamDiagnostics,
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const effectiveIdleMs = idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const cancelReader = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };

  if (signal?.aborted) {
    cancelReader();
    throw createAbortError(signal.reason);
  }
  signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const readResult = await readWithIdleTimeout(reader, effectiveIdleMs, signal);
      throwIfAborted(signal);
      const { value, done } = readResult;
      if (done) {
        buffer += decoder.decode();
        break;
      }

      diagnostics?.observeChunk(value.byteLength);
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        yield* parseServerSentEventChunk(chunk, diagnostics);
      }
    }

    if (buffer.trim().length > 0) {
      for (const event of parseServerSentEventChunk(buffer, diagnostics)) {
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function* parseServerSentEventChunk(chunk: string, diagnostics?: StreamDiagnostics): Iterable<ServerSentEvent> {
  const dataLines = chunk
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  for (const data of dataLines) {
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      yield { type: "done" };
      continue;
    }
    try {
      yield { type: "data", data: JSON.parse(data) };
    } catch (error) {
      const prefix = truncateForLog(data, 120);
      throw new StreamParseError(
        `Malformed provider SSE JSON: provider=${diagnostics?.provider ?? "unknown"}, ` +
        `model=${diagnostics?.model ?? "unknown"}, protocol=${diagnostics?.protocol ?? "unknown"}, ` +
        `frameLength=${data.length}, bytes=${diagnostics?.bytes ?? 0}, chunks=${diagnostics?.chunks ?? 0}, ` +
        `prefix=${JSON.stringify(prefix)}, cause=${formatErrorForLog(error)}`,
      );
    }
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new StreamIdleTimeoutError(idleMs));
      }
    }, idleMs);
    if (typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(createAbortError(signal?.reason));
      }
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    reader.read().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      },
    );
  });
}

function resolveStreamIdleTimeout(provider: ProviderConfig): number {
  const retry = provider.retry;
  if (retry && typeof retry.streamIdleTimeoutMs === "number" && retry.streamIdleTimeoutMs > 0) {
    return retry.streamIdleTimeoutMs;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
