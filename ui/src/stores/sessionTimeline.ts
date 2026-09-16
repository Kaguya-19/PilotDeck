import type { NormalizedMessage } from './useSessionStore';

export type TimelinePosition = {
  version: 1;
  turnId: string;
  id: string;
  previousId?: string;
  order: number;
  revision: number;
  offset?: number;
};

export function isTimelineMessage(message: NormalizedMessage): boolean {
  const p = message.timeline;
  return p?.version === 1 && Boolean(p.id) && Number.isInteger(p.order)
    && Number.isInteger(p.revision) && Boolean(message.turnId || message.runId);
}
const turn = (message: NormalizedMessage) => message.timeline?.turnId || message.turnId || message.runId || '';
// On a parent Agent card, subagentId is a link, not message ownership.
const detailAgent = (message: NormalizedMessage) => message.isSubagentDetail ? message.subagentId : undefined;
const scope = (message: NormalizedMessage) => `${turn(message)}:${detailAgent(message) || ''}`;
const key = (message: NormalizedMessage) => `${message.timeline!.turnId}:${message.timeline!.id}`;
const isContent = (message: NormalizedMessage) => message.kind === 'thinking'
  || message.kind === 'stream_delta' || (message.kind === 'text' && message.role !== 'user');

/** Ordered, versioned content state. UI expansion/scrolling never enter this reducer. */
export class SessionTimeline {
  private rendered = new Map<string, { source: NormalizedMessage; closed: boolean; row: NormalizedMessage }>();
  private blocks = new Map<string, NormalizedMessage>();
  private missingPredecessors = new Set<string>();
  private conflicts = new Set<string>();
  private pending = new Map<string, Map<number, NormalizedMessage>>();
  private closedThrough = new Map<string, number>();
  private removedTurns = new Set<string>();
  private terminalTurns = new Set<string>();

  apply(message: NormalizedMessage): boolean {
    if (!isTimelineMessage(message)) return false;
    const id = key(message);
    const p = message.timeline!;
    if (this.removedTurns.has(p.turnId) || this.removedTurns.has(message.runId || "")) return this.hasGap;
    this.missingPredecessors.delete(id);
    if (p.offset !== undefined && p.previousId && !this.blocks.has(`${p.turnId}:${p.previousId}`)) {
      this.missingPredecessors.add(`${p.turnId}:${p.previousId}`);
    }
    if ((this.terminalTurns.has(p.turnId) || this.terminalTurns.has(message.runId || '')) && !message.isFinal) return this.hasGap;
    // A new block closes earlier blocks, even if packets for them arrive late.
    const channel = scope(message);
    this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, p.order - 1));
    if (message.streamState === 'closed' || message.isFinal) {
      this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, p.order));
    }
    const existing = this.blocks.get(id);
    if (p.offset !== undefined && isContent(message)) {
      const length = existing?.content?.length ?? 0;
      if (existing?.isFinal) return this.hasGap;
      if (p.offset < length) {
        if ((existing?.content ?? '').slice(p.offset, p.offset + (message.content?.length ?? 0)) !== (message.content ?? '')) this.conflicts.add(id);
        return this.hasGap;
      }
      if (p.offset > length) {
        const queued = this.pending.get(id) ?? new Map();
        queued.set(p.offset, message);
        this.pending.set(id, queued);
        return true;
      }
      this.blocks.set(id, this.row({ ...existing, ...message, content: (existing?.content ?? '') + (message.content ?? '') }));
    } else {
      if (existing && existing.timeline!.revision > p.revision) return this.hasGap;
      // A finalized snapshot cannot be reopened by its older live baseline.
      if (existing?.isFinal && !message.isFinal) return this.hasGap;
      this.blocks.set(id, this.row({ ...existing, ...message }));
      this.conflicts.delete(id);
    }
    const queued = this.pending.get(id);
    if (queued) {
      for (const offset of [...queued.keys()].sort((a, b) => a - b)) {
        const length = this.blocks.get(id)?.content?.length ?? 0;
        if (offset > length) break;
        const delta = queued.get(offset)!;
        queued.delete(offset);
        if (!delta) continue;
        if (offset === length && !this.blocks.get(id)?.isFinal) this.apply(delta);
      }
      if (!queued.size || this.blocks.get(id)?.isFinal) this.pending.delete(id);
    }
    return this.hasGap;
  }

  get hasGap(): boolean { return this.pending.size > 0 || this.missingPredecessors.size > 0 || this.conflicts.size > 0; }

  close(runId?: string, terminal = false, subagentId?: string, boundary?: { turnId: string; through: number }): void {
    for (const message of this.blocks.values()) {
      if (runId && turn(message) !== runId && message.runId !== runId) continue;
      if (subagentId !== undefined && detailAgent(message) !== subagentId) continue;
      if (subagentId === undefined && !terminal && detailAgent(message)) continue;
      if (boundary && turn(message) !== boundary.turnId) continue;
      const channel = scope(message);
      this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, boundary?.through ?? message.timeline!.order));
      if (terminal) this.terminalTurns.add(turn(message));
    }
    if (terminal && runId && subagentId === undefined) this.terminalTurns.add(runId);
  }

  removeTurn(runId: string): void {
    this.removedTurns.add(runId);
    for (const [id, message] of this.blocks) if (turn(message) === runId || message.runId === runId) {
      this.blocks.delete(id);
      this.rendered.delete(id);
      this.pending.delete(id);
      this.conflicts.delete(id);
    }
    for (const id of this.missingPredecessors) if (id.startsWith(`${runId}:`)) this.missingPredecessors.delete(id);
    this.terminalTurns.add(runId);
  }

  values(subagentId?: string | null): NormalizedMessage[] {
    return [...this.blocks.values()].filter(m => subagentId === null || detailAgent(m) === subagentId).map(message => {
      const closed = message.isFinal || this.terminalTurns.has(turn(message)) || this.terminalTurns.has(message.runId || "")
        || message.timeline!.order <= (this.closedThrough.get(scope(message)) ?? -1);
      if (!isContent(message)) return message;
      const id = key(message);
      const cached = this.rendered.get(id);
      if (cached?.source === message && cached.closed === Boolean(closed)) return cached.row;
      const row: NormalizedMessage = { ...message,
        kind: message.kind === 'stream_delta' && closed ? 'text' : message.kind,
        streamState: closed ? 'closed' : 'open',
      };
      this.rendered.set(id, { source: message, closed: Boolean(closed), row });
      return row;
    });
  }

  private row(message: NormalizedMessage): NormalizedMessage {
    const id = key(message);
    return { ...message, id, renderKey: id, turnId: message.timeline!.turnId, timeline: { ...message.timeline!, offset: undefined } };
  }
}

/** Turn identity locates a transcript section; protocol order locates its blocks.
 * Legacy content is supplied by the compatibility reducer, never text-matched here.
 */
export function mergeTimeline(legacy: NormalizedMessage[], rows: NormalizedMessage[]): NormalizedMessage[] {
  if (!rows.length) return legacy;
  const groups = new Map<string, NormalizedMessage[]>();
  for (const row of rows) {
    const items = groups.get(turn(row)) ?? [];
    items.push(row);
    groups.set(turn(row), items);
  }
  for (const items of groups.values()) items.sort((a, b) => a.timeline!.order - b.timeline!.order);
  const output: NormalizedMessage[] = [];
  const emitted = new Set<string>();
  for (let index = 0; index < legacy.length; index++) {
    const message = legacy[index];
    const runId = turn(message);
    const group = groups.get(runId);
    // Initial user input precedes the turn's protocol. Status/terminal rows
    // cannot become insertion anchors ahead of user input.
    const initialUser = message.kind === 'text' && message.role === 'user' && !message.isSteer;
    if (group && !emitted.has(runId) && !initialUser && !legacy.slice(index + 1).some(m =>
      turn(m) === runId && m.kind === 'text' && m.role === 'user' && !m.isSteer)) {
      output.push(...group);
      emitted.add(runId);
    }
    output.push(message);
    if (group && initialUser && !emitted.has(runId)) {
      output.push(...group);
      emitted.add(runId);
    }
  }
  for (const [runId, group] of groups) if (!emitted.has(runId)) output.push(...group);
  return output;
}
