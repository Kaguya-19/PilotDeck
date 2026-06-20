import type { PilotDeckJsonSchema } from "../protocol/schema.js";
import type { PilotDeckToolDefinition, PilotDeckToolKind } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";

export type ToolCatalogCategory = {
  name: PilotDeckToolKind;
  count: number;
};

export type ToolCatalogSummary = {
  name: string;
  kind: PilotDeckToolKind;
  title?: string;
  description: string;
  input: Record<string, string>;
  required: string[];
  readOnly: boolean | null;
  destructive: boolean | null;
  openWorld: boolean | null;
};

export type ToolCatalogOptions = {
  excludeNames?: Iterable<string>;
};

export class ToolCatalog {
  private readonly excluded: Set<string>;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolCatalogOptions = {},
  ) {
    this.excluded = new Set(options.excludeNames ?? []);
  }

  categories(): ToolCatalogCategory[] {
    const counts = new Map<PilotDeckToolKind, number>();
    for (const tool of this.tools()) {
      counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  summaries(category?: string, limit = 50, cursor = 0): {
    tools: ToolCatalogSummary[];
    nextCursor?: number;
    total: number;
  } {
    const normalizedCategory = category?.trim();
    const all = this.tools()
      .filter((tool) => !normalizedCategory || tool.kind === normalizedCategory)
      .map(summarizeTool)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const start = Math.max(0, cursor);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const page = all.slice(start, start + safeLimit);
    const nextCursor = start + page.length < all.length ? start + page.length : undefined;
    return { tools: page, nextCursor, total: all.length };
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  get(name: string): PilotDeckToolDefinition | undefined {
    const tool = this.registry.get(name);
    if (!tool || this.excluded.has(tool.name)) {
      return undefined;
    }
    return tool;
  }

  private tools(): PilotDeckToolDefinition[] {
    return this.registry.list().filter((tool) => !this.excluded.has(tool.name));
  }
}

function summarizeTool(tool: PilotDeckToolDefinition): ToolCatalogSummary {
  return {
    name: tool.name,
    kind: tool.kind,
    ...(tool.title ? { title: tool.title } : {}),
    description: firstSentence(tool.searchHint ?? tool.description),
    input: summarizeInput(tool.inputSchema.properties ?? {}),
    required: tool.inputSchema.required ?? [],
    readOnly: safeBooleanProbe(() => tool.isReadOnly({} as never)),
    destructive: safeBooleanProbe(() => tool.isDestructive?.({} as never)),
    openWorld: safeBooleanProbe(() => tool.isOpenWorld?.({} as never)),
  };
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) {
    return normalized;
  }
  return `${normalized.slice(0, 217).trimEnd()}...`;
}

function summarizeInput(properties: Record<string, PilotDeckJsonSchema>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
    const marker = type ?? (schema.enum ? "enum" : schema.properties ? "object" : "unknown");
    out[name] = schema.description ? `${marker}: ${schema.description}` : marker;
  }
  return out;
}

function safeBooleanProbe(fn: () => boolean | undefined): boolean | null {
  try {
    const value = fn();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}
