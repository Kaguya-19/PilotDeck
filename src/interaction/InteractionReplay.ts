/**
 * Convert adapter-owned interaction data into a transport-safe replay value.
 *
 * Reconnect snapshots may cross a WebSocket boundary. They must never retain
 * host objects such as AbortSignal, streams, class instances, or functions.
 * Unknown object values are reduced to their enumerable JSON-shaped fields;
 * unsupported leaves are omitted (or represented as null in arrays).
 */
export function toInteractionReplayValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const replay = toInteractionReplayValue(item, seen);
      return replay === undefined ? null : replay;
    });
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const replay = toInteractionReplayValue(child, seen);
    if (replay !== undefined) output[key] = replay;
  }
  return output;
}
