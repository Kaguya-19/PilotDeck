import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolCallBlock,
  CanonicalToolResultBlock,
  CanonicalModelRequest,
} from "./canonical.js";

export function messageContent(message: Pick<CanonicalMessage, "content">): CanonicalContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Deep-clone a single content block. Handles nested structures that a plain
 * spread would share by reference:
 *
 *  - `tool_result` → deep-clones the inner `content` array and each element.
 *  - `tool_call`   → `structuredClone`s the opaque `input` payload.
 *  - All other block types have only primitive-valued properties; a spread
 *    is sufficient.
 *
 * The `raw` field is intentionally left as a shared reference — it is a
 * read-only provider echo used only for debugging and never mutated.
 */
export function cloneContentBlock(block: CanonicalContentBlock): CanonicalContentBlock {
  if (block.type === "tool_result") {
    const tr = block as CanonicalToolResultBlock;
    return {
      ...tr,
      content: tr.content.map((item) => ({ ...item })),
    };
  }
  if (block.type === "tool_call") {
    const tc = block as CanonicalToolCallBlock;
    return {
      ...tc,
      input: tc.input !== undefined ? structuredClone(tc.input) : tc.input,
    };
  }
  return { ...block };
}

export function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: messageContent(message).map(cloneContentBlock),
  };
}

export function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(cloneMessage);
}

/**
 * Capture the canonical model request at the provider admission boundary.
 *
 * A prepared request is the retry snapshot for one model request series.  It
 * must not observe later prompt/tool-registry mutations, and a host/remote
 * adapter must be able to send it again without asking the context provider to
 * assemble a second request.  Canonical requests are protocol values, so a
 * structured clone gives provider adapters an isolated copy; the recursive
 * freeze makes accidental in-process mutation fail fast as well.
 */
export function snapshotCanonicalModelRequest(request: CanonicalModelRequest): CanonicalModelRequest {
  return deepFreeze(structuredClone(request));
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
