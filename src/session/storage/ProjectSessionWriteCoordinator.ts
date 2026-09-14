/** Identity of one durable project-session event stream. */
export type ProjectSessionWriteScope = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
};

/**
 * Serializes short-lived writer runtimes for one session inside one process.
 *
 * A persistent AgentSession owns its own long-lived SessionRuntime. Consumers
 * that materialize a transient runtime to append metadata or status must first
 * restore the durable sequence, so concurrent transient writers need one
 * application-owned admission point.
 */
export class ProjectSessionWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(scope: ProjectSessionWriteScope, operation: () => Promise<T> | T): Promise<T> {
    const key = JSON.stringify([scope.projectRoot, scope.pilotHome, scope.sessionId]);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, tail);

    return previous
      .then(operation)
      .finally(() => {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
  }
}
