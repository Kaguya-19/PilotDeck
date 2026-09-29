import { JsonlSessionPersistence } from "../persistence/JsonlSessionPersistence.js";
import { attachSessionPersistence } from "../persistence/SessionPersistenceBinding.js";
import { SessionRuntime } from "./SessionRuntime.js";
import type { SessionRuntimeOptions } from "./SessionEventStore.js";

export type JsonlSessionEventStoreOptions = SessionRuntimeOptions & {
  path: string;
};

export class JsonlSessionEventStore extends SessionRuntime {
  private readonly provider: JsonlSessionPersistence;

  constructor(options: JsonlSessionEventStoreOptions) {
    super({
      now: options.now,
      uuid: options.uuid,
      onSubscriberError: options.onSubscriberError,
    });
    this.provider = new JsonlSessionPersistence({ path: options.path });
    attachSessionPersistence(this, this.provider);
  }

  override async read() {
    await this.flush();
    return this.provider.load();
  }
}
