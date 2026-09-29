import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LspError } from "../protocol/errors.js";
import type { LspLocation, LspOperation, LspProvider, LspProviderQuery, LspQueryResult, LspRange } from "../protocol/types.js";

export type NodeStdioLspServerConfig = {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  extensionToLanguage: Readonly<Record<string, string>>;
  initializationOptions?: unknown;
  configuration?: unknown;
  /** Per-request deadline for the server handshake and query requests. */
  requestTimeoutMs?: number;
  maxDocumentBytes?: number;
  shutdownTimeoutMs?: number;
};

export type NodeStdioLspProviderOptions = NodeStdioLspServerConfig & {
  id: string;
  spawn?: typeof spawn;
};

const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Native stdio language-server provider. One short-lived process is owned per query. */
export function createNodeStdioLspProvider(options: NodeStdioLspProviderOptions): LspProvider {
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < 1) throw new Error("LSP maxDocumentBytes must be a positive integer");
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) throw new Error("LSP shutdownTimeoutMs must be a positive integer");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("LSP requestTimeoutMs must be a positive integer");
  const active = new Set<LspProcess>();
  let disposed = false;

  const provider: LspProvider = {
    id: options.id,
    extensionToLanguage: normalizeExtensions(options.extensionToLanguage),
    query: async (request, signal) => {
      if (disposed) throw new LspError("LSP provider is disposed", "LSP_DISPOSED");
      const source = await readSource(request, maxDocumentBytes, signal);
      const process = new LspProcess({
        command: options.command,
        args: options.args ?? [],
        env: options.env,
        workspaceRoot: source.workspaceRoot,
        workspaceUri: source.workspaceUri,
        initializationOptions: options.initializationOptions,
        configuration: options.configuration,
        requestTimeoutMs,
        shutdownTimeoutMs,
        spawn: options.spawn ?? spawn,
      });
      active.add(process);
      try {
        return await process.query(request, source.fileUri, source.text, signal);
      } finally {
        active.delete(process);
        await process.dispose();
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const results = await Promise.allSettled([...active].map((process) => process.dispose()));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose LSP processes.");
    },
  };
  return provider;
}

function normalizeExtensions(mapping: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [rawExtension, language] of Object.entries(mapping)) {
    const extension = rawExtension.trim().toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._-]*$/u.test(extension) || !language.trim()) {
      throw new Error(`Invalid LSP extension mapping: ${rawExtension}`);
    }
    result[extension] = language;
  }
  return Object.freeze(result);
}

type Source = { workspaceRoot: string; workspaceUri: string; fileUri: string; text: string };

async function readSource(request: LspProviderQuery, maxDocumentBytes: number, signal?: AbortSignal): Promise<Source> {
  throwIfAborted(signal);
  const workspaceRoot = resolve(request.workspaceRoot);
  const workspaceInfo = await stat(workspaceRoot);
  if (!workspaceInfo.isDirectory()) throw new LspError(`LSP workspace is not a directory: ${request.workspaceRoot}`, "LSP_MALFORMED_RESPONSE");
  const filePath = isAbsolute(request.filePath) ? resolve(request.filePath) : resolve(workspaceRoot, request.filePath);
  const relativePath = relative(workspaceRoot, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new LspError(`LSP source resolves outside the workspace: ${request.filePath}`, "LSP_MALFORMED_RESPONSE");
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new LspError(`LSP source is not a file: ${request.filePath}`, "LSP_MALFORMED_RESPONSE");
  if (info.size > maxDocumentBytes) throw new LspError(`LSP source exceeds ${maxDocumentBytes} bytes`, "LSP_MALFORMED_RESPONSE");
  throwIfAborted(signal);
  const buffer = await readFile(filePath);
  throwIfAborted(signal);
  if (buffer.byteLength > maxDocumentBytes) throw new LspError(`LSP source exceeds ${maxDocumentBytes} bytes`, "LSP_MALFORMED_RESPONSE");
  return {
    workspaceRoot,
    workspaceUri: pathToFileURL(workspaceRoot).toString(),
    fileUri: pathToFileURL(filePath).toString(),
    text: buffer.toString("utf8"),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("LSP query aborted");
}

class LspProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly decoder = new MessageDecoder();
  private nextId = 1;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private settledClosed = false;
  private readonly closed: Promise<void>;

  constructor(private readonly options: {
    command: string;
    args: readonly string[];
    env?: Record<string, string>;
    workspaceRoot: string;
    workspaceUri: string;
    initializationOptions?: unknown;
    configuration?: unknown;
    shutdownTimeoutMs: number;
    requestTimeoutMs: number;
    spawn: typeof spawn;
  }) {
    this.child = options.spawn(options.command, [...options.args], {
      cwd: options.workspaceRoot,
      env: { ...process.env, ...options.env },
      stdio: "pipe",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.closed = new Promise((resolve) => {
      this.child.once("close", () => {
        this.settleClosed();
        resolve();
      });
    });
    this.child.stdout.on("data", (chunk: Buffer | string) => {
      try {
        for (const message of this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) this.handleMessage(message);
      } catch (error) {
        this.failAll(new LspError(`Malformed LSP response: ${error instanceof Error ? error.message : String(error)}`, "LSP_MALFORMED_RESPONSE", { cause: error }));
        this.kill();
      }
    });
    this.child.stderr.resume();
    this.child.once("error", (error) => this.failAll(error));
  }

  async query(request: LspProviderQuery, fileUri: string, text: string, signal?: AbortSignal): Promise<LspQueryResult> {
    await this.request("initialize", {
      processId: null,
      rootUri: this.options.workspaceUri,
      workspaceFolders: [{ uri: this.options.workspaceUri, name: basename(this.options.workspaceRoot) || "workspace" }],
      capabilities: {},
      initializationOptions: this.options.initializationOptions ?? null,
    }, signal);
    await this.notify("initialized", {});
    await this.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: request.languageId, version: 1, text },
    });
    try {
      const method = methodFor(request.operation);
      const payload = await this.request(method, {
        textDocument: { uri: fileUri },
        position: request.position,
        ...(request.operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
      }, signal);
      return normalizeResult(request.operation, payload, this.options.workspaceUri);
    } finally {
      await this.notify("textDocument/didClose", { textDocument: { uri: fileUri } }).catch(() => undefined);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeImpl();
    return this.disposePromise;
  }

  private async disposeImpl(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.settledClosed) {
        await this.request("shutdown", null).catch(() => undefined);
        await this.notify("exit", {}).catch(() => undefined);
        await Promise.race([this.closed, delay(this.options.shutdownTimeoutMs)]);
      }
    } finally {
      if (!this.settledClosed) this.kill();
      this.failAll(new LspError("LSP process disposed", "LSP_DISPOSED"));
      this.disposed = true;
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || this.settledClosed) return Promise.reject(new LspError("LSP process is closed", "LSP_DISPOSED"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new LspError(`LSP request timed out: ${method}`, "LSP_TIMEOUT"));
        void this.notify("$/cancelRequest", { id }).catch(() => undefined);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return abortable(promise, signal, () => {
      this.pending.delete(id);
      void this.notify("$/cancelRequest", { id }).catch(() => undefined);
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.disposed || this.settledClosed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (
      typeof message.method === "string"
      && (typeof message.id === "number" || typeof message.id === "string")
    ) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error && typeof message.error === "object") pending.reject(new LspError(`LSP request failed: ${JSON.stringify(message.error)}`, "LSP_MALFORMED_RESPONSE"));
    else pending.resolve(message.result);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = params && typeof params === "object" && Array.isArray((params as Record<string, unknown>).items)
        ? (params as Record<string, unknown>).items as unknown[]
        : [];
      result = items.map((item) => {
        if (!item || typeof item !== "object") return null;
        const section = (item as Record<string, unknown>).section;
        if (typeof section !== "string") return this.options.configuration ?? null;
        if (this.options.configuration && typeof this.options.configuration === "object") {
          return (this.options.configuration as Record<string, unknown>)[section] ?? null;
        }
        return this.options.configuration ?? null;
      });
    } else if (method === "workspace/workspaceFolders") {
      result = [{
        uri: this.options.workspaceUri,
        name: basename(this.options.workspaceRoot) || "workspace",
      }];
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "LSP provider does not apply workspace edits." };
    }
    try {
      this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.failAll(error);
    }
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private settleClosed(): void {
    this.settledClosed = true;
    this.failAll(new LspError("LSP process exited", "LSP_UNAVAILABLE"));
  }

  private kill(): void {
    try { this.child.kill("SIGTERM"); } catch { /* already closed */ }
    const timer = setTimeout(() => {
      try { this.child.kill("SIGKILL"); } catch { /* already closed */ }
    }, 500);
    timer.unref();
  }
}

class MessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Record<string, unknown>[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Record<string, unknown>[] = [];
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) break;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) throw new Error("missing Content-Length header");
      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.byteLength < start + length) break;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("response is not an object");
      messages.push(parsed as Record<string, unknown>);
    }
    return messages;
  }
}

function methodFor(operation: LspOperation): string {
  switch (operation) {
    case "goToDefinition": return "textDocument/definition";
    case "findReferences": return "textDocument/references";
    case "goToImplementation": return "textDocument/implementation";
    case "hover": return "textDocument/hover";
  }
}

function normalizeResult(operation: LspOperation, payload: unknown, workspaceUri: string): LspQueryResult {
  if (operation === "hover") return { kind: "hover", hover: normalizeHover(payload) };
  return { kind: "locations", locations: normalizeLocations(payload), resolvedWorkspaceUri: workspaceUri };
}

function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload == null) return [];
  const values = Array.isArray(payload) ? payload : [payload];
  return values.map((value) => {
    if (!value || typeof value !== "object") throw new LspError("LSP location is malformed", "LSP_MALFORMED_RESPONSE");
    const entry = value as Record<string, unknown>;
    const uri = typeof entry.uri === "string" ? entry.uri : typeof entry.targetUri === "string" ? entry.targetUri : undefined;
    const rawRange = entry.range ?? entry.targetSelectionRange;
    if (!uri || !isRange(rawRange)) throw new LspError("LSP location is malformed", "LSP_MALFORMED_RESPONSE");
    return { uri, range: rawRange as LspRange };
  });
}

function normalizeHover(payload: unknown): { contents: string; range?: LspRange } | null {
  if (payload == null) return null;
  if (!payload || typeof payload !== "object") throw new LspError("LSP hover is malformed", "LSP_MALFORMED_RESPONSE");
  const value = payload as Record<string, unknown>;
  const contents = renderContents(value.contents);
  if (!contents) return null;
  if (value.range !== undefined && !isRange(value.range)) throw new LspError("LSP hover range is malformed", "LSP_MALFORMED_RESPONSE");
  return { contents, ...(value.range ? { range: value.range as LspRange } : {}) };
}

function renderContents(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderContents).join("\n\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.language === "string" && typeof record.value === "string") {
      return "```" + record.language + "\n" + record.value + "\n```";
    }
    if (typeof record.value === "string") return record.value;
  }
  throw new LspError("LSP hover contents are malformed", "LSP_MALFORMED_RESPONSE");
}

function isRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isPosition(record.start) && isPosition(record.end);
}

function isPosition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.line) && Number(record.line) >= 0 && Number.isInteger(record.character) && Number(record.character) >= 0;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("LSP query aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(signal.reason instanceof Error ? signal.reason : new Error("LSP query aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
