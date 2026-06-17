import { randomUUID } from "node:crypto";
import type { CanonicalToolCall } from "../protocol/canonical.js";

export type ParseResult = {
  toolCalls: CanonicalToolCall[];
  remainingText: string;
};

export type ToolCallFormatDefinition = {
  id: string;
  displayName: string;
  modelFamilies: string[];
  markers: string[];
  parse: (text: string) => ParseResult | null;
  selfCorrectPrompt: string;
  example: string;
};

// ──────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────

function extractBalanced(text: string, startIdx: number, open: string, close: string): string | null {
  if (text[startIdx] !== open) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
  }
  return null;
}

function extractBalancedBraces(text: string, startIdx: number): string | null {
  return extractBalanced(text, startIdx, "{", "}");
}

function extractBalancedBrackets(text: string, startIdx: number): string | null {
  return extractBalanced(text, startIdx, "[", "]");
}

// ──────────────────────────────────────────────────────────────
// Format implementations
// ──────────────────────────────────────────────────────────────

const QWEN_FUNC_RE = /<function=(\w+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAM_RE = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;

function parseQwenXml(text: string): ParseResult | null {
  if (!text.includes("<function=")) return null;

  const toolCalls: CanonicalToolCall[] = [];
  let remaining = text;

  for (const match of text.matchAll(QWEN_FUNC_RE)) {
    const name = match[1]!;
    const body = match[2]!;
    const input: Record<string, string> = {};

    for (const paramMatch of body.matchAll(QWEN_PARAM_RE)) {
      input[paramMatch[1]!] = paramMatch[2]!.trim();
    }

    toolCalls.push({ id: generateId(), name, input });
  }

  if (toolCalls.length === 0) return null;

  remaining = remaining.replace(QWEN_FUNC_RE, "");
  remaining = remaining.replace(/<\/?tool_call>/g, "");
  remaining = remaining.replace(/<\/think>/g, "");
  remaining = remaining.trim();

  return { toolCalls, remainingText: remaining };
}

const DSML_INVOKE_RE = /<\uff5cDSML\uff5cinvoke\s+name="(\w+)">([\s\S]*?)<\/\uff5cDSML\uff5cinvoke>/g;
const DSML_PARAM_RE = /<\uff5cDSML\uff5cparameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/content>/g;

function parseDeepSeekDsml(text: string): ParseResult | null {
  if (!text.includes("\uff5cDSML\uff5c")) return null;

  const toolCalls: CanonicalToolCall[] = [];

  for (const match of text.matchAll(DSML_INVOKE_RE)) {
    const name = match[1]!;
    const body = match[2]!;
    const input: Record<string, string> = {};

    for (const paramMatch of body.matchAll(DSML_PARAM_RE)) {
      input[paramMatch[1]!] = paramMatch[2]!.trim();
    }

    toolCalls.push({ id: generateId(), name, input });
  }

  if (toolCalls.length === 0) return null;

  const remaining = text.replace(/<\uff5cDSML\uff5ctool_calls>[\s\S]*?<\/\uff5cDSML\uff5ctool_calls>/g, "").trim();
  return { toolCalls, remainingText: remaining };
}

function parseHermesJson(text: string): ParseResult | null {
  if (!text.includes("<tool_call>")) return null;
  if (text.includes("<function=")) return null;

  const toolCalls: CanonicalToolCall[] = [];
  let remaining = text;

  const OPEN_TAG = "<tool_call>";
  const CLOSE_TAG = "</tool_call>";
  let searchFrom = 0;

  while (true) {
    const openIdx = text.indexOf(OPEN_TAG, searchFrom);
    if (openIdx < 0) break;
    const closeIdx = text.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length);
    if (closeIdx < 0) break;

    const inner = text.slice(openIdx + OPEN_TAG.length, closeIdx).trim();
    const braceStart = inner.indexOf("{");
    if (braceStart >= 0) {
      const jsonStr = extractBalancedBraces(inner, braceStart);
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.name && typeof parsed.name === "string") {
            toolCalls.push({
              id: generateId(),
              name: parsed.name,
              input: parsed.arguments ?? parsed.parameters ?? {},
            });
          }
        } catch {
          // skip
        }
      }
    }
    remaining = remaining.replace(text.slice(openIdx, closeIdx + CLOSE_TAG.length), "");
    searchFrom = closeIdx + CLOSE_TAG.length;
  }

  if (toolCalls.length === 0) return null;
  return { toolCalls, remainingText: remaining.trim() };
}

function parseMistral(text: string): ParseResult | null {
  const tag = "[TOOL_CALLS]";
  const tagIdx = text.indexOf(tag);
  if (tagIdx < 0) return null;

  const arrStart = text.indexOf("[", tagIdx + tag.length);
  if (arrStart < 0) return null;

  const arrStr = extractBalancedBrackets(text, arrStart);
  if (!arrStr) return null;

  try {
    const parsed = JSON.parse(arrStr);
    if (!Array.isArray(parsed)) return null;

    const toolCalls: CanonicalToolCall[] = parsed
      .filter((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return obj && typeof obj.name === "string";
      })
      .map((item: Record<string, unknown>) => ({
        id: generateId(),
        name: item.name as string,
        input: (item.arguments ?? item.parameters ?? {}) as unknown,
      }));

    if (toolCalls.length === 0) return null;

    const remaining = text.slice(0, tagIdx).trim() + " " + text.slice(arrStart + arrStr.length).trim();
    return { toolCalls, remainingText: remaining.trim() };
  } catch {
    return null;
  }
}

const LLAMA_TAG = "<|python_tag|>";

function parseLlama(text: string): ParseResult | null {
  if (!text.includes(LLAMA_TAG)) return null;

  const toolCalls: CanonicalToolCall[] = [];
  let remaining = text;
  let idx = text.indexOf(LLAMA_TAG);

  while (idx >= 0) {
    const jsonStart = text.indexOf("{", idx + LLAMA_TAG.length);
    if (jsonStart < 0) break;

    const jsonStr = extractBalancedBraces(text, jsonStart);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.name && typeof parsed.name === "string") {
          toolCalls.push({
            id: generateId(),
            name: parsed.name,
            input: parsed.parameters ?? parsed.arguments ?? {},
          });
          remaining = remaining.replace(LLAMA_TAG + text.slice(idx + LLAMA_TAG.length, jsonStart) + jsonStr, "");
        }
      } catch {
        // skip unparseable
      }
    }
    idx = text.indexOf(LLAMA_TAG, idx + LLAMA_TAG.length);
  }

  if (toolCalls.length === 0) return null;
  return { toolCalls, remainingText: remaining.trim() };
}

const GENERIC_XML_RE = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
const GENERIC_ARG_RE = /<arg\s+name="([^"]+)">([\s\S]*?)<\/arg>/g;

function parseGenericXml(text: string): ParseResult | null {
  if (!/<invoke\s+name="/.test(text)) return null;

  const toolCalls: CanonicalToolCall[] = [];

  for (const match of text.matchAll(GENERIC_XML_RE)) {
    const name = match[1]!;
    const body = match[2]!;
    const input: Record<string, string> = {};

    for (const argMatch of body.matchAll(GENERIC_ARG_RE)) {
      input[argMatch[1]!] = argMatch[2]!.trim();
    }

    toolCalls.push({ id: generateId(), name, input });
  }

  if (toolCalls.length === 0) return null;

  const remaining = text.replace(GENERIC_XML_RE, "").trim();
  return { toolCalls, remainingText: remaining };
}

// ──────────────────────────────────────────────────────────────
// Format registry — matched in priority order (top-to-bottom)
// ──────────────────────────────────────────────────────────────

export const TOOL_CALL_FORMATS: ToolCallFormatDefinition[] = [
  {
    id: "qwen_xml",
    displayName: "Qwen3 XML",
    modelFamilies: ["qwen", "qwen2", "qwen3"],
    markers: ["<function="],
    parse: parseQwenXml,
    selfCorrectPrompt:
      "Your previous tool call could not be parsed. "
      + "Use the exact format:\n"
      + "<tool_call>\n<function=TOOL_NAME>\n<parameter=KEY>VALUE</parameter>\n</function>\n</tool_call>",
    example:
      "<tool_call>\n<function=read_file>\n<parameter=path>/src/main.ts</parameter>\n</function>\n</tool_call>",
  },
  {
    id: "dsml",
    displayName: "DeepSeek V4 DSML",
    modelFamilies: ["deepseek", "deepseek-v4"],
    markers: ["\uff5cDSML\uff5c"],
    parse: parseDeepSeekDsml,
    selfCorrectPrompt:
      "Your previous DSML tool call was malformed. "
      + "Ensure all \uff5cDSML\uff5cinvoke and \uff5cDSML\uff5cparameter tags are properly opened and closed.",
    example:
      "<\uff5cDSML\uff5ctool_calls>\n<\uff5cDSML\uff5cinvoke name=\"read_file\">\n"
      + "<\uff5cDSML\uff5cparameter name=\"path\" string=\"true\">/src/main.ts</content>\n"
      + "</\uff5cDSML\uff5cinvoke>\n</\uff5cDSML\uff5ctool_calls>",
  },
  {
    id: "hermes",
    displayName: "Hermes / NousResearch",
    modelFamilies: ["hermes", "nous"],
    markers: ["<tool_call>"],
    parse: parseHermesJson,
    selfCorrectPrompt:
      "Your previous tool call could not be parsed. "
      + "Use: <tool_call>\n{\"name\":\"TOOL_NAME\",\"arguments\":{\"key\":\"value\"}}\n</tool_call>",
    example:
      "<tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"/src/main.ts\"}}\n</tool_call>",
  },
  {
    id: "mistral",
    displayName: "Mistral / Devstral",
    modelFamilies: ["mistral", "devstral"],
    markers: ["[TOOL_CALLS]"],
    parse: parseMistral,
    selfCorrectPrompt:
      "Your previous tool call could not be parsed. "
      + "Use: [TOOL_CALLS][{\"name\":\"TOOL_NAME\",\"arguments\":{\"key\":\"value\"}}]",
    example:
      "[TOOL_CALLS][{\"name\":\"read_file\",\"arguments\":{\"path\":\"/src/main.ts\"}}]",
  },
  {
    id: "llama",
    displayName: "Llama 3.x / 4.x",
    modelFamilies: ["llama", "llama3", "llama4"],
    markers: ["<|python_tag|>"],
    parse: parseLlama,
    selfCorrectPrompt:
      "Your previous tool call could not be parsed. "
      + "Use: <|python_tag|>{\"name\":\"TOOL_NAME\",\"parameters\":{\"key\":\"value\"}}",
    example:
      "<|python_tag|>{\"name\":\"read_file\",\"parameters\":{\"path\":\"/src/main.ts\"}}",
  },
  {
    id: "generic_xml",
    displayName: "Generic XML (fallback)",
    modelFamilies: [],
    markers: [],
    parse: parseGenericXml,
    selfCorrectPrompt:
      "Your previous tool call contained XML markup that could not be parsed. "
      + "Please use the tool calling mechanism directly with properly structured arguments.",
    example:
      "<invoke name=\"read_file\"><arg name=\"path\">/src/main.ts</arg></invoke>",
  },
];

// ──────────────────────────────────────────────────────────────
// Query utilities
// ──────────────────────────────────────────────────────────────

export function getAllMarkers(): string[] {
  return TOOL_CALL_FORMATS.flatMap((f) => f.markers);
}

export function getFormatById(id: string): ToolCallFormatDefinition | undefined {
  return TOOL_CALL_FORMATS.find((f) => f.id === id);
}

export function detectFormatByModel(model: string): ToolCallFormatDefinition | undefined {
  const lower = model.toLowerCase();
  return TOOL_CALL_FORMATS.find((f) =>
    f.modelFamilies.some((family) => lower.includes(family)),
  );
}

export function detectFormatByText(text: string): ToolCallFormatDefinition | undefined {
  return TOOL_CALL_FORMATS.find(
    (f) => f.markers.length > 0 && f.markers.some((m) => text.includes(m)),
  );
}

export function looksLikeUnparsedToolCall(text: string): boolean {
  const allMarkers = getAllMarkers();
  if (allMarkers.some((m) => text.includes(m))) return true;
  return /<(?:invoke|tool|action|call)\s+(?:name|function)="/i.test(text);
}

export function getSelfCorrectPrompt(
  formatId: string | undefined,
  failedText?: string,
): string {
  if (formatId && formatId !== "auto") {
    const fmt = getFormatById(formatId);
    if (fmt) return fmt.selfCorrectPrompt;
  }
  if (failedText) {
    const detected = detectFormatByText(failedText);
    if (detected) return detected.selfCorrectPrompt;
  }
  return "Your previous tool call contained invalid JSON in the arguments and could not be parsed. "
    + "Please retry with valid JSON. Common issues: missing quotes around keys/values, "
    + "trailing commas, unescaped special characters in strings.";
}

export type SelfCorrectErrorType = "format_parse_error" | "invalid_json" | "unknown_tool" | "truncated";

export function buildSelfCorrectToolResult(
  failedToolCallId: string,
  failedToolName: string,
  formatId: string | undefined,
  failedText?: string,
  errorType?: SelfCorrectErrorType,
): { role: "tool"; tool_call_id: string; content: string } {
  const formatPrompt = getSelfCorrectPrompt(formatId, failedText);
  let typeHint: string;
  switch (errorType) {
    case "truncated":
      typeHint = "Output was truncated by token limit. Split into smaller operations.";
      break;
    case "unknown_tool":
      typeHint = `Tool '${failedToolName}' does not exist.`;
      break;
    case "invalid_json":
      typeHint = "Tool call arguments contained invalid JSON and could not be parsed.";
      break;
    default:
      typeHint = "Tool call could not be parsed.";
      break;
  }
  return {
    role: "tool",
    tool_call_id: failedToolCallId,
    content: `Error: ${typeHint}\n\n${formatPrompt}`,
  };
}

// ──────────────────────────────────────────────────────────────

function generateId(): string {
  return `text_tc_${randomUUID().slice(0, 8)}`;
}
