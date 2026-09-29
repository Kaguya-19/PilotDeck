import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionProjectionDefinition,
  SessionProjectionDescriptor,
  SessionProjectionRegistration,
  SessionProjectionRegistryChange,
  SessionProjectionRegistrySubscription,
} from "./SessionProjection.js";

export type AnySessionProjectionDefinition = SessionProjectionDefinition<unknown, unknown>;

export class SessionProjectionRegistry {
  private readonly definitions = new Map<string, AnySessionProjectionDefinition>();
  private readonly listeners = new Map<symbol, (change: SessionProjectionRegistryChange) => void>();

  register<State, Result>(
    definition: SessionProjectionDefinition<State, Result>,
  ): SessionProjectionRegistration {
    validateDefinition(definition);
    if (this.definitions.has(definition.name)) {
      throw new Error(`Session projection already registered: ${definition.name}`);
    }

    this.definitions.set(definition.name, definition as AnySessionProjectionDefinition);
    this.emit({ type: "registered", definition: definition as AnySessionProjectionDefinition });
    let active = true;

    return {
      name: definition.name,
      version: definition.version,
      get active() {
        return active;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.definitions.get(definition.name) === definition) {
          this.definitions.delete(definition.name);
          this.emit({ type: "removed", name: definition.name, version: definition.version });
        }
      },
    };
  }

  list(): SessionProjectionDescriptor[] {
    return [...this.definitions.values()].map(({ name, version }) => ({ name, version }));
  }

  definitionsSnapshot(): AnySessionProjectionDefinition[] {
    return [...this.definitions.values()];
  }

  resolve<State, Result>(name: string): SessionProjectionDefinition<State, Result> | undefined {
    return this.definitions.get(name) as SessionProjectionDefinition<State, Result> | undefined;
  }

  subscribe(
    listener: (change: SessionProjectionRegistryChange) => void,
  ): SessionProjectionRegistrySubscription {
    const token = Symbol("session-projection-registry-listener");
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

  project<Result>(name: string, entries: readonly AgentTranscriptEntry[]): Result {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Session projection is not registered: ${name}`);
    }

    const replayContext = { entries };
    let state = definition.create(replayContext);
    for (let index = 0; index < entries.length; index += 1) {
      const nextState = definition.reduce(state, entries[index], { entries, index });
      if (nextState !== undefined) state = nextState;
    }

    return (definition.finalize?.(state, replayContext) ?? state) as Result;
  }


  private emit(change: SessionProjectionRegistryChange): void {
    for (const listener of this.listeners.values()) {
      listener(change);
    }
  }
}

function validateDefinition<State, Result>(definition: SessionProjectionDefinition<State, Result>): void {
  if (definition.name.trim().length === 0) {
    throw new Error("Session projection name must not be empty.");
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(`Session projection version must be a positive integer: ${definition.name}`);
  }
}
