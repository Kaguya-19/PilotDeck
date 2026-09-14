import { LspError, type LspOperation, type LspServicePort } from "../../lsp/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";

export type LspToolInput = {
  operation: LspOperation;
  file_path: string;
  line: number;
  character: number;
};

export type LspToolOutput = {
  kind: "locations" | "hover";
  locations?: unknown;
  hover?: unknown;
  resolvedWorkspaceUri?: string;
};

/** Model-facing consumer for the DSH-style LSP capability seam. */
export function createLspTool(lsp: LspServicePort): PilotDeckToolDefinition<LspToolInput, LspToolOutput> {
  return {
    name: "lsp",
    description: "Query a language server for precise definitions, references, implementations, or hover information. Coordinates are one-based UTF-16 positions.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["operation", "file_path", "line", "character"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["goToDefinition", "findReferences", "goToImplementation", "hover"] },
        file_path: { type: "string" },
        line: { type: "integer" },
        character: { type: "integer" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: async (input) => {
      if (!Number.isInteger(input.line) || input.line < 1) return { ok: false, issues: [{ path: "line", code: "invalid_schema", message: "line must be a positive one-based integer" }] };
      if (!Number.isInteger(input.character) || input.character < 1) return { ok: false, issues: [{ path: "character", code: "invalid_schema", message: "character must be a positive one-based integer" }] };
      if (!input.file_path.trim()) return { ok: false, issues: [{ path: "file_path", code: "invalid_schema", message: "file_path must not be empty" }] };
      return { ok: true, input };
    },
    execute: async (input, context) => executeLspQuery(lsp, input, context),
  };
}

async function executeLspQuery(
  lsp: LspServicePort,
  input: LspToolInput,
  context: PilotDeckToolRuntimeContext,
): Promise<{ content: [{ type: "text"; text: string }]; data: LspToolOutput }> {
  if (!context.cwd || !context.cwd.trim()) throw new LspError("LSP tool requires a workspace cwd", "LSP_WORKSPACE_REQUIRED");
  const result = await lsp.query({
    operation: input.operation,
    filePath: input.file_path,
    position: { line: input.line - 1, character: input.character - 1 },
    workspaceRoot: context.cwd,
  }, context.abortSignal);
  const data: LspToolOutput = result.kind === "locations"
    ? { kind: "locations", locations: result.locations, resolvedWorkspaceUri: result.resolvedWorkspaceUri }
    : { kind: "hover", hover: result.hover };
  return { content: [{ type: "text", text: formatLspResult(data) }], data };
}

function formatLspResult(result: LspToolOutput): string {
  if (result.kind === "hover") return result.hover ? JSON.stringify(result.hover, null, 2) : "No hover information.";
  const locations = Array.isArray(result.locations) ? result.locations : [];
  if (locations.length === 0) return "No matching locations.";
  return JSON.stringify({ locations, resolvedWorkspaceUri: result.resolvedWorkspaceUri }, null, 2);
}
