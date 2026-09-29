const invalid = (message: string) => Object.assign(new Error(message), { status: 502, code: 'PILOTDECK_HOST_RESPONSE_INVALID' });

export function isHostCapabilityStreamBody(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const body = value as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof body.getReader === 'function' || typeof body[Symbol.asyncIterator] === 'function';
}

/** Frame declared NDJSON objects once; existing SSE/NDJSON bytes stay intact. */
export async function* encodeHostCapabilityStream(chunks: AsyncIterable<unknown> | Iterable<unknown>, contentType?: string | null) {
  for await (const chunk of chunks) {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      yield chunk;
    } else if (contentType?.startsWith('application/x-ndjson') && chunk !== null && typeof chunk === 'object' && !Array.isArray(chunk)) {
      let json;
      try { json = JSON.stringify(chunk); } catch { throw invalid('Host event must be JSON serializable.'); }
      if (typeof json !== 'string') throw invalid('Host event must be JSON serializable.');
      yield `${json}\n`;
    } else {
      throw invalid('Host stream requires bytes, strings, or declared NDJSON events.');
    }
  }
}

export const PUBLIC_HOST_WIRE_OPERATIONS = Object.freeze([
  'list_tools', 'create_tool', 'update_tool', 'test_tool', 'probe_unsaved_tool', 'remove_tool',
  'list_general_skills', 'import_general_skill', 'publish_general_skill', 'archive_general_skill', 'test_general_skill',
  'list_model_catalog', 'extract_sop_text', 'model_prepare', 'model_stream', 'file_parse',
  'task_start', 'task_status', 'task_result', 'task_cancel', 'task_events',
]);

export const PUBLIC_HOST_WIRE_HEADERS = Object.freeze([
  'content-type', 'etag', 'retry-after', 'x-request-id', 'x-pilotdeck-model-id', 'x-pilotdeck-provider-id',
]);
