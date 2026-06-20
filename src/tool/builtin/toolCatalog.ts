import { toolError } from "../protocol/errors.js";
import type { PermissionResult } from "../../permission/index.js";
import type { PilotDeckToolResult } from "../protocol/result.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import { ToolCatalog } from "../catalog/ToolCatalog.js";

const TOOL_CATALOG_LIST_NAME = "list_tools";
const TOOL_CATALOG_CALL_NAME = "tool_call";

export type ListToolsInput = {
  category?: string;
  limit?: number;
  cursor?: number;
};

export type ToolCallProxyInput = {
  name: string;
  input?: unknown;
};

export type CreateToolCatalogToolsOptions = {
  registry: ToolRegistry;
  excludeNames?: Iterable<string>;
};

export function createListToolsTool(
  options: CreateToolCatalogToolsOptions,
): PilotDeckToolDefinition<ListToolsInput> {
  return {
    name: TOOL_CATALOG_LIST_NAME,
    aliases: ["ListTools"],
    description:
      "Browse the session's tool catalog without exposing every tool schema upfront. " +
      "Call without arguments to see categories. Call with a category to list tools in that category.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          description: "Optional category name to browse, such as filesystem, network, mcp, or agent.",
        },
        limit: {
          type: "number",
          description: "Optional page size when listing tools in a category. Defaults to 20, max 100.",
        },
        cursor: {
          type: "number",
          description: "Optional zero-based cursor for pagination.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input): Promise<PilotDeckToolExecutionOutput> => {
      const catalog = new ToolCatalog(options.registry, { excludeNames: options.excludeNames });
      if (!input.category) {
        const categories = catalog.categories();
        return {
          content: [{ type: "json", value: { categories } }],
          data: { categories },
          metadata: {
            experimentalToolSearch: true,
            mode: "categories",
          },
        };
      }

      const page = catalog.summaries(input.category, input.limit ?? 20, input.cursor ?? 0);
      return {
        content: [{ type: "json", value: page }],
        data: page,
        metadata: {
          experimentalToolSearch: true,
          mode: "summary",
          category: input.category,
        },
      };
    },
  };
}

export function createToolCallProxyTool(
  options: CreateToolCatalogToolsOptions,
): PilotDeckToolDefinition<ToolCallProxyInput> {
  return {
    name: TOOL_CATALOG_CALL_NAME,
    aliases: ["ToolCall"],
    description:
      "Invoke a tool from the hidden tool catalog by name. Use list_tools first to discover available tools.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: "Exact tool name as returned by list_tools.",
        },
        input: {
          type: ["object", "array", "string", "number", "boolean"],
          description: "Arguments to pass to the target tool.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({ type: "passthrough" }),
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput> => {
      const catalog = new ToolCatalog(options.registry, { excludeNames: options.excludeNames });
      const target = catalog.get(input.name);
      if (!target) {
        return {
          content: [{
            type: "text",
            text: `Tool '${input.name}' is not available in this catalog. Use ${TOOL_CATALOG_LIST_NAME} to browse categories first.`,
          }],
          metadata: {
            experimentalToolSearch: true,
            error: toolError(
              "tool_not_found",
              `Tool '${input.name}' is not available in this catalog.`,
            ),
          },
        };
      }

      if (target.name === TOOL_CATALOG_CALL_NAME || target.name === TOOL_CATALOG_LIST_NAME) {
        return {
          content: [{
            type: "text",
            text: `Tool '${target.name}' cannot be called through ${TOOL_CATALOG_CALL_NAME}. Call it directly instead.`,
          }],
          metadata: {
            experimentalToolSearch: true,
            error: toolError(
              "unsupported_tool",
              `Tool '${target.name}' cannot be proxied through ${TOOL_CATALOG_CALL_NAME}.`,
            ),
          },
        };
      }

      if (!context.toolExecutor) {
        return {
          content: [{
            type: "text",
            text: `Tool executor is not configured for ${TOOL_CATALOG_CALL_NAME}.`,
          }],
          metadata: {
            experimentalToolSearch: true,
            error: toolError(
              "unsupported_tool",
              `Tool executor is not configured for ${TOOL_CATALOG_CALL_NAME}.`,
            ),
          },
        };
      }

      const result = await context.toolExecutor.execute(
        {
          id: context.currentToolCallId
            ? `${context.currentToolCallId}:${target.name}`
            : `proxy:${target.name}`,
          name: target.name,
          input: input.input ?? {},
        },
        context,
      );
      return proxiedResultToOutput(result, target.name);
    },
  };
}

function proxiedResultToOutput(
  result: PilotDeckToolResult,
  toolName: string,
): PilotDeckToolExecutionOutput {
  const textPrefix = `Proxied tool '${toolName}'`;
  if (result.type === "error") {
    return {
      content: [{
        type: "text",
        text: `${textPrefix} failed: ${result.error.message}`,
      }],
      data: {
        ok: false,
        proxiedToolName: toolName,
        result,
      },
      metadata: {
        experimentalToolSearch: true,
        proxiedToolName: toolName,
        proxiedResultType: "error",
      },
    };
  }

  return {
    content: result.content.length > 0
      ? result.content
      : [{ type: "text", text: `${textPrefix} completed successfully.` }],
    supplementalMessages: result.supplementalMessages,
    data: {
      ok: true,
      proxiedToolName: toolName,
      result,
    },
    metadata: {
      ...(result.metadata ?? {}),
      experimentalToolSearch: true,
      proxiedToolName: toolName,
      proxiedResultType: "success",
    },
  };
}
