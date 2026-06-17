import type { CanonicalToolCall } from "../protocol/canonical.js";
import { TOOL_CALL_FORMATS, type ParseResult } from "./toolCallFormats.js";

export type TextToolCallParseResult = ParseResult & {
  /** Which format's markers were detected in the text (if any). */
  detectedFormat?: string;
  /** True when markers were detected but parsing failed to extract tool calls. */
  parseError?: boolean;
};

/**
 * Attempt to extract structured tool calls from assistant text content.
 *
 * When vLLM or other inference engines fail to parse model output into
 * structured `tool_calls`, the raw text ends up in the content field.
 * This function iterates the centralized format registry and converts
 * recognized text patterns into CanonicalToolCall objects.
 *
 * Returns classification metadata (detectedFormat / parseError) so that
 * upstream layers can emit targeted self-correction prompts.
 */
export function extractTextToolCalls(text: string): TextToolCallParseResult {
  for (const format of TOOL_CALL_FORMATS) {
    // Formats with markers: quick pre-check before invoking the parser
    if (format.markers.length > 0) {
      const markerHit = format.markers.some((m) => text.includes(m));
      if (!markerHit) continue;

      const result = format.parse(text);
      if (result && result.toolCalls.length > 0) {
        return { ...result, detectedFormat: format.id };
      }
      // Marker matched but parser couldn't extract anything — soft failure
      return { toolCalls: [], remainingText: text, detectedFormat: format.id, parseError: true };
    }

    // Marker-less formats (e.g. generic_xml): only try parse, no error on failure
    const result = format.parse(text);
    if (result && result.toolCalls.length > 0) {
      return { ...result, detectedFormat: format.id };
    }
  }

  return { toolCalls: [], remainingText: text };
}
