import type {
  SessionCommittedEventSubscription,
  SessionEventStore,
} from "../events/SessionEventStore.js";
import type { SessionPersistence } from "./SessionPersistence.js";

export function attachSessionPersistence(
  runtime: SessionEventStore,
  persistence: SessionPersistence,
): SessionCommittedEventSubscription {
  return runtime.subscribe(
    (entry) => persistence.append(entry),
    {
      failureMode: "propagate",
      flush: () => persistence.flush(),
    },
  );
}
