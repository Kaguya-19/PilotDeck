import { extname, isAbsolute, relative, resolve } from "node:path";
import type { LspProvider, LspQueryRequest, LspQueryResult, LspService as LspServicePort } from "../protocol/types.js";
import { LspError } from "../protocol/errors.js";

/** Native provider registry and per-query provider selection. */
export class LspService implements LspServicePort {
  private readonly providers = new Map<string, LspProvider>();
  private readonly extensions = new Map<string, LspProvider>();
  private disposed = false;

  registerProvider(provider: LspProvider): () => Promise<void> {
    if (this.disposed) throw new LspError("LSP service is disposed", "LSP_DISPOSED");
    validateProvider(provider);
    const extensions = Object.keys(provider.extensionToLanguage).map(normalizeExtension);
    if (this.providers.has(provider.id) || extensions.some((extension) => this.extensions.has(extension))) {
      throw new LspError(`LSP provider ${provider.id} conflicts with an existing provider`, "LSP_CONFLICT");
    }
    this.providers.set(provider.id, provider);
    for (const extension of extensions) this.extensions.set(extension, provider);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (this.providers.get(provider.id) !== provider) return;
      this.providers.delete(provider.id);
      for (const extension of extensions) {
        if (this.extensions.get(extension) === provider) this.extensions.delete(extension);
      }
      await provider.dispose?.();
    };
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError("LSP service is disposed", "LSP_DISPOSED");
    validateRequest(request);
    const provider = this.extensions.get(normalizeExtension(extname(request.filePath)));
    if (!provider) {
      throw new LspError(`No LSP provider is registered for ${extname(request.filePath) || "the requested file"}`, "LSP_UNAVAILABLE");
    }
    const extension = normalizeExtension(extname(request.filePath));
    const languageId = provider.extensionToLanguage[extension];
    return provider.query({ ...request, languageId }, signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const providers = [...this.providers.values()];
    this.providers.clear();
    this.extensions.clear();
    const results = await Promise.allSettled(providers.map((provider) => provider.dispose?.()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose LSP providers.");
  }
}

function validateProvider(provider: LspProvider): void {
  if (!provider || typeof provider.id !== "string" || provider.id.trim() === "") {
    throw new LspError("LSP provider id must be a non-empty string", "LSP_INVALID_PROVIDER");
  }
  if (!provider.extensionToLanguage || typeof provider.extensionToLanguage !== "object") {
    throw new LspError(`LSP provider ${provider.id} has no extension mapping`, "LSP_INVALID_PROVIDER");
  }
  const entries = Object.entries(provider.extensionToLanguage);
  if (entries.length === 0) throw new LspError(`LSP provider ${provider.id} has no extensions`, "LSP_INVALID_PROVIDER");
  for (const [extension, language] of entries) {
    if (normalizeExtension(extension) !== extension || typeof language !== "string" || language.trim() === "") {
      throw new LspError(`LSP provider ${provider.id} has an invalid extension mapping`, "LSP_INVALID_PROVIDER");
    }
  }
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function validateRequest(request: LspQueryRequest): void {
  if (!request.workspaceRoot || request.workspaceRoot.trim() === "") {
    throw new LspError("LSP query requires a workspace root", "LSP_WORKSPACE_REQUIRED");
  }
  if (!request.filePath || request.filePath.trim() === "") throw new LspError("LSP query requires a file path", "LSP_MALFORMED_RESPONSE");
  if (!Number.isInteger(request.position.line) || request.position.line < 0 || !Number.isInteger(request.position.character) || request.position.character < 0) {
    throw new LspError("LSP position must contain non-negative integer coordinates", "LSP_MALFORMED_RESPONSE");
  }
  // Keep path containment in the service contract so providers cannot accidentally index outside
  // the caller's workspace. Providers still canonicalize and re-check before reading.
  const workspace = resolve(request.workspaceRoot);
  const file = resolve(workspace, request.filePath);
  const escaped = relative(workspace, file).startsWith("..") || isAbsolute(relative(workspace, file));
  if (escaped) throw new LspError(`LSP source ${request.filePath} resolves outside the workspace`, "LSP_MALFORMED_RESPONSE");
}
