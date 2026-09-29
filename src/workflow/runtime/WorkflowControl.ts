import type { WorkflowControlConsumer, WorkflowRunHandle, WorkflowSnapshot } from "../protocol/types.js";

/**
 * Thin caller-facing control projection. It deliberately does not discover
 * runs or own persistence; the caller retains the run handle and EventStore.
 */
export class WorkflowControl implements WorkflowControlConsumer {
  constructor(private readonly run: WorkflowRunHandle) {}

  start(): Promise<void> {
    return this.run.start();
  }

  status(): WorkflowSnapshot {
    return this.run.getSnapshot();
  }

  pause(): Promise<void> {
    return this.run.pause();
  }

  resume(): Promise<void> {
    return this.run.resume();
  }

  cancel(): Promise<void> {
    return this.run.cancel();
  }

  dispose(): Promise<void> {
    return this.run.dispose();
  }
}
