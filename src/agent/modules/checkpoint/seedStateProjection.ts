import type { AgentLoopSeedState } from "../../loop/AgentLoop.js";
import type {
  PilotDeckReadFileStateEntry,
  PilotDeckReadFileStateMap,
  PilotDeckWriteSnapshotEntry,
  PilotDeckWriteSnapshotMap,
} from "../../../tool/index.js";

/** Validate the host-neutral projection of AgentLoop file state. */
export function parseAgentLoopSeedStateProjection(value: unknown): AgentLoopSeedState | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asPlainRecord(value);
  if (!source) throw new Error("Invalid sidecar seedState: expected an object.");

  const seed: AgentLoopSeedState = {};
  if (source.allowedReadFiles !== undefined) {
    if (!Array.isArray(source.allowedReadFiles) || source.allowedReadFiles.some((path) => typeof path !== "string")) {
      throw new Error("Invalid sidecar seedState.allowedReadFiles.");
    }
    seed.allowedReadFiles = [...source.allowedReadFiles];
  }
  if (source.readFileState !== undefined) {
    seed.readFileState = parseReadFileStateProjection(source.readFileState);
  }
  if (source.writeSnapshots !== undefined) {
    seed.writeSnapshots = parseWriteSnapshotProjection(source.writeSnapshots);
  }
  return seed;
}

/**
 * Convert the in-memory file-state maps into the host-neutral Module Protocol
 * payload. The inverse parser accepts these plain records after a sidecar
 * terminal event crosses JSON transport.
 */
export function serializeAgentLoopSeedStateProjection(
  seedState: AgentLoopSeedState,
): Record<string, unknown> {
  return {
    ...(seedState.allowedReadFiles ? { allowedReadFiles: [...seedState.allowedReadFiles] } : {}),
    ...(seedState.readFileState ? { readFileState: Object.fromEntries(seedState.readFileState) } : {}),
    ...(seedState.writeSnapshots ? { writeSnapshots: Object.fromEntries(seedState.writeSnapshots) } : {}),
  };
}

function parseReadFileStateProjection(value: unknown): PilotDeckReadFileStateMap {
  const result: PilotDeckReadFileStateMap = new Map();
  for (const [path, rawEntry] of projectionEntries(value, "Invalid sidecar seedState.readFileState.")) {
    const entry = asPlainRecord(rawEntry);
    if (!entry || typeof entry.mtimeMs !== "number" || !isReadKind(entry.kind)) {
      throw new Error(`Invalid readFileState entry: ${path}.`);
    }
    result.set(path, {
      mtimeMs: entry.mtimeMs,
      kind: entry.kind,
      ...(typeof entry.offset === "number" ? { offset: entry.offset } : {}),
      ...(typeof entry.limit === "number" ? { limit: entry.limit } : {}),
      ...(typeof entry.pages === "string" ? { pages: entry.pages } : {}),
    });
  }
  return result;
}

function parseWriteSnapshotProjection(value: unknown): PilotDeckWriteSnapshotMap {
  const result: PilotDeckWriteSnapshotMap = new Map();
  for (const [path, rawEntry] of projectionEntries(value, "Invalid sidecar seedState.writeSnapshots.")) {
    const entry = asPlainRecord(rawEntry);
    if (
      !entry
      || typeof entry.absolutePath !== "string"
      || typeof entry.mtimeMs !== "number"
      || typeof entry.contentHash !== "string"
    ) {
      throw new Error(`Invalid writeSnapshots entry: ${path}.`);
    }
    result.set(path, {
      absolutePath: entry.absolutePath,
      mtimeMs: entry.mtimeMs,
      contentHash: entry.contentHash,
      ...(typeof entry.offset === "number" ? { offset: entry.offset } : {}),
      ...(typeof entry.limit === "number" ? { limit: entry.limit } : {}),
    });
  }
  return result;
}

function projectionEntries(value: unknown, errorMessage: string): Array<[string, unknown]> {
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [path, entry] of value.entries()) {
      if (typeof path !== "string") throw new Error(errorMessage);
      entries.push([path, entry]);
    }
    return entries;
  }
  const source = asPlainRecord(value);
  if (!source) throw new Error(errorMessage);
  return Object.entries(source);
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function isReadKind(value: unknown): value is PilotDeckReadFileStateEntry["kind"] {
  return value === "text" || value === "image" || value === "pdf" || value === "notebook";
}

export type AgentLoopSeedStateReadProjection = Record<string, PilotDeckReadFileStateEntry>
  | ReadonlyMap<string, PilotDeckReadFileStateEntry>;
export type AgentLoopSeedStateWriteProjection = Record<string, PilotDeckWriteSnapshotEntry>
  | ReadonlyMap<string, PilotDeckWriteSnapshotEntry>;
