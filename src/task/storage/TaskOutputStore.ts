/**
 * Per-task output buffer (C5 §6.5.5 step 2).
 *
 * Implementation notes:
 *   - In-memory ring buffer holds up to `maxMemoryBytes` (default 1 MB).
 *   - On overflow, oldest bytes are dropped (`truncated = true`) — the spec
 *     calls for "1 MB ring buffer + disk spill". Disk spill is *optional*
 *     (cb provided via `diskSpill`); the default constructor stores
 *     in-memory only, sufficient for tests and a forwards-compatible
 *     persistence hook.
 *   - `readSlice(offset, maxBytes)` returns the bytes from `offset` to the
 *     current head, capped at `maxBytes`. The caller updates `offset` and
 *     polls again. If `offset` is older than what the buffer retains, we
 *     return everything available with `truncated=true`.
 *   - `totalBytes()` is monotonically increasing — it represents the total
 *     volume seen, not the buffer size. Callers can use it as the next
 *     polling offset.
 */

import { closeSync, openSync, promises as fs, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { PilotDeckTaskOutputSlice } from "../protocol/types.js";

export type TaskOutputStoreOptions = {
  taskId: string;
  /** Hard cap on in-memory bytes retained (default 1 MB). */
  maxMemoryBytes?: number;
  /**
   * Optional spill directory. When set, every overflow chunk is appended to
   * `<diskSpillDir>/<taskId>.log` so callers can read the full transcript
   * later (off the ring-buffer fast path).
   */
  diskSpillDir?: string;
  /** Recover the retained output window from an already-flushed spill file. */
  restore?: {
    expectedTotalBytes: number;
  };
};

const DEFAULT_MEMORY_BYTES = 1_000_000;

export class TaskOutputStore {
  private chunks: Buffer[] = [];
  private memBytes = 0;
  private totalSeenBytes = 0;
  private droppedBytes = 0;
  private readonly options: TaskOutputStoreOptions;
  private readonly maxMemoryBytes: number;
  private readonly diskSpillPath: string | null;
  private spillReady = false;
  private spillTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: TaskOutputStoreOptions) {
    this.options = options;
    this.maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.diskSpillPath = options.diskSpillDir
      ? path.join(options.diskSpillDir, `${options.taskId}.log`)
      : null;
    if (options.restore) this.restoreFromSpill(options.restore.expectedTotalBytes);
  }

  /** Append a stdout/stderr chunk. */
  append(chunk: Buffer | string): void {
    if (this.closed) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    this.totalSeenBytes += buf.length;

    if (this.diskSpillPath) {
      this.queueSpill(buf);
    }

    this.chunks.push(buf);
    this.memBytes += buf.length;
    while (this.memBytes > this.maxMemoryBytes && this.chunks.length > 0) {
      const overflow = this.memBytes - this.maxMemoryBytes;
      const oldest = this.chunks[0]!;
      if (oldest.length <= overflow) {
        this.chunks.shift();
        this.memBytes -= oldest.length;
        this.droppedBytes += oldest.length;
      } else {
        this.chunks[0] = oldest.subarray(overflow);
        this.memBytes -= overflow;
        this.droppedBytes += overflow;
      }
    }
  }

  /**
   * Read the slice at [offset, head). Bytes preceding `offset` that have
   * been dropped from memory are reflected via `truncated=true`. Pass
   * `maxBytes` to bound the return size.
   */
  readSlice(offset: number, maxBytes?: number): PilotDeckTaskOutputSlice {
    const head = this.totalSeenBytes;
    let cursor = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const cap = maxBytes ?? Infinity;
    let remaining = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : this.maxMemoryBytes;
    let truncated = false;
    const slices: Buffer[] = [];

    if (cursor < this.droppedBytes && this.diskSpillPath && remaining > 0) {
      const disk = this.readDiskSlice(cursor, remaining);
      if (disk) {
        slices.push(disk.content);
        cursor = disk.nextOffset;
        remaining -= disk.content.length;
      }
    }

    if (remaining <= 0) {
      return {
        content: Buffer.concat(slices).toString("utf8"),
        nextOffset: cursor,
        totalBytes: head,
        truncated,
      };
    }

    if (cursor < this.droppedBytes) {
      // The in-memory ring no longer has this range and the disk spill has
      // not flushed it yet (or is unavailable), so report an explicit gap.
      truncated = true;
      cursor = this.droppedBytes;
    }

    if (cursor >= head) {
      return {
        content: Buffer.concat(slices).toString("utf8"),
        nextOffset: Math.min(cursor, head),
        totalBytes: head,
        truncated,
      };
    }

    const wanted = Math.min(head - cursor, remaining);
    if (wanted <= 0) {
      return {
        content: Buffer.concat(slices).toString("utf8"),
        nextOffset: cursor,
        totalBytes: head,
        truncated,
      };
    }
    let toSkip = cursor - this.droppedBytes;
    let collected = 0;
    for (const buf of this.chunks) {
      if (collected >= wanted) break;
      if (toSkip >= buf.length) {
        toSkip -= buf.length;
        continue;
      }
      const start = toSkip;
      toSkip = 0;
      const remaining = wanted - collected;
      const end = Math.min(buf.length, start + remaining);
      slices.push(buf.subarray(start, end));
      collected += end - start;
    }
    const content = Buffer.concat(slices).toString("utf8");
    return {
      content,
      nextOffset: cursor + collected,
      totalBytes: head,
      truncated,
    };
  }

  totalBytes(): number {
    return this.totalSeenBytes;
  }

  /** Wait until accepted spill writes are durable without discarding readable output. */
  flush(): Promise<void> {
    return this.spillTail;
  }

  hasDurableOutput(): boolean {
    return this.diskSpillPath !== null;
  }

  /** Flush accepted spill writes before releasing the in-memory buffer. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.flush().then(() => {
      this.chunks = [];
      this.memBytes = 0;
    });
    return this.closePromise;
  }

  // ---------------------------------------------------------------------

  private queueSpill(chunk: Buffer): void {
    this.spillTail = this.spillTail.then(() => this.writeSpill(chunk));
  }

  private async writeSpill(chunk: Buffer): Promise<void> {
    if (!this.diskSpillPath) return;
    try {
      if (!this.spillReady) {
        await fs.mkdir(path.dirname(this.diskSpillPath), { recursive: true });
        this.spillReady = true;
      }
      await fs.appendFile(this.diskSpillPath, chunk);
    } catch {
      // Disk spill is best-effort; never crash the runtime over a write
      // error. Subsequent appends retry through the same ordered chain.
      this.spillReady = false;
    }
  }

  private restoreFromSpill(expectedTotalBytes: number): void {
    if (!Number.isSafeInteger(expectedTotalBytes) || expectedTotalBytes < 0) {
      throw new TypeError("Task output restore totalBytes must be a non-negative safe integer.");
    }
    if (!this.diskSpillPath) {
      throw new Error("Task output cannot be restored without durable spill storage.");
    }
    let output: Buffer;
    try {
      output = readFileSync(this.diskSpillPath);
    } catch (error) {
      if (expectedTotalBytes === 0 && isMissingFile(error)) {
        output = Buffer.alloc(0);
      } else {
        throw new Error(`Could not restore task output from ${this.diskSpillPath}.`, { cause: error });
      }
    }
    if (output.length !== expectedTotalBytes) {
      throw new Error(
        `Task output at ${this.diskSpillPath} has ${output.length} bytes; expected ${expectedTotalBytes}.`,
      );
    }
    this.totalSeenBytes = output.length;
    const retainedStart = Math.max(0, output.length - this.maxMemoryBytes);
    const retained = output.subarray(retainedStart);
    if (retained.length > 0) this.chunks = [retained];
    this.memBytes = retained.length;
    this.droppedBytes = retainedStart;
    this.spillReady = true;
  }

  private readDiskSlice(offset: number, maxBytes: number): { content: Buffer; nextOffset: number } | undefined {
    if (!this.diskSpillPath || maxBytes <= 0) return undefined;
    let size: number;
    try {
      size = statSync(this.diskSpillPath).size;
    } catch {
      return undefined;
    }
    const readable = Math.min(size, this.totalSeenBytes) - offset;
    if (readable <= 0) return undefined;
    const wanted = Math.min(readable, maxBytes);
    let handle: number | undefined;
    try {
      handle = openSync(this.diskSpillPath, "r");
      const target = Buffer.allocUnsafe(wanted);
      const read = readSync(handle, target, 0, wanted, offset);
      if (read === 0) return undefined;
      return { content: target.subarray(0, read), nextOffset: offset + read };
    } catch {
      return undefined;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
