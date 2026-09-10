/** Coalesce pointer samples before doing layout work; flush the last on release. */
export function createFrameBatcher<T>(apply: (value: T) => void) {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };
  const flush = () => {
    const next = pending;
    cancel();
    if (next) apply(next.value);
  };
  return {
    schedule(value: T) {
      pending = { value };
      if (frame === null) frame = requestAnimationFrame(flush);
    },
    flush,
    cancel,
  };
}
