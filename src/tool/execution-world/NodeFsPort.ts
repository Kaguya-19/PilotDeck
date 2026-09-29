import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, readdir, readFile as nodeReadFile, stat as nodeStat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { FsPort } from "./FsPort.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";

const UTF8_BOM = "\uFEFF";

/** Native Node provider preserving PilotDeck's existing filesystem semantics. */
export function createNodeFsPort(): FsPort {
  return {
    async stat(path, signal) {
      throwIfAborted(signal);
      const value = await nodeStat(path);
      return {
        kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other",
        size: value.size,
        mtimeMs: value.mtimeMs,
      };
    },
    async readDirectory(directory, signal) {
      throwIfAborted(signal);
      const entries = await readdir(directory, { withFileTypes: true });
      throwIfAborted(signal);
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    },
    async readFile(path, options = {}) {
      throwIfAborted(options.signal);
      if (options.encoding === "utf8") {
        return nodeReadFile(path, { encoding: "utf8", signal: options.signal });
      }
      const value = await nodeReadFile(path, { signal: options.signal });
      return new Uint8Array(value);
    },
    readFileInRange,
    async writeText(filePath, content, options = {}) {
      throwIfAborted(options.signal);
      const existing = await nodeStat(filePath).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && !existing.isFile()) {
        throw new PilotDeckToolRuntimeError("file_conflict", `${filePath} exists and is not a regular file.`);
      }
      if (existing && !options.allowOverwrite) {
        throw new PilotDeckToolRuntimeError(
          "file_conflict",
          `${filePath} already exists. Set allow_overwrite to true to overwrite it.`,
        );
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      throwIfAborted(options.signal);
      await writeFile(filePath, content, "utf8");
      const written = await nodeStat(filePath);
      return { action: existing ? "overwritten" : "created", mtimeMs: Math.floor(written.mtimeMs) };
    },
  };
}

async function readFileInRange(
  filePath: string,
  startLine: number,
  limit?: number,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const fileStat = await nodeStat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PilotDeckToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });
  if (!fileStat.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${filePath} is not a regular file.`);
  }

  if (limit !== undefined) {
    return readFileLineRange(filePath, fileStat, startLine, limit, signal);
  }

  const buffer = await nodeReadFile(filePath, { signal }).catch((error: unknown) => {
    if (signal?.aborted) throw abortedReadError();
    throw error;
  });
  if (buffer.includes(0)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  const text = stripBom(buffer.toString("utf8"));
  const lines = text.split(/\r?\n/);
  const normalizedStart = Math.max(1, startLine);
  const startIndex = normalizedStart - 1;
  const selected = lines.slice(startIndex);
  const content = selected.join("\n");
  const actualStart = selected.length > 0 ? normalizedStart : Math.min(normalizedStart, lines.length + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;

  return {
    content,
    fullContent: text,
    lineCount: selected.length,
    totalLines: lines.length,
    totalBytes: buffer.byteLength,
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: Math.floor(fileStat.mtimeMs),
    startLine: actualStart,
    endLine: actualEnd,
    truncated: startIndex > 0,
  };
}

async function readFileLineRange(
  filePath: string,
  fileStat: Stats,
  startLine: number,
  limit: number,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const normalizedStart = Math.max(1, startLine);
  const normalizedLimit = Math.max(0, limit);
  const startIndex = normalizedStart - 1;
  const endIndexExclusive = startIndex + normalizedLimit;
  const selected: string[] = [];
  let totalLines = 0;
  let sawNul = false;
  let aborted = false;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  let rl: ReturnType<typeof createInterface> | undefined;
  const stopReading = () => {
    rl?.close();
    stream.destroy();
  };
  const onData = (chunk: string | Buffer) => {
    if (String(chunk).includes("\0")) {
      sawNul = true;
      stopReading();
    }
  };
  const onAbort = () => {
    aborted = true;
    stopReading();
  };
  stream.on("data", onData);
  signal?.addEventListener("abort", onAbort, { once: true });

  rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const line = totalLines === 0 ? stripBom(rawLine) : rawLine;
      if (totalLines >= startIndex && totalLines < endIndexExclusive) {
        selected.push(line);
      }
      totalLines += 1;
    }
  } catch (error) {
    if (!sawNul && !aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.off("data", onData);
    stopReading();
  }

  if (aborted || signal?.aborted) throw abortedReadError();
  if (sawNul) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  const content = selected.join("\n");
  const actualStart = selected.length > 0 ? normalizedStart : Math.min(normalizedStart, totalLines + 1);
  const actualEnd = selected.length > 0 ? actualStart + selected.length - 1 : actualStart - 1;

  return {
    content,
    lineCount: selected.length,
    totalLines,
    totalBytes: fileStat.size,
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: Math.floor(fileStat.mtimeMs),
    startLine: actualStart,
    endLine: actualEnd,
    truncated: startIndex > 0 || endIndexExclusive < totalLines,
  };
}

function stripBom(value: string): string {
  return value.startsWith(UTF8_BOM) ? value.slice(1) : value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortedReadError();
  }
}

function abortedReadError(): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError("tool_aborted", "File reading was aborted.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
