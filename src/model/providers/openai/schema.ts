/**
 * Azure/OpenAI-compatible endpoints can require `items` whenever a schema node
 * allows `array` (including union types like `type: ["string", "array"]`).
 * Moonshot/Kimi also requires explicit `type` on literal `enum`/`const` nodes.
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

  if (!("type" in normalized)) {
    const inferredType = inferLiteralSchemaType(normalized);
    if (inferredType) {
      normalized.type = inferredType;
    }
  }

  const typeField = normalized.type;
  const allowsArray = typeField === "array"
    || (Array.isArray(typeField) && typeField.includes("array"));
  if (allowsArray && !("items" in normalized)) {
    normalized.items = {};
  }

  return normalized;
}

function inferLiteralSchemaType(node: Record<string, unknown>): string | undefined {
  if ("const" in node) {
    return schemaTypeForLiteral(node.const);
  }

  const enumValues = node.enum;
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return undefined;
  }

  const types = enumValues.map(schemaTypeForLiteral);
  if (types.some((type) => !type)) {
    return undefined;
  }

  const uniqueTypes = new Set(types);
  if (uniqueTypes.size === 1) {
    return types[0];
  }

  if (uniqueTypes.size === 2 && uniqueTypes.has("integer") && uniqueTypes.has("number")) {
    return "number";
  }

  return undefined;
}

function schemaTypeForLiteral(value: unknown): string | undefined {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isRecord(value)) {
    return "object";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
