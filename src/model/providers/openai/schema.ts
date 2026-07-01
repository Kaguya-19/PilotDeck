/**
 * Azure/OpenAI-compatible endpoints can require `items` whenever a schema node
 * allows `array` (including union types like `type: ["string", "array"]`).
 * Normalize tool input schemas defensively to avoid provider-side 400s.
 */
export function normalizeOpenAISchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeOpenAISchemaNode(schema) as Record<string, unknown>;
}

function normalizeOpenAISchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeOpenAISchemaNode);
  }
  if (!isRecord(node)) {
    return node;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeOpenAISchemaNode(value);
  }

  const typeField = normalized.type;
  const allowsArray = typeField === "array"
    || (Array.isArray(typeField) && typeField.includes("array"));
  if (allowsArray && !("items" in normalized)) {
    normalized.items = {};
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
