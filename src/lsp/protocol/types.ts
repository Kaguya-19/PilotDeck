/** DSH-style LSP capability seam. The protocol wire is intentionally hidden here. */

export type LspOperation = "goToDefinition" | "findReferences" | "goToImplementation" | "hover";

export type LspPosition = { readonly line: number; readonly character: number };
export type LspRange = { readonly start: LspPosition; readonly end: LspPosition };

export type LspQueryRequest = {
  readonly operation: LspOperation;
  readonly filePath: string;
  readonly position: LspPosition;
  readonly workspaceRoot: string;
};

export type LspProviderQuery = LspQueryRequest & { readonly languageId: string };

export type LspLocation = { readonly uri: string; readonly range: LspRange };
export type LspHover = { readonly contents: string; readonly range?: LspRange };

export type LspQueryResult =
  | { readonly kind: "locations"; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: "hover"; readonly hover: LspHover | null };

export type LspProvider = {
  readonly id: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>;
  dispose?(): void | Promise<void>;
};

export type LspService = {
  registerProvider(provider: LspProvider): () => Promise<void>;
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>;
  dispose(): Promise<void>;
};
