import type {
  SessionCommittedEventSubscription,
  SessionEventStore,
} from "../events/SessionEventStore.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionProjectionChange,
  SessionProjectionChangeSubscription,
  SessionProjectionCheckpoint,
  SessionProjectionDefinition,
  SessionProjectionRegistrySubscription,
  SessionProjectionSnapshot,
} from "./SessionProjection.js";
import {
  SessionProjectionRegistry,
  type AnySessionProjectionDefinition,
} from "./SessionProjectionRegistry.js";

type ProjectionCell = {
  definition: AnySessionProjectionDefinition;
  state: unknown;
  asOfSequence: number;
};

export type SessionProjectionDriverOptions = {
  runtime?: SessionEventStore;
  registry: SessionProjectionRegistry;
  entries?: readonly AgentTranscriptEntry[];
  checkpoint?: SessionProjectionCheckpoint;
  onError?: (error: unknown, projectionName: string, entry?: AgentTranscriptEntry) => void;
};

export class SessionProjectionDriver {
  private entries: readonly AgentTranscriptEntry[];
  private asOfSequence: number;
  private readonly cells = new Map<string, ProjectionCell>();
  private readonly listeners = new Map<symbol, (change: SessionProjectionChange) => void>();
  private readonly registry: SessionProjectionRegistry;
  private readonly onError?: SessionProjectionDriverOptions["onError"];
  private readonly runtimeSubscription?: SessionCommittedEventSubscription;
  private readonly registrySubscription: SessionProjectionRegistrySubscription;
  private disposed = false;

  constructor(options: SessionProjectionDriverOptions) {
    this.registry = options.registry;
    this.onError = options.onError;
    this.entries = freezeEntries(options.entries ?? []);
    this.asOfSequence = lastSequence(this.entries);

    for (const definition of this.registry.definitionsSnapshot()) {
      this.cells.set(definition.name, this.buildCell(definition, options.checkpoint?.[definition.name]));
    }
    this.registrySubscription = this.registry.subscribe((change) => {
      if (change.type === "registered") {
        try {
          this.cells.set(change.definition.name, this.buildCell(change.definition));
        } catch (error) {
          this.cells.delete(change.definition.name);
          this.onError?.(error, change.definition.name);
        }
      } else {
        this.cells.delete(change.name);
      }
    });
    this.runtimeSubscription = options.runtime?.subscribe((entry) => {
      this.drive(entry);
    });
  }

  hydrate(
    entries: readonly AgentTranscriptEntry[],
    checkpoint: SessionProjectionCheckpoint = {},
  ): void {
    this.assertActive();
    this.entries = freezeEntries(entries);
    this.asOfSequence = lastSequence(this.entries);
    this.cells.clear();
    for (const definition of this.registry.definitionsSnapshot()) {
      this.cells.set(definition.name, this.buildCell(definition, checkpoint[definition.name]));
    }
  }

  stateOf<State>(name: string): State | undefined {
    this.assertActive();
    const cell = this.cells.get(name);
    return cell ? cloneValue(cell.state as State) : undefined;
  }

  snapshot(names?: readonly string[]): SessionProjectionSnapshot {
    this.assertActive();
    const selected = names ? new Set(names) : undefined;
    const values: Record<string, unknown> = {};
    for (const [name, cell] of this.cells) {
      if (selected && !selected.has(name)) continue;
      values[name] = this.viewCell(cell);
    }
    return { asOfSequence: this.asOfSequence, values };
  }

  checkpoint(): SessionProjectionCheckpoint {
    this.assertActive();
    const checkpoint: SessionProjectionCheckpoint = {};
    for (const [name, cell] of this.cells) {
      const codec = cell.definition.checkpoint;
      if (!codec) continue;
      checkpoint[name] = {
        version: cell.definition.version,
        asOfSequence: cell.asOfSequence,
        state: cloneValue(codec.encode(cell.state)),
      };
    }
    return checkpoint;
  }

  subscribe(listener: (change: SessionProjectionChange) => void): SessionProjectionChangeSubscription {
    this.assertActive();
    const token = Symbol("session-projection-change-listener");
    this.listeners.set(token, listener);
    let active = true;
    return {
      get active() {
        return active;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(token);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runtimeSubscription?.dispose();
    this.registrySubscription.dispose();
    this.listeners.clear();
    this.cells.clear();
  }

  private drive(entry: AgentTranscriptEntry): void {
    if (this.disposed) return;
    this.entries = freezeEntries([...this.entries, entry]);
    this.asOfSequence = entry.sequence;
    const changes: SessionProjectionChange[] = [];

    for (const [name, cell] of this.cells) {
      try {
        const nextState = cell.definition.reduce(cell.state, entry, {
          entries: this.entries,
          index: this.entries.length - 1,
        });
        const changed = nextState !== undefined && !Object.is(nextState, cell.state);
        if (nextState !== undefined) cell.state = nextState;
        cell.asOfSequence = entry.sequence;
        if (changed) {
          changes.push({
            name,
            version: cell.definition.version,
            asOfSequence: entry.sequence,
            value: this.viewCell(cell),
          });
        }
      } catch (error) {
        this.onError?.(error, name, entry);
        try {
          this.cells.set(name, this.buildCell(cell.definition));
        } catch (rebuildError) {
          this.cells.delete(name);
          this.onError?.(rebuildError, name, entry);
        }
      }
    }

    for (const change of changes) {
      for (const listener of this.listeners.values()) {
        try {
          listener(change);
        } catch (error) {
          this.onError?.(error, change.name, entry);
        }
      }
    }
  }

  private buildCell(
    definition: AnySessionProjectionDefinition,
    checkpoint?: SessionProjectionCheckpoint[string],
  ): ProjectionCell {
    let state: unknown;
    let startIndex = 0;
    let asOfSequence = -1;
    if (
      checkpoint &&
      definition.checkpoint &&
      checkpoint.version === definition.version &&
      checkpoint.asOfSequence <= this.asOfSequence
    ) {
      try {
        state = definition.checkpoint.decode(cloneValue(checkpoint.state));
        startIndex = this.entries.findIndex((entry) => entry.sequence > checkpoint.asOfSequence);
        if (startIndex === -1) startIndex = this.entries.length;
        asOfSequence = checkpoint.asOfSequence;
      } catch (error) {
        this.onError?.(error, definition.name);
        state = definition.create({ entries: this.entries });
      }
    } else {
      state = definition.create({ entries: this.entries });
    }

    for (let index = startIndex; index < this.entries.length; index += 1) {
      const nextState = definition.reduce(state, this.entries[index], { entries: this.entries, index });
      if (nextState !== undefined) state = nextState;
      asOfSequence = this.entries[index].sequence;
    }
    return { definition, state, asOfSequence };
  }

  private viewCell(cell: ProjectionCell): unknown {
    const context = { entries: this.entries };
    return cloneValue(cell.definition.finalize?.(cell.state, context) ?? cell.state);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Session projection driver is disposed.");
    }
  }
}

function lastSequence(entries: readonly AgentTranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, entry.sequence), -1);
}

function freezeEntries(entries: readonly AgentTranscriptEntry[]): readonly AgentTranscriptEntry[] {
  return Object.freeze(entries.map((entry) => cloneValue(entry)));
}

function cloneValue<Value>(value: Value): Value {
  return structuredClone(value);
}
