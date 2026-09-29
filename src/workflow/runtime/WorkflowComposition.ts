import type {
  WorkflowControlConsumer,
  WorkflowDefinition,
  WorkflowEventStore,
  WorkflowExecutionAdapter,
  WorkflowRunHandle,
} from "../protocol/types.js";
import { WorkflowControl } from "./WorkflowControl.js";
import { WorkflowRun, type WorkflowRunOptions } from "./WorkflowRun.js";

export type WorkflowCompositionOptions = Omit<WorkflowRunOptions, "definition"> & {
  definition: WorkflowDefinition;
};

export type ComposedWorkflow = {
  run: WorkflowRunHandle;
  control: WorkflowControlConsumer;
};

/** Compose exactly one caller-owned run; no registry or ambient state is added. */
export async function composeWorkflow(options: WorkflowCompositionOptions): Promise<ComposedWorkflow> {
  const run = await WorkflowRun.create(options);
  const handle: WorkflowRunHandle = {
    getSnapshot: () => run.getSnapshot(),
    start: () => run.start(),
    pause: () => run.pause(),
    resume: () => run.start(),
    cancel: () => run.cancel(),
    dispose: () => run.dispose(),
  };
  return { run: handle, control: new WorkflowControl(handle) };
}

export type { WorkflowEventStore, WorkflowExecutionAdapter };
