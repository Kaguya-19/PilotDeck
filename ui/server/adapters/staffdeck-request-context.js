/** Tie an upstream request to the browser connection as well as its timeout.
 * The route owner must dispose listeners in finally, including identity failures.
 */
export function createStaffDeckRequestContext(req, res, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const disconnected = () => { if (!res.writableFinished) abort(); };
  req.on('aborted', abort);
  res.on('close', disconnected);
  if (req.aborted || res.destroyed) abort();
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new DOMException('StaffDeck request timed out', 'TimeoutError')), timeoutMs)
    : undefined;
  timer?.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', disconnected);
    },
  };
}

/** An existing SOP's path identity wins over a conflicting content identity. */
export function staffDeckCreateContent(input) {
  if (!input?.content || typeof input.content !== 'object' || Array.isArray(input.content)) {
    throw Object.assign(new Error('SOP create requires a content object.'), { status: 400, code: 'SOP_MANAGEMENT_INPUT_INVALID' });
  }
  const sopId = typeof input.sopId === 'string' ? input.sopId.trim() : '';
  return sopId ? { ...input.content, skill_id: sopId } : { ...input.content };
}

/** Keep the exact returned draft's ETag; never fetch a newer ETag for old content. */
export function staffDeckDraftResponse(payload, response, operation) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && !payload.etag && ['create', 'get_draft', 'replace_draft', 'rollback'].includes(operation)) {
    const etag = response.headers.get('etag');
    if (etag) return { ...payload, etag };
  }
  return payload;
}
