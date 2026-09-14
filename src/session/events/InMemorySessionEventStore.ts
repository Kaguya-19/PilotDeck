import { InMemorySessionPersistence } from "../persistence/InMemorySessionPersistence.js";
import { attachSessionPersistence } from "../persistence/SessionPersistenceBinding.js";
import { SessionRuntime } from "./SessionRuntime.js";
import type { SessionRuntimeOptions } from "./SessionEventStore.js";

export class InMemorySessionEventStore extends SessionRuntime {
  private readonly provider: InMemorySessionPersistence;

  constructor(options: SessionRuntimeOptions = {}) {
    const provider = new InMemorySessionPersistence();
    super(options);
    this.provider = provider;
    attachSessionPersistence(this, provider);
  }

  get entries() {
    return this.provider.entries;
  }

  override async read() {
    await this.flush();
    return this.provider.load();
  }
}
