import type { WorkflowEvent, WorkflowEventStore } from "../protocol/types.js";

export class InMemoryWorkflowEventStore implements WorkflowEventStore {
  private readonly events = new Map<string, WorkflowEvent[]>();

  async create(event: Omit<WorkflowEvent, "sequence"> & { readonly type: "run_created"; readonly definition: NonNullable<WorkflowEvent["definition"]> }): Promise<WorkflowEvent> {
    if (this.events.has(event.runId)) {
      throw new Error(`Workflow run ${event.runId} already exists.`);
    }
    const committed: WorkflowEvent = { ...structuredClone(event), sequence: 1 };
    this.events.set(event.runId, [committed]);
    return structuredClone(committed);
  }

  async append(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent> {
    const existing = this.events.get(event.runId);
    if (!existing?.length) {
      throw new Error(`Workflow run ${event.runId} has no durable creation event.`);
    }
    if (existing[0].ownerId !== event.ownerId) {
      throw new Error(`Workflow run ${event.runId} belongs to a different owner.`);
    }
    const committed: WorkflowEvent = { ...structuredClone(event), sequence: existing.at(-1)!.sequence + 1 };
    existing.push(committed);
    return structuredClone(committed);
  }

  async read(runId: string): Promise<readonly WorkflowEvent[]> {
    return structuredClone(this.events.get(runId) ?? []);
  }
}
