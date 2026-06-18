import type { GatewayEvent } from "../../../gateway/index.js";

export type ImLiveReplyHandle = unknown;

export type ImLiveReplyTransport<Handle = ImLiveReplyHandle> = {
  send(text: string): Promise<Handle | undefined | false>;
  edit?(handle: Handle, text: string): Promise<void | boolean>;
  delete?(handle: Handle): Promise<void | boolean>;
  clear?(handle: Handle): Promise<void | boolean>;
  maxMessageLength?: number;
  formatText?: (text: string) => string;
};

export type ImLiveReplyControllerOptions<Handle = ImLiveReplyHandle> = {
  transport: ImLiveReplyTransport<Handle>;
  throttleMs?: number;
  bufferThreshold?: number;
  cursor?: string;
  formatToolError?: (event: GatewayEvent & { type: "tool_call_finished"; ok: false }) => string;
  formatError?: (event: GatewayEvent & { type: "error" }) => string;
  onTransportError?: (error: unknown, phase: "send" | "edit" | "delete" | "clear") => void;
};

type Segment<Handle> = {
  text: string;
  handle?: Handle;
  lastVisibleText: string;
  lastVisibleFinalText: string;
  editDisabled: boolean;
  fallbackPrefix: string;
  final: boolean;
};

const DEFAULT_THROTTLE_MS = 800;
const DEFAULT_BUFFER_THRESHOLD = 24;
const DEFAULT_CURSOR = " ▉";

export class ImLiveReplyController<Handle = ImLiveReplyHandle> {
  private readonly transport: ImLiveReplyTransport<Handle>;
  private readonly throttleMs: number;
  private readonly bufferThreshold: number;
  private readonly cursor: string;
  private readonly formatToolError: (event: GatewayEvent & { type: "tool_call_finished"; ok: false }) => string;
  private readonly formatError: (event: GatewayEvent & { type: "error" }) => string;
  private readonly onTransportError?: (error: unknown, phase: "send" | "edit" | "delete" | "clear") => void;

  private currentSegment: Segment<Handle> = createSegment();
  private readonly completedSegments: Array<Segment<Handle>> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private lastFlushAt = 0;
  private closed = false;

  constructor(options: ImLiveReplyControllerOptions<Handle>) {
    this.transport = options.transport;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.bufferThreshold = options.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD;
    this.cursor = options.cursor ?? DEFAULT_CURSOR;
    this.formatToolError = options.formatToolError ?? defaultToolErrorFormatter;
    this.formatError = options.formatError ?? defaultErrorFormatter;
    this.onTransportError = options.onTransportError;
  }

  async handleEvent(event: GatewayEvent): Promise<void> {
    if (this.closed) return;

    switch (event.type) {
      case "assistant_text_delta":
        await this.append(event.text);
        return;
      case "tool_call_started":
        await this.flushSegment();
        return;
      case "tool_call_finished":
        if (!event.ok) {
          await this.append(this.formatToolError(event as GatewayEvent & { type: "tool_call_finished"; ok: false }));
        }
        return;
      case "error":
        await this.append(this.formatError(event));
        return;
      default:
        return;
    }
  }

  async flushFinal(): Promise<void> {
    if (this.closed) return;
    await this.flushSegment();
    this.closed = true;
  }

  async flushSegment(): Promise<void> {
    this.clearTimer();
    await this.flushCurrent({ final: true, force: true });
    if (this.currentSegment.text.trim() || this.currentSegment.lastVisibleText.trim()) {
      this.completedSegments.push(this.currentSegment);
      this.currentSegment = createSegment();
    }
  }

  async clear(): Promise<void> {
    this.clearTimer();
    await this.waitForInFlight();

    const segments = [...this.completedSegments, this.currentSegment];
    for (const segment of segments) {
      if (!segment.handle) continue;
      try {
        if (this.transport.clear) {
          await this.transport.clear(segment.handle);
        } else if (this.transport.delete) {
          await this.transport.delete(segment.handle);
        }
      } catch (error) {
        this.reportTransportError(error, this.transport.clear ? "clear" : "delete");
      }
    }
    this.currentSegment = createSegment();
    this.completedSegments.length = 0;
    this.closed = true;
  }

  private async append(text: string): Promise<void> {
    if (!text) return;
    const liveTextLimit = this.liveTextLimit();
    if (liveTextLimit) {
      let rest = text;
      while (rest) {
        const available = liveTextLimit - this.currentSegment.text.length;
        if (available <= 0) {
          await this.flushSegment();
          continue;
        }

        const piece = rest.length > available ? rest.slice(0, available) : rest;
        await this.appendToCurrentSegment(piece);
        rest = rest.slice(piece.length);
        if (rest) {
          await this.flushSegment();
        }
      }
      return;
    }

    await this.appendToCurrentSegment(text);
  }

  private async appendToCurrentSegment(text: string): Promise<void> {
    if (!text) return;
    const segment = this.currentSegment;
    segment.text += text;

    if (!segment.handle && !segment.editDisabled) {
      await this.flushCurrent({ final: false, force: true });
      return;
    }

    const pendingChars = Math.max(0, segment.text.length - segment.lastVisibleFinalText.length);
    if (pendingChars >= this.bufferThreshold) {
      await this.flushCurrent({ final: false, force: true });
      return;
    }

    this.scheduleFlush();
  }

  private liveTextLimit(): number | undefined {
    const max = this.transport.maxMessageLength;
    if (!max) return undefined;
    return Math.max(1, max - this.cursor.length);
  }

  private scheduleFlush(): void {
    if (this.timer || this.closed) return;
    const delay = Math.max(0, this.throttleMs - (Date.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushCurrent({ final: false, force: false });
    }, delay);
  }

  private async flushCurrent(params: { final: boolean; force: boolean }): Promise<void> {
    this.clearTimer();

    while (this.inFlight) {
      await this.inFlight;
    }

    const current = this.flushCurrentNow(params).finally(() => {
      if (this.inFlight === current) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = current;
    await current;
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private async flushCurrentNow(params: { final: boolean; force: boolean }): Promise<void> {
    const segment = this.currentSegment;
    const finalText = segment.text;
    const hasText = finalText.trim().length > 0;

    if (!hasText) {
      return;
    }

    if (segment.editDisabled) {
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
      return;
    }

    const visibleText = params.final ? finalText : `${finalText}${this.cursor}`;
    const formatted = this.formatForTransport(visibleText);
    if (!params.force && formatted === segment.lastVisibleText) {
      return;
    }

    if (segment.handle && this.transport.edit) {
      try {
        const ok = await this.transport.edit(segment.handle, formatted);
        if (ok === false) {
          await this.enterFallbackMode(segment);
          if (params.final) {
            await this.sendFallbackContinuation(segment, finalText);
            segment.final = true;
          }
          return;
        }
        segment.lastVisibleText = formatted;
        segment.lastVisibleFinalText = finalText;
        segment.final = params.final;
        this.lastFlushAt = Date.now();
        return;
      } catch (error) {
        this.reportTransportError(error, "edit");
        await this.enterFallbackMode(segment);
        if (params.final) {
          await this.sendFallbackContinuation(segment, finalText);
          segment.final = true;
        }
        return;
      }
    }

    if (segment.handle && !this.transport.edit) {
      segment.editDisabled = true;
      segment.fallbackPrefix = segment.lastVisibleFinalText;
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
      return;
    }

    try {
      const handle = await this.transport.send(formatted);
      if (handle === false) {
        segment.editDisabled = true;
        segment.fallbackPrefix = "";
        if (params.final) {
          await this.sendFallbackContinuation(segment, finalText);
          segment.final = true;
        }
        return;
      }
      segment.handle = handle;
      segment.lastVisibleText = formatted;
      segment.lastVisibleFinalText = finalText;
      segment.final = params.final;
      if (handle === undefined || !this.transport.edit) {
        segment.editDisabled = true;
        segment.fallbackPrefix = finalText;
      }
      this.lastFlushAt = Date.now();
    } catch (error) {
      this.reportTransportError(error, "send");
      segment.editDisabled = true;
      segment.fallbackPrefix = "";
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
    }
  }

  private async enterFallbackMode(segment: Segment<Handle>): Promise<void> {
    if (segment.editDisabled) return;
    segment.editDisabled = true;
    segment.fallbackPrefix = segment.lastVisibleFinalText;
    await this.stripCursorBestEffort(segment);
  }

  private async stripCursorBestEffort(segment: Segment<Handle>): Promise<void> {
    if (!segment.handle || !this.transport.edit || !this.cursor) return;
    if (!segment.lastVisibleText.endsWith(this.cursor)) return;

    const clean = segment.lastVisibleText.slice(0, -this.cursor.length);
    try {
      const ok = await this.transport.edit(segment.handle, clean);
      if (ok !== false) {
        segment.lastVisibleText = clean;
      }
    } catch (error) {
      this.reportTransportError(error, "edit");
    }
  }

  private async sendFallbackContinuation(segment: Segment<Handle>, finalText: string): Promise<void> {
    const continuation = continuationText(finalText, segment.fallbackPrefix);
    if (!continuation.trim()) {
      segment.lastVisibleFinalText = finalText;
      return;
    }

    for (const chunk of this.splitForTransport(continuation)) {
      try {
        const handle = await this.transport.send(chunk);
        if (handle === false) {
          return;
        }
        segment.handle = handle;
        segment.lastVisibleText = chunk;
        segment.lastVisibleFinalText = finalText;
        if (handle !== undefined && this.transport.edit) {
          segment.editDisabled = false;
          segment.fallbackPrefix = finalText;
        }
      } catch (error) {
        this.reportTransportError(error, "send");
        return;
      }
    }
    segment.fallbackPrefix = finalText;
  }

  private formatForTransport(text: string): string {
    const formatted = this.transport.formatText ? this.transport.formatText(text) : text;
    const max = this.transport.maxMessageLength;
    if (!max || formatted.length <= max) {
      return formatted;
    }
    return formatted.slice(0, max);
  }

  private splitForTransport(text: string): string[] {
    const formatted = this.transport.formatText ? this.transport.formatText(text) : text;
    const max = this.transport.maxMessageLength;
    if (!max || formatted.length <= max) {
      return [formatted];
    }

    const chunks: string[] = [];
    let rest = formatted;
    while (rest.length > max) {
      let split = rest.lastIndexOf("\n", max);
      if (split < max / 2) split = rest.lastIndexOf(" ", max);
      if (split < max / 2) split = max;
      chunks.push(rest.slice(0, split));
      rest = rest.slice(split).replace(/^\n+/, "");
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private reportTransportError(error: unknown, phase: "send" | "edit" | "delete" | "clear"): void {
    this.onTransportError?.(error, phase);
  }
}

function createSegment<Handle>(): Segment<Handle> {
  return {
    text: "",
    lastVisibleText: "",
    lastVisibleFinalText: "",
    editDisabled: false,
    fallbackPrefix: "",
    final: false,
  };
}

function continuationText(finalText: string, visiblePrefix: string): string {
  if (!visiblePrefix) return finalText;
  if (!finalText.startsWith(visiblePrefix)) return finalText;
  return finalText.slice(visiblePrefix.length).replace(/^\s+/, "");
}

function defaultToolErrorFormatter(event: GatewayEvent & { type: "tool_call_finished"; ok: false }): string {
  const name = event.toolName ?? event.toolCallId;
  return `\n⚠️ ${name} 执行失败\n`;
}

function defaultErrorFormatter(event: GatewayEvent & { type: "error" }): string {
  return `\n❌ ${event.message}\n`;
}
